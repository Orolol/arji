import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import simpleGit, { CheckRepoActions, type SimpleGit, type SimpleGitOptions } from "simple-git";
import { createId } from "@/lib/utils/nanoid";
import {
  getCurrentGitBranch,
  parseGitHubOwnerRepoFromRemoteUrl,
  parseGitHubRepoInput,
  type ParsedGitHubRepoInput,
} from "./remote";
import { redactGitCredentials, redactedErrorMessage } from "./redact";
import { withPathLock } from "./clone-lock";
import {
  hasCloneMarkerFor,
  isArijManagedClone,
  writeCloneMarker,
} from "./clone-marker";
import { DEFAULT_CLONE_TIMEOUT_MS } from "./clone-constants";

/**
 * Cloning a GitHub repository into the app-managed workspace.
 *
 * Three properties matter more than anything else here:
 *
 *  1. **The token never touches the disk.** It is passed as a one-shot
 *     `-c http.extraHeader=...` on the command line, so `origin` keeps the
 *     clean URL and `.git/config` never learns the secret. Every error string
 *     leaving this module is redacted (git echoes the failing command).
 *
 *  2. **The destination is never destroyed.** The download runs into a
 *     temporary sibling directory and is moved into place with a single
 *     `rename` once it is complete and stamped. A destination that already
 *     holds something Arij cannot positively identify as its own is a conflict,
 *     reported to the user — never cleaned up on their behalf. The only
 *     directory this module ever deletes is one it created itself.
 *
 *     That also makes an interrupted clone a non-event: the debris is in the
 *     temp directory, so the destination is either absent (clone again) or a
 *     complete clone (reuse it). There is no half-clone state to recover from.
 *
 *  3. **Re-running an import is cheap.** A destination that already holds a
 *     healthy clone of the same repository is *reused* (fetch only), which is
 *     what makes recovery from an interrupted import instant.
 */

/** Prefix of the staging directories this module creates inside the root. */
const TEMP_CLONE_PREFIX = ".arij-clone-tmp-";

/** How an existing destination directory was classified before we acted on it. */
export type CloneDestinationState =
  | "absent"
  | "empty"
  | "healthy_match"
  | "remote_mismatch"
  /** A broken clone carrying Arij's marker — provably ours, safe to replace. */
  | "arij_debris"
  /** Anything Arij cannot prove it created. Always a conflict, never deleted. */
  | "foreign_content";

export interface CloneRepoResult {
  /** Absolute path of the clone. */
  path: string;
  owner: string;
  repo: string;
  ownerRepo: string;
  /** Clean, credential-free URL recorded as `origin`. */
  remoteUrl: string;
  defaultBranch: string;
  /** True when an existing clone was fetched instead of re-downloaded. */
  reused: boolean;
  /**
   * True when the directory carries Arij's marker, i.e. Arij created it and may
   * later delete it. False for a pre-existing clone Arij merely reused — those
   * belong to the user.
   */
  managed: boolean;
  /** What we found on disk before acting — surfaced for logs and tests. */
  destinationState: CloneDestinationState;
  durationMs: number;
}

export class CloneConflictError extends Error {
  readonly code = "clone_destination_conflict";
  readonly destination: string;
  readonly existingRemote: string | null;
  readonly state: CloneDestinationState;

  constructor(
    destination: string,
    existingRemote: string | null,
    state: CloneDestinationState = "foreign_content"
  ) {
    super(
      existingRemote
        ? `${destination} already contains a clone of ${existingRemote}. Arij will not modify it — remove it or change the projects root.`
        : `${destination} already exists and was not created by Arij. Arij will not modify it — remove it or change the projects root.`
    );
    this.name = "CloneConflictError";
    this.destination = destination;
    this.existingRemote = existingRemote;
    this.state = state;
  }
}

export class CloneFailedError extends Error {
  readonly code = "clone_failed";

  constructor(message: string) {
    super(redactGitCredentials(message));
    this.name = "CloneFailedError";
  }
}

/**
 * `Authorization: Basic base64("x-access-token:<pat>")` — GitHub's documented
 * way of authenticating HTTPS git traffic with a PAT.
 */
