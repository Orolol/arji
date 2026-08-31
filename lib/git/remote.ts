import simpleGit, {
  CheckRepoActions,
  GitConstructError,
  type SimpleGit,
} from "simple-git";
import {
  isSafeRepoSegment,
  matchGitHubRemoteUrl,
} from "@/lib/git/github-url";

export interface ParsedGitHubRemote {
  owner: string;
  repo: string;
  ownerRepo: string;
}

export interface DetectedGitHubRemote extends ParsedGitHubRemote {
  remoteName: string;
  remoteUrl: string;
}

// The full repo-reference parser (remote URLs, browser URLs, owner/repo
// shorthand) lives in lib/git/github-url.ts so the client-side import page
// can share it; re-exported here so server callers keep one import site.
export type { ParsedGitHubRepoInput } from "@/lib/git/github-url";
export { parseGitHubRepoInput } from "@/lib/git/github-url";

export interface BranchSyncStatus {
  branch: string;
  remote: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  hasRemoteBranch: boolean;
}

export interface PullWithConflictResult {
  conflicted: boolean;
  summary: string;
  conflictedFiles: string[];
}

export interface GitRemoteAvailability {
  /** The remote that was asked about, after name validation. */
  remote: string;
  /** True when that remote can be used by at least one transfer operation. */
  configured: boolean;
  /** Every remote usable by at least one transfer operation. */
  configuredRemotes: string[];
  /** True when pull/fetch can read from the requested remote. */
  fetchConfigured: boolean;
  /** True when push can write to the requested remote. */
  pushConfigured: boolean;
  /** Remotes with a fetch URL. */
  fetchRemotes: string[];
  /** Remotes with a push URL or normal URL fallback. */
  pushRemotes: string[];
}

export type GitRemoteOperation = "fetch" | "push";

export class PushValidationError extends Error {
  readonly code: "working_tree_dirty" | "branch_behind_remote";

  constructor(
    code: "working_tree_dirty" | "branch_behind_remote",
    message: string
  ) {
    super(message);
    this.name = "PushValidationError";
    this.code = code;
  }
}

/**
 * "This repository has no usable `origin`" is a precondition, not a transport
 * fault. Throwing this instead of letting git's own `fatal: 'origin' does not
 * appear to be a git repository` bubble up lets the routes answer 409 with a
 * machine-readable `code` — the shape `merge_conflicts` and
 * `working_tree_dirty` already use — rather than a 500 the UI cannot act on.
 */
export class GitRemoteNotConfiguredError extends Error {
  readonly code = "remote_not_configured" as const;
  readonly remote: string;
  readonly configuredRemotes: string[];
  readonly operation: GitRemoteOperation;

  constructor(
    remote: string,
    configuredRemotes: string[],
    operation: GitRemoteOperation
  ) {
    super(
      operation === "fetch"
        ? `No fetch URL is configured for git remote '${remote}'.`
        : `No push URL is configured for git remote '${remote}'.`
    );
    this.name = "GitRemoteNotConfiguredError";
    this.remote = remote;
    this.configuredRemotes = configuredRemotes;
    this.operation = operation;
  }
}

export type GitRepositoryUnavailableCode =
  | "GIT_REPO_NOT_A_REPOSITORY"
  | "GIT_REPO_PATH_MISSING";

/**
 * "The configured `gitRepoPath` is not a usable repository" is a precondition
 * the user can fix, exactly like `GitRemoteNotConfiguredError`'s missing
 * remote. Without it, git's `fatal: not a git repository ...` prose reached
 * `errorResponse(...)` and every caller answered 500 — including the detect
 * route the connect banner hits on every project page load.
 */
export class GitRepositoryUnavailableError extends Error {
  readonly code: GitRepositoryUnavailableCode;
  readonly repoPath: string;

  constructor(code: GitRepositoryUnavailableCode, repoPath: string) {
    super(
      code === "GIT_REPO_PATH_MISSING"
        ? `The configured repository path does not exist: ${repoPath}`
        : `The configured repository path is not a git repository: ${repoPath}`
    );
    this.name = "GitRepositoryUnavailableError";
    this.code = code;
    this.repoPath = repoPath;
  }
}

/**
 * Guard for the operations that need the path to be a repository before they
 * start. Decided from git's own answer rather than from a failed command's
 * stderr: `checkIsRepo()` resolves `false` for a plain directory, and
 * simple-git raises a typed `GitConstructError` when the directory is absent,
 * so neither branch depends on message prose that varies by git version.
 *
 * The bare check is not redundant: `checkIsRepo()` asks "inside a work tree",
 * which a bare repository answers `false` to even though `git remote -v` reads
 * from it perfectly well. Without it this guard would refuse a repository the
 * callers used to handle.
 */