export function buildAuthHeaderConfig(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token.trim()}`).toString(
    "base64"
  );
  return `http.extraHeader=Authorization: Basic ${encoded}`;
}

/** Prefixes git args with the credential config when a token is available. */
function withAuth(token: string | null | undefined, args: string[]): string[] {
  const clean = token?.trim();
  if (!clean) return args;
  return ["-c", buildAuthHeaderConfig(clean), ...args];
}

async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function readOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const remotes = await simpleGit(repoPath).getRemotes(true);
    const origin =
      remotes.find((remote) => remote.name === "origin") ?? remotes[0];
    const url = origin?.refs?.fetch || origin?.refs?.push || "";
    return url.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A clone is healthy when git recognises it *and* it has a commit checked out.
 * A directory whose `.git` exists but whose HEAD is unborn is the signature of
 * a clone that died mid-transfer.
 *
 * Invariant: rev-parse invocations here use only static constant arguments,
 * leaving no vector for option injection.
 */
async function hasCheckedOutHead(repoPath: string): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    await git.raw(["rev-parse", "--git-dir"]);
    await git.raw(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classifies what is sitting at the destination.
 *
 * The default answer for anything occupied is `foreign_content`: a conflict the
 * user is told about. Only two states let the clone proceed over existing
 * content — `healthy_match`, which is reused without modification, and
 * `arij_debris`, a broken clone that still carries Arij's own marker and is
 * therefore provably not the user's work.
 */
export async function classifyCloneDestination(
  destination: string,
  expected: { owner: string; repo: string }
): Promise<{ state: CloneDestinationState; existingRemote: string | null }> {
  if (!fs.existsSync(destination)) {
    return { state: "absent", existingRemote: null };
  }

  if (!fs.statSync(destination).isDirectory()) {
    return { state: "foreign_content", existingRemote: null };
  }

  if (await isEmptyDirectory(destination)) {
    return { state: "empty", existingRemote: null };
  }

  const originUrl = await readOriginUrl(destination);
  const parsed = originUrl ? parseGitHubOwnerRepoFromRemoteUrl(originUrl) : null;
  const remoteMatches =
    parsed !== null &&
    parsed.owner.toLowerCase() === expected.owner.toLowerCase() &&
    parsed.repo.toLowerCase() === expected.repo.toLowerCase();

  // A complete clone of the repository we were asked for: reuse it. This is
  // non-destructive, so it does not require the marker — a checkout the user
  // made by hand is just as reusable, it simply stays theirs.
  if (remoteMatches && (await hasCheckedOutHead(destination))) {
    return { state: "healthy_match", existingRemote: parsed.ownerRepo };
  }

  // Everything below is only reachable by replacing what is there, so it takes
  // proof of ownership rather than a heuristic.
  if (hasCloneMarkerFor(destination, expected)) {
    return {
      state: "arij_debris",
      existingRemote: parsed?.ownerRepo ?? null,
    };
  }

  if (originUrl && !remoteMatches) {
    return {
      state: "remote_mismatch",
      existingRemote: parsed?.ownerRepo ?? redactGitCredentials(originUrl),
    };
  }

  return { state: "foreign_content", existingRemote: parsed?.ownerRepo ?? null };
}

/**
 * Branch the clone checked out. Falls back to `origin/HEAD` and finally to
 * `main`, so the caller always gets a usable name.
 */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  // simple-git throws *synchronously* from its factory when the directory does
  // not exist, so the instance is built inside the guard like every call below.
  // Invariant: readRef is an internal helper called exclusively with hardcoded,
  // static argument vectors. No caller-supplied values reach argv option position.
  const readRef = async (args: string[]): Promise<string | null> => {
    try {
      return (await simpleGit(repoPath).raw(args)).trim();
    } catch {
      return null;
    }
  };

  const current = await readRef(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current && current !== "HEAD") return current;

  const symbolic = await readRef([
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic?.startsWith("origin/")) return symbolic.slice("origin/".length);

  return "main";
}

/**
 * Clones a repository into a destination directory.
 *
 * Invariant: The `--` separator ensures cloneUrl and destination paths cannot
 * be interpreted as git option flags even if they begin with a leading dash.
 */
async function runClone(
  cloneUrl: string,
  destination: string,
  token: string | null | undefined
): Promise<void> {
  const parent = path.dirname(destination);
  await fsp.mkdir(parent, { recursive: true });

  // simple-git needs an existing baseDir; the parent is guaranteed above.
  const git: SimpleGit = simpleGit(parent);

  // Full clone on purpose: worktrees, merge-base and tagging all need the real
  // history, so no `--depth` and no `--single-branch`.
  await git.raw(withAuth(token, ["clone", "--", cloneUrl, destination]));
}

/**
 * Fetches from the origin remote with pruning.
 *
 * Invariant: Uses static remote and flag arguments wrapped with optional auth config.
 */
async function runFetch(
  repoPath: string,
  token: string | null | undefined
): Promise<void> {
  await simpleGit(repoPath).raw(withAuth(token, ["fetch", "origin", "--prune"]));
}

/** Best-effort removal of a directory this module created. */
async function discard(directory: string): Promise<void> {
  try {
    await fsp.rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      "[clone] failed to remove directory",
      directory,
      redactedErrorMessage(error)
    );
  }
}

/** Staging directory for one download, a sibling of the destination. */
function tempCloneDir(destination: string): string {
  const resolved = path.resolve(destination);
  return path.join(
    path.dirname(resolved),
    `${TEMP_CLONE_PREFIX}${path.basename(resolved)}-${randomUUID().slice(0, 8)}`
  );
}

/**
 * Removes staging directories abandoned by an earlier attempt at this
 * destination.
 *
 * Safe by construction, and only because of the two facts that bracket it: the
 * name is one only this module generates, and the caller holds the destination
 * lock — so no live attempt at this destination can own one.
 */
async function sweepStaleTempDirs(destination: string): Promise<void> {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  const prefix = `${TEMP_CLONE_PREFIX}${path.basename(resolved)}-`;

  let entries: string[];
  try {
    entries = await fsp.readdir(parent);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      await discard(path.join(parent, entry));
    }
  }
}

/**
 * Moves a finished clone onto the destination.
 *
 * `rename` is atomic, so the destination goes from "absent" to "a complete,
 * stamped clone" with no observable state in between — which is what removes
 * the half-clone recovery problem entirely.
 */
async function swapIntoPlace(
  temp: string,
  destination: string,
  state: CloneDestinationState
): Promise<void> {
  if (state === "arij_debris") {
    // Proven ours by the marker; the only replace path that exists.
    await fsp.rm(destination, { recursive: true, force: true });
  } else if (state === "empty") {
    // rename(2) replaces an empty directory on Linux, but not on every
    // platform; removing it first keeps the behaviour identical everywhere.
    await fsp.rmdir(destination).catch(() => {});
  }

  await fsp.rename(temp, destination);
}

export interface CloneGitHubRepositoryOptions {
  /** Anything the user pasted: URL, SSH remote, or `owner/repo`. */
  input: string;
  /** Absolute destination, already resolved inside the projects root. */
  destination: string;
  /** GitHub PAT from settings; omit for public repositories. */
  token?: string | null;
}

/**
 * Clones (or reuses) a GitHub repository at `destination`.
 *
 * Throws {@link CloneConflictError} when the destination holds anything other
 * than a healthy clone of the requested repository, and {@link CloneFailedError}
 * for every git failure. Concurrent calls for the same destination are
 * serialised, so the second one observes the first one's result rather than
 * racing it.
 */
export async function cloneGitHubRepository({
  input,
  destination,
  token,
}: CloneGitHubRepositoryOptions): Promise<CloneRepoResult> {
  const parsed: ParsedGitHubRepoInput | null = parseGitHubRepoInput(input);
  if (!parsed) {
    throw new CloneFailedError(
      `"${input}" is not a GitHub repository. Use https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo.`
    );
  }

  return withPathLock(destination, () =>
    performClone(parsed, destination, token)
  );
}

async function performClone(
  parsed: ParsedGitHubRepoInput,
  destination: string,
  token: string | null | undefined
): Promise<CloneRepoResult> {
  const startedAt = Date.now();
  const { state, existingRemote } = await classifyCloneDestination(
    destination,
    parsed
  );

  if (state === "remote_mismatch" || state === "foreign_content") {
    throw new CloneConflictError(destination, existingRemote, state);
  }

  // Reuse: the expensive download already happened. This is the path an
  // interrupted import takes on retry — a fetch, then straight to analysis.
  if (state === "healthy_match") {
    try {
      await runFetch(destination, token);
    } catch (error) {
      // A failing fetch must not sink a usable clone (offline, expired token):
      // the working tree is still valid and analysis can proceed.
      console.warn(
        "[clone] reuse fetch failed, continuing with existing clone:",
        redactedErrorMessage(error)
      );
    }

    return {
      path: destination,
      owner: parsed.owner,
      repo: parsed.repo,
      ownerRepo: parsed.ownerRepo,
      remoteUrl: parsed.cloneUrl,
      defaultBranch: await detectDefaultBranch(destination),
      reused: true,
      // A clone Arij did not create stays the user's, however convenient the
      // path is. Only the marker grants deletion rights.
      managed: isArijManagedClone(destination),
      destinationState: state,
      durationMs: Date.now() - startedAt,
    };
  }

  await sweepStaleTempDirs(destination);
  const temp = tempCloneDir(destination);

  let managed: boolean;
  try {
    await runClone(parsed.cloneUrl, temp, token);
    // Stamped before the swap, so the destination is never observable as an
    // unmarked Arij clone.
    managed = await writeCloneMarker(temp, {
      owner: parsed.owner,
      repo: parsed.repo,
      ownerRepo: parsed.ownerRepo,
      remoteUrl: parsed.cloneUrl,
    });
    await swapIntoPlace(temp, destination, state);
  } catch (error) {
    await discard(temp);
    throw new CloneFailedError(
      redactedErrorMessage(error, `Failed to clone ${parsed.ownerRepo}.`)
    );
  }

  return {
    path: destination,
    owner: parsed.owner,
    repo: parsed.repo,
    ownerRepo: parsed.ownerRepo,
    remoteUrl: parsed.cloneUrl,
    defaultBranch: await detectDefaultBranch(destination),
    reused: false,
    managed,
    destinationState: state,
    durationMs: Date.now() - startedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Parallel clone service (service-de-clone-git epic). Kept alongside  */
/* the lifecycle service above: the /api/projects/clone route dispatch */
/* the lifecycle one; this service is pinned by                       */
/* __tests__/git-clone-{service,command,redaction}.test.ts.           */
/* ------------------------------------------------------------------ */


/**
 * Git clone service.
 *
 * Clones a repository into an app-managed directory, authenticating with the
 * PAT stored in settings only when the anonymous attempt proves it necessary.
 * Four invariants drive the implementation:
 *
 *  1. **Full clones only.** No `--depth`, no `--single-branch`: Arij creates
 *     worktrees off `main`, merges epic branches and tags releases, all of
 *     which need complete history.
 *  2. **The token is a last resort, and never touches disk.** Public
 *     repositories are cloned anonymously; the PAT is only replayed when the
 *     anonymous attempt fails for a credential reason. It is then passed as an
 *     `http.extraHeader` via `-c`, so it stays out of `.git/config` and
 *     `origin` keeps the clean URL — `fetch`/`pull`/`push` afterwards behave
 *     like a hand-made clone.
 *  3. **Nothing existing is ever destroyed.** A destination whose `origin`
 *     already points at the requested repository is reused (fetch only);
 *     anything else is a conflict. The clone is assembled in a private staging
 *     directory and moved into place at the end, so cleanup can only ever
 *     delete a directory this service created.
 *  4. **Every remote call is bounded.** Clone and reuse-fetch alike run under
 *     one deadline and with credential prompts disabled, so a stalled
 *     connection fails with a message instead of hanging the request.
 */

export type CloneErrorCode =
  | "invalid_input"
  | "workspace_unavailable"
  | "conflict"
  | "not_found"
  | "auth_failed"
  | "network"
  | "branch_not_found"
  | "timeout"
  | "clone_failed";

export class CloneError extends Error {
  readonly code: CloneErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: CloneErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CloneError";
    this.code = code;
    this.details = details;
  }
}

export interface CloneRepositoryOptions {
  /** Clean HTTPS (or, in tests, `file://`) URL. Never carries credentials. */
  cloneUrl: string;
  /** Absolute destination directory — `<projects_root>/<owner>-<repo>`. */
  dest: string;
  /** Optional branch to check out instead of the remote's default. */
  branch?: string | null;
  /** GitHub PAT, replayed as an Authorization header for a single command. */
  token?: string | null;
  /**
   * `owner/repo` an existing destination's `origin` must already point at to
   * be reused. When omitted, reuse compares `origin` with `cloneUrl`.
   */
  expectedOwnerRepo?: string | null;
  /** Wall-clock budget for the whole operation; git is aborted past it. */
  timeoutMs?: number;
}

export interface CloneRepositoryResult {
  /** Absolute path of the clone — becomes `projects.git_repo_path`. */
  path: string;
  /** Branch checked out in the clone. */
  defaultBranch: string;
  /** True when an existing clone of the same repo was fetched instead. */
  reused: boolean;
  durationMs: number;
}

const REDACTED = "[REDACTED]";

/** The only remote a reused clone is validated against, and fetched from. */
const ORIGIN = "origin";

/**
 * Prefix of the staging directory a fresh clone is assembled in. Hidden, and a
 * sibling of the destination so the final move is a same-filesystem rename.
 *
 * Every code path removes its own staging directory; only a hard kill mid-clone
 * can leave one behind. Those are deliberately NOT swept on the next clone —
 * another process may be cloning into one right now, and no local check can
 * tell the two apart. They sit inert under the (gitignored) clone root.
 */
const STAGING_PREFIX = ".arij-clone-";

/**
 * Strips credentials from a git error before it reaches the UI, a log line or
 * `git_sync_log`. Covers the header this service injects (`Basic <base64>`),
 * URL userinfo (`https://user:pass@host`), and raw GitHub token shapes, plus
 * any exact secret the caller passes in.
 */
export function redactGitError(value: unknown, secrets: string[] = []): string {
  let text =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value == null
          ? ""
          : String(value);

  for (const secret of secrets) {
    const clean = secret?.trim();
    if (!clean) continue;
    text = text.split(clean).join(REDACTED);
  }

  return text
    // `-c http.extraHeader=Authorization: Basic ...` — everything after the
    // key is ours and secret, so drop the rest of the line wholesale.
    .replace(/(http\.extraheader=)[^\n]*/gi, `$1${REDACTED}`)
    .replace(/(\bbasic\s+)[A-Za-z0-9+/=_-]+/gi, `$1${REDACTED}`)
    .replace(/(\bbearer\s+)[A-Za-z0-9._-]+/gi, `$1${REDACTED}`)
    // `https://user:token@github.com/...`
    .replace(/:\/\/[^/\s@]+@/g, `://${REDACTED}@`)
    // Raw PAT shapes, in case git echoes one we never injected.
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, REDACTED);
}