export async function assertGitRepository(repoPath: string): Promise<void> {
  let usable: boolean;
  try {
    // `getGit` stays inside the try: simple-git validates the directory in its
    // constructor and throws there, synchronously, for a path that is gone.
    const git = getGit(repoPath);
    usable =
      (await git.checkIsRepo()) ||
      (await git.checkIsRepo(CheckRepoActions.BARE));
  } catch (error) {
    if (error instanceof GitConstructError) {
      throw new GitRepositoryUnavailableError("GIT_REPO_PATH_MISSING", repoPath);
    }
    throw error;
  }

  if (!usable) {
    throw new GitRepositoryUnavailableError("GIT_REPO_NOT_A_REPOSITORY", repoPath);
  }
}

function normalizeRemoteUrl(raw: string): string {
  return raw.trim();
}

export function parseGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string
): ParsedGitHubRemote | null {
  const value = normalizeRemoteUrl(remoteUrl);
  if (!value) return null;

  // The grammar (patterns + segment safety) lives in lib/git/github-url.ts so
  // the server-side and client-side parsers share one source of truth. The
  // safety check matters here too: a remote whose owner/repo fails it (e.g.
  // `..` or a leading `-`) is not a usable GitHub reference.
  const matched = matchGitHubRemoteUrl(value);
  if (!matched) return null;
  if (!isSafeRepoSegment(matched.owner) || !isSafeRepoSegment(matched.repo)) {
    return null;
  }

  return {
    owner: matched.owner,
    repo: matched.repo,
    ownerRepo: `${matched.owner}/${matched.repo}`,
  };
}

function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

function assertNotFlagLike(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new Error(`${label} is required.`);
  }
  if (clean.startsWith("-")) {
    throw new Error(`Invalid ${label}: ${clean}`);
  }
  return clean;
}

function defaultRemote(remote?: string): string {
  const clean = remote?.trim() || "origin";
  if (clean.startsWith("-")) {
    throw new Error(`Invalid remote name: ${clean}`);
  }
  return clean;
}

export async function detectGitHubRemote(
  repoPath: string
): Promise<DetectedGitHubRemote | null> {
  // Checked before reading remotes so the two answers stay distinguishable:
  // `null` means "a repository with nothing GitHub-shaped on it", which is an
  // ordinary 200 for the callers, while an unusable path is a refusal.
  await assertGitRepository(repoPath);

  const git = getGit(repoPath);
  const remotes = await git.getRemotes(true);
  if (remotes.length === 0) return null;

  const prioritized = [
    ...remotes.filter((remote) => remote.name === "origin"),
    ...remotes.filter((remote) => remote.name !== "origin"),
  ];

  for (const remote of prioritized) {
    const remoteUrl =
      remote.refs?.fetch || remote.refs?.push || "";
    const parsed = parseGitHubOwnerRepoFromRemoteUrl(remoteUrl);
    if (!parsed) continue;

    return {
      ...parsed,
      remoteName: remote.name,
      remoteUrl,
    };
  }

  return null;
}

/**
 * Reads the repository's remote list and answers whether `remote` is usable.
 *
 * Deliberately decided from git's own configuration rather than from a failed
 * push/pull's stderr: the message differs per git version and per transport,
 * and reading it back is what turned an ordinary unconfigured project into a
 * server fault.
 */
export async function getRemoteAvailability(
  repoPath: string,
  remote = "origin"
): Promise<GitRemoteAvailability> {
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  const remotes = await git.getRemotes(true);

  const fetchRemotes = remotes
    .filter((entry) => Boolean((entry.refs?.fetch || "").trim()))
    .map((entry) => entry.name);
  // `git remote -v` (and therefore simple-git) resolves a normal remote URL
  // as both fetch and push. A configured `pushurl` also appears here, so this
  // list correctly includes the normal-URL fallback and push-only remotes.
  const pushRemotes = remotes
    .filter((entry) => Boolean((entry.refs?.push || "").trim()))
    .map((entry) => entry.name);
  const configuredRemotes = Array.from(
    new Set([...fetchRemotes, ...pushRemotes])
  );

  return {
    remote: cleanRemote,
    configured: configuredRemotes.includes(cleanRemote),
    configuredRemotes,
    fetchConfigured: fetchRemotes.includes(cleanRemote),
    pushConfigured: pushRemotes.includes(cleanRemote),
    fetchRemotes,
    pushRemotes,
  };
}

/**
 * Guard for the operations that need a remote to exist before they start.
 * Throws GitRemoteNotConfiguredError when it does not.
 */