/* ------------------------------------------------------------------ */
/* Destination serialization                                           */
/* ------------------------------------------------------------------ */

/**
 * One clone at a time per destination. Two concurrent imports of the same
 * repository would otherwise race: both stage a clone, and the loser's rename
 * would land on the winner's work tree. The second caller waits and then takes
 * the reuse path.
 */
const destinationLocks = new Map<string, Promise<void>>();

async function withDestinationLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = destinationLocks.get(key) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  destinationLocks.set(key, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (destinationLocks.get(key) === chained) {
      destinationLocks.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Deadline                                                            */
/* ------------------------------------------------------------------ */

interface Deadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  expired(): boolean;
  dispose(): void;
}

function startDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    timeoutMs,
    expired: () => controller.signal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

function timeoutError(deadline: Deadline): CloneError {
  return new CloneError(
    "timeout",
    `Clone aborted after ${Math.round(deadline.timeoutMs / 1000)}s. The repository may be very large or the connection stalled — raise the clone timeout in Settings or retry.`,
    { timeoutMs: deadline.timeoutMs }
  );
}

/* ------------------------------------------------------------------ */
/* Clone                                                               */
/* ------------------------------------------------------------------ */

export async function cloneRepository(
  options: CloneRepositoryOptions
): Promise<CloneRepositoryResult> {
  const cloneUrl = options.cloneUrl?.trim() ?? "";
  const branch = options.branch?.trim() || null;

  if (!cloneUrl) {
    throw new CloneError("invalid_input", "A clone URL is required.");
  }
  if (!options.dest?.trim()) {
    throw new CloneError("invalid_input", "A destination path is required.");
  }
  // A leading dash would be read by git as an option, not a value.
  if (cloneUrl.startsWith("-")) {
    throw new CloneError("invalid_input", "Clone URL is not a valid remote.");
  }
  if (branch?.startsWith("-")) {
    throw new CloneError("invalid_input", `Invalid branch name: ${branch}`);
  }

  const dest = path.resolve(options.dest);

  return withDestinationLock(dest, () =>
    runCloneCommand({ ...options, cloneUrl, branch, dest })
  );
}

type ResolvedCloneOptions = CloneRepositoryOptions & {
  dest: string;
  branch: string | null;
};

async function runCloneCommand(
  options: ResolvedCloneOptions
): Promise<CloneRepositoryResult> {
  const startedAt = Date.now();
  const deadline = startDeadline(
    options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS
  );

  try {
    return fs.existsSync(options.dest)
      ? await reuseExistingClone(options, startedAt, deadline)
      : await cloneIntoDestination(options, startedAt, deadline);
  } finally {
    deadline.dispose();
  }
}

async function cloneIntoDestination(
  options: ResolvedCloneOptions,
  startedAt: number,
  deadline: Deadline
): Promise<CloneRepositoryResult> {
  const { cloneUrl, dest, branch, token } = options;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });

  // Clone into a staging directory and move it into place at the very end. The
  // destination is therefore created by a single rename: a failure leaves no
  // half-written tree to be "reused" later, and the cleanup below can only
  // ever delete a directory this call created — never one that another process
  // dropped at `dest` while git was running.
  const staging = path.join(parent, `${STAGING_PREFIX}${createId()}`);

  try {
    await runGitWithOptionalAuth({
      baseDir: parent,
      deadline,
      token,
      context: { cloneUrl, branch },
      buildArgs: (auth) => [
        ...auth,
        "clone",
        ...(branch ? ["--branch", branch] : []),
        // Deliberately no --depth / --single-branch: worktrees, merge-base and
        // release tagging all need the full history.
        "--",
        cloneUrl,
        staging,
      ],
      // The failed attempt left a partial tree in the way of the retry.
      beforeRetry: () => discardStaging(staging),
    });

    claimDestination(staging, dest);

    return {
      path: dest,
      defaultBranch: await getCurrentGitBranch(dest),
      reused: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    discardStaging(staging);
    throw error instanceof CloneError
      ? error
      : toCloneError(error, { cloneUrl, branch, token });
  }
}

/**
 * Moves a finished staging clone onto the destination. The destination is only
 * ever taken by `rename`, which refuses to clobber a non-empty directory, so a
 * directory that appeared while git was running is reported as a conflict
 * rather than overwritten.
 */
function claimDestination(staging: string, dest: string): void {
  if (fs.existsSync(dest)) {
    throw new CloneError(
      "conflict",
      `${dest} appeared while the clone was running and was left untouched. Move or remove it, then retry.`,
      { path: dest }
    );
  }

  try {
    fs.renameSync(staging, dest);
  } catch (error) {
    if (fs.existsSync(dest)) {
      throw new CloneError(
        "conflict",
        `${dest} appeared while the clone was running and was left untouched. Move or remove it, then retry.`,
        { path: dest }
      );
    }
    throw new CloneError(
      "clone_failed",
      `Could not move the finished clone into ${dest}: ${redactGitError(error)}`,
      { path: dest }
    );
  }
}

/**
 * A destination that already exists is never overwritten: either its `origin`
 * points at the requested repository (fetch and reuse) or the caller gets a
 * conflict naming what is in the way.
 */
async function reuseExistingClone(
  options: ResolvedCloneOptions,
  startedAt: number,
  deadline: Deadline
): Promise<CloneRepositoryResult> {
  const { dest, cloneUrl, branch, expectedOwnerRepo, token } = options;

  if (!fs.statSync(dest).isDirectory()) {
    throw new CloneError(
      "conflict",
      `${dest} already exists and is not a directory.`,
      { path: dest }
    );
  }

  if (!(await isRepositoryRoot(dest))) {
    throw new CloneError(
      "conflict",
      `${dest} already exists and is not a git repository. Move or remove it, then retry.`,
      { path: dest }
    );
  }

  // Only `origin` counts: it is the remote the reuse path goes on to fetch, so
  // validating any other remote would approve a clone that then updates from
  // somewhere else entirely.
  const originUrl = await readRemoteUrl(dest, ORIGIN);
  if (!originUrl) {
    throw new CloneError(
      "conflict",
      `${dest} already exists and has no '${ORIGIN}' remote. Move or remove it, then retry.`,
      { path: dest, remoteUrl: null }
    );
  }

  const originOwnerRepo =
    parseGitHubOwnerRepoFromRemoteUrl(originUrl)?.ownerRepo ?? null;
  // Identity is owner/repo when both sides are GitHub — an `ssh://` clone made
  // by hand and an `https://` import URL are the same repository.
  const matches =
    sameRemote(originUrl, cloneUrl) ||
    (!!expectedOwnerRepo &&
      !!originOwnerRepo &&
      originOwnerRepo.toLowerCase() === expectedOwnerRepo.toLowerCase());

  if (!matches) {
    throw new CloneError(
      "conflict",
      `${dest} already holds a different repository (${ORIGIN}: ${originUrl}). Move or remove it, then retry.`,
      { path: dest, remoteUrl: originUrl }
    );
  }

  // Fetched through the same credential path as the clone: a private clone
  // Arij made carries no stored credentials of its own, and an unbounded fetch
  // would sit here waiting for some until the request itself died.
  await runGitWithOptionalAuth({
    baseDir: dest,
    deadline,
    token,
    context: { cloneUrl, branch },
    buildArgs: (auth) => [...auth, "fetch", ORIGIN],
  });

  // The existing checkout belongs to the user; a requested branch does not
  // justify switching it out from under them. Report what is actually there.
  return {
    path: dest,
    defaultBranch: await getCurrentGitBranch(dest),
    reused: true,
    durationMs: Date.now() - startedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Git plumbing                                                        */
/* ------------------------------------------------------------------ */

interface AuthenticatedRunOptions {
  baseDir: string;
  deadline: Deadline;
  token?: string | null;
  /** Builds the argv from the `-c` prefix to place before the subcommand. */
  buildArgs: (authArgs: string[]) => string[];
  /** Cleanup between the anonymous attempt and the authenticated retry. */
  beforeRetry?: () => void;
  context: { cloneUrl: string; branch?: string | null };
}

/**
 * Runs a git command anonymously, and replays it with the PAT only if the
 * anonymous attempt failed for a credential reason.
 *
 * Anonymous-first is what keeps a public clone free of the token: sending it
 * unconditionally would both contradict that guarantee and let an expired PAT
 * break a clone that needs no credentials at all.
 */
async function runGitWithOptionalAuth(
  options: AuthenticatedRunOptions
): Promise<void> {
  const { baseDir, deadline, token, buildArgs, beforeRetry, context } = options;

  try {
    await runGit(buildArgs([]), baseDir, deadline);
    return;
  } catch (error) {
    if (deadline.expired()) throw timeoutError(deadline);

    // Classified as if no credentials existed — because none were sent.
    const anonymous = toCloneError(error, { ...context, token: null });
    if (!token?.trim() || !isCredentialRecoverable(anonymous.code)) {
      throw anonymous;
    }
    beforeRetry?.();
  }

  try {
    await runGit(buildArgs(authConfigArgs(token)), baseDir, deadline);
  } catch (error) {
    if (deadline.expired()) throw timeoutError(deadline);
    throw toCloneError(error, { ...context, token });
  }
}

/** Failures a stored PAT could plausibly fix. */
function isCredentialRecoverable(code: CloneErrorCode): boolean {
  return code === "not_found" || code === "auth_failed";
}

/**
 * Executes raw git command arguments with non-interactive environment safeguards
 * and abort signal handling.
 *
 * Invariant: All callers must validate user/agent-derived values (rejecting leading
 * dashes) and/or use `--` separators before positional arguments so that untrusted
 * strings cannot land in argv option position.
 */
function runGit(
  args: string[],
  baseDir: string,
  deadline: Deadline
): Promise<string> {
  return simpleGit({
    baseDir,
    abort: deadline.signal,
    unsafe: { allowUnsafeAskPass: true } as unknown as Partial<SimpleGitOptions["unsafe"]>,
  })
    .env(nonInteractiveEnv())
    .raw(args);
}

/**
 * `-c` scopes the header to this one invocation: it never reaches
 * `.git/config`, so `origin` stays clean and the clone carries no secret.
 */
function authConfigArgs(token?: string | null): string[] {
  const clean = token?.trim();
  if (!clean) return [];

  const basic = Buffer.from(`x-access-token:${clean}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * Git must never block on a credential prompt: without a terminal it would
 * hang until the timeout instead of failing with a usable message.
 */
export function nonInteractiveEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
  };
  // Remove ambient editor/pager/ssh/config environment variables that
  // simple-git's safety plugin rejects when passed explicitly via .env().
  // GIT_ASKPASS and SSH_ASKPASS are retained as empty strings above (with
  // allowUnsafeAskPass enabled on simpleGit) so git prompts are short-circuited.
  delete env.GIT_EDITOR;
  delete env.GIT_SEQUENCE_EDITOR;
  delete env.GIT_PAGER;
  delete env.GIT_SSH;
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_CONFIG;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_EXEC_PATH;
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_PROXY_COMMAND;
  delete env.GIT_TEMPLATE_DIR;
  delete env.EDITOR;
  delete env.PAGER;
  delete env.PREFIX;
  return env;
}

function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

/**
 * True only when `dest` is the ROOT of a repository. `checkIsRepo()` walks up
 * the tree, so a plain directory under a clone root that itself sits inside a
 * git repository (the dogfooding case: `<arij>/projects/...`) would otherwise
 * look like a repo and be "reused".
 */
async function isRepositoryRoot(dest: string): Promise<boolean> {
  try {
    return await getGit(dest).checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
  } catch {
    return false;
  }
}

async function readRemoteUrl(
  repoPath: string,
  name: string
): Promise<string | null> {
  try {
    const remotes = await getGit(repoPath).getRemotes(true);
    const remote = remotes.find((candidate) => candidate.name === name);
    return remote?.refs?.fetch || remote?.refs?.push || null;
  } catch {
    return null;
  }
}

/** Compares two remotes ignoring credentials, `.git`, trailing slash and case. */
function sameRemote(a: string, b: string): boolean {
  return normalizeForComparison(a) === normalizeForComparison(b);
}

function normalizeForComparison(url: string): string {
  return url
    .trim()
    .replace(/:\/\/[^/\s@]+@/, "://")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** Removes a staging directory. Only ever called on a path this service made. */
function discardStaging(staging: string): void {
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    console.warn("[git/clone] could not clean up the staging directory", {
      staging,
      error: redactGitError(error),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

function toCloneError(
  error: unknown,
  context: { cloneUrl: string; branch?: string | null; token?: string | null }
): CloneError {
  if (error instanceof CloneError) return error;

  const secrets = context.token ? [context.token] : [];
  const message = redactGitError(error, secrets);
  const haystack = message.toLowerCase();

  const has = (...needles: string[]) =>
    needles.some((needle) => haystack.includes(needle));

  if (
    has("remote branch") ||
    has("did not match any file(s) known to git") ||
    (context.branch && has(`branch '${context.branch.toLowerCase()}'`))
  ) {
    return new CloneError(
      "branch_not_found",
      `Branch '${context.branch ?? ""}' does not exist in ${context.cloneUrl}.`,
      { branch: context.branch ?? null, detail: message }
    );
  }

  if (
    has(
      "authentication failed",
      "invalid username or password",
      "bad credentials",
      "403 forbidden",
      "401 unauthorized",
      "access denied"
    )
  ) {
    return new CloneError(
      "auth_failed",
      "GitHub rejected the stored credentials. Check the GitHub PAT in Settings — it may be expired or missing the `repo` scope.",
      { detail: message }
    );
  }

  if (
    has(
      "repository not found",
      "not found",
      "could not read username",
      "terminal prompts disabled",
      "does not appear to be a git repository"
    )
  ) {
    return new CloneError(
      "not_found",
      context.token
        ? `Repository not found: ${context.cloneUrl}. It does not exist, or the GitHub PAT in Settings does not grant access to it.`
        : `Repository not found: ${context.cloneUrl}. If it is private, add a GitHub PAT in Settings → GitHub PAT and retry.`,
      { detail: message, authenticated: !!context.token }
    );
  }

  if (
    has(
      "could not resolve host",
      "could not resolve proxy",
      "failed to connect",
      "connection refused",
      "connection reset",
      "network is unreachable",
      "operation timed out",
      "timed out",
      "unable to access",
      "ssl"
    )
  ) {
    return new CloneError(
      "network",
      `Could not reach ${context.cloneUrl}. Check your network connection and retry.`,
      { detail: message }
    );
  }

  return new CloneError("clone_failed", message || "git clone failed.", {
    detail: message,
  });
}