export async function assertRemoteConfigured(
  repoPath: string,
  remote: string,
  operation: GitRemoteOperation
): Promise<void> {
  const availability = await getRemoteAvailability(repoPath, remote);
  const configured =
    operation === "fetch"
      ? availability.fetchConfigured
      : availability.pushConfigured;
  if (!configured) {
    throw new GitRemoteNotConfiguredError(
      availability.remote,
      operation === "fetch"
        ? availability.fetchRemotes
        : availability.pushRemotes,
      operation
    );
  }
}

export async function fetchGitRemote(
  repoPath: string,
  remote = "origin"
) {
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  return git.fetch(cleanRemote);
}

export async function pullGitBranchWithConflictSupport(
  repoPath: string,
  branch: string,
  remote = "origin"
): Promise<PullWithConflictResult> {
  const cleanBranch = assertNotFlagLike(branch, "branch name");
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  try {
    const pullResult = await git.pull(cleanRemote, cleanBranch);
    return {
      conflicted: false,
      summary: pullResult.summary
        ? JSON.stringify(pullResult.summary)
        : "Pulled successfully.",
      conflictedFiles: [],
    };
  } catch (error) {
    const status = await git.status();
    if (status.conflicted.length > 0) {
      return {
        conflicted: true,
        summary: error instanceof Error ? error.message : "Merge conflicts detected.",
        conflictedFiles: status.conflicted,
      };
    }
    throw error;
  }
}

export async function pushGitBranch(
  repoPath: string,
  branch: string,
  remote = "origin",
  setUpstream = true
) {
  const cleanBranch = assertNotFlagLike(branch, "branch name");
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  const options = setUpstream ? ["--set-upstream"] : [];
  return git.push(cleanRemote, cleanBranch, options);
}

export async function validatePushPreconditions(
  repoPath: string,
  branch: string,
  remote = "origin"
): Promise<void> {
  const git = getGit(repoPath);
  const status = await git.status();
  const hasChanges =
    status.files.length > 0 ||
    status.staged.length > 0 ||
    status.not_added.length > 0;
  if (hasChanges) {
    throw new PushValidationError(
      "working_tree_dirty",
      "Push rejected: working tree has uncommitted changes."
    );
  }

  const sync = await getBranchSyncStatus(repoPath, branch, remote);
  if (sync.behind > 0) {
    throw new PushValidationError(
      "branch_behind_remote",
      `Push rejected: local branch is ${sync.behind} commit(s) behind ${sync.remoteBranch}. Pull first.`
    );
  }
}

export async function getConflictFileDiffs(
  repoPath: string,
  files: string[]
): Promise<Array<{ filePath: string; diff: string }>> {
  const git = getGit(repoPath);
  const diffs: Array<{ filePath: string; diff: string }> = [];
  for (const file of files) {
    // Invariant: `--` separator ensures file path is treated as pathspec, not flag.
    const diff = await git.raw(["diff", "--", file]);
    diffs.push({ filePath: file, diff });
  }
  return diffs;
}

export async function getCurrentGitBranch(repoPath: string): Promise<string> {
  const git = getGit(repoPath);
  const branches = await git.branchLocal();
  return branches.current;
}

async function hasBranch(git: SimpleGit, branchName: string): Promise<boolean> {
  if (branchName.startsWith("-")) return false;
  try {
    await git.revparse([branchName]);
    return true;
  } catch {
    return false;
  }
}

export async function getBranchSyncStatus(
  repoPath: string,
  branch: string,
  remote = "origin"
): Promise<BranchSyncStatus> {
  const cleanBranch = assertNotFlagLike(branch, "branch name");
  const cleanRemote = defaultRemote(remote);
  const remoteBranch = `${cleanRemote}/${cleanBranch}`;
  const git = getGit(repoPath);

  const hasLocalBranch = await hasBranch(git, cleanBranch);
  if (!hasLocalBranch) {
    throw new Error(`Local branch '${cleanBranch}' was not found.`);
  }

  const hasRemoteBranch = await hasBranch(git, remoteBranch);
  if (!hasRemoteBranch) {
    return {
      branch: cleanBranch,
      remote: cleanRemote,
      remoteBranch,
      ahead: 0,
      behind: 0,
      hasRemoteBranch: false,
    };
  }

  // Invariant: cleanBranch and remoteBranch are validated to reject leading dashes.
  const raw = await git.raw([
    "rev-list",
    "--left-right",
    "--count",
    `${cleanBranch}...${remoteBranch}`,
  ]);
  const [aheadRaw, behindRaw] = raw.trim().split(/\s+/);
  return {
    branch: cleanBranch,
    remote: cleanRemote,
    remoteBranch,
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
    hasRemoteBranch: true,
  };
}
