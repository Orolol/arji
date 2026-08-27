import simpleGit, { type SimpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import { resolveBaseBranch } from "./base-branch";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

/**
 * Generates the branch name for an epic.
 */
export function epicBranchName(epicId: string, epicTitle: string): string {
  return `feature/epic-${epicId}-${slugify(epicTitle)}`;
}

/**
 * Options shared by the operations that need to know the repository's base
 * branch. `defaultBranch` is `projects.default_branch` — recorded when Arij
 * cloned the repository, and null for user-supplied paths, where
 * {@link resolveBaseBranch} falls back to asking git.
 */
export interface BaseBranchOptions {
  defaultBranch?: string | null;
}

/**
 * Resolves the branch a project's work is based on, for callers that only
 * have a repository path — the exact same resolution `createWorktree` and
 * `mergeWorktree` run through {@link resolveBaseBranch}. The diff route uses
 * it so the diff targets the branch the worktree was actually cut from:
 * feeding `getWorktreeDiff` the stored default branch raw made a value that
 * no longer exists locally (renamed after import, or the clone's local
 * branch set diverging from the remote's) reach `merge-base` as a
 * non-existent ref — a silent empty diff with 0 ahead/behind over an epic
 * with real commits.
 */
export async function resolveDefaultBranch(
  repoPath: string,
  preferred?: string | null,
): Promise<string> {
  const git = getGit(repoPath);
  const branches = await git.branchLocal();
  return resolveBaseBranch(git, branches.all, { preferred });
}

/**
 * Creates a worktree for an epic with a dedicated branch.
 * Returns the worktree path.
 */
export async function createWorktree(
  repoPath: string,
  epicId: string,
  epicTitle: string,
  options: BaseBranchOptions = {},
): Promise<{ worktreePath: string; branchName: string }> {
  const git = getGit(repoPath);
  const branchName = epicBranchName(epicId, epicTitle);
  if (branchName.startsWith("-")) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  // Determine worktree directory next to the repo
  const worktreeBase = path.join(repoPath, "..", ".arij-worktrees");
  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  }
  const worktreePath = path.join(worktreeBase, branchName.replace(/\//g, "-"));

  // Check if worktree already exists
  if (fs.existsSync(worktreePath)) {
    return { worktreePath, branchName };
  }

  // Check if branch exists
  const branches = await git.branchLocal();
  const branchExists = branches.all.includes(branchName);

  if (branchExists) {
    // Invariant: branchName is pre-validated above to reject leading dashes.
    await git.raw(["worktree", "add", worktreePath, branchName]);
  } else {
    // Determine the branch to base new branches from
    const mainBranch = await resolveBaseBranch(git, branches.all, {
      preferred: options.defaultBranch,
    });
    // Invariant: branchName is pre-validated above to reject leading dashes.
    await git.raw([
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      mainBranch,
    ]);
  }
  return { worktreePath, branchName };
}

/**
 * Attaches a worktree to an EXISTING branch, by exact name.
 *
 * `createWorktree` derives the branch from the epic title, which is the right
 * thing when creating one but wrong when re-attaching: a title edited since
 * the branch was cut would produce a different name and silently start work
 * on a fresh branch off main. Callers that already know the branch (it is
 * persisted on `epics.branch_name`) use this instead.
 */
export async function attachWorktree(
  repoPath: string,
  branchName: string,
): Promise<{ worktreePath: string; branchName: string }> {
  if (branchName.startsWith("-")) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
  const git = getGit(repoPath);

  const worktreeBase = path.join(repoPath, "..", ".arij-worktrees");
  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  }
  const worktreePath = path.join(worktreeBase, branchName.replace(/\//g, "-"));

  if (fs.existsSync(worktreePath)) {
    return { worktreePath, branchName };
  }

  const branches = await git.branchLocal();
  if (!branches.all.includes(branchName)) {
    throw new Error(`Branch ${branchName} not found`);
  }

  // Invariant: branchName is validated above to reject leading dashes.
  await git.raw(["worktree", "add", worktreePath, branchName]);
  return { worktreePath, branchName };
}
/**
 * Resolves the commit a worktree currently sits on, or null when it cannot
 * be determined. CI autofix compares this against the PR head SHA so the
 * agent is told when its tree already carries commits CI never ran.
 */
export async function resolveWorktreeHead(
  worktreePath: string,
): Promise<string | null> {
  try {
    const head = await getGit(worktreePath).revparse(["HEAD"]);
    const sha = head.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Why a merge did not happen — callers react very differently to each. */
export type MergeFailureReason =
  /** Real content conflict: a resolution agent can fix this. */
  | "conflict"
  /**
   * The branch tree itself contains leftover conflict markers — a previous
   * resolution committed the markers instead of resolving them. The merge
   * would land them on main verbatim, so it is refused before it starts.
   * NOT "conflict": dispatching a conflict-resolution agent would find a
   * perfectly clean merge and happily wave the markers through.
   */
  | "conflict-markers"
  /** The branch is gone (already merged, or deleted). No agent can help. */
  | "branch-missing"
  /** Anything else — worktree removal, checkout, a broken repo. */
  | "error";

export interface MergeWorktreeResult {
  merged: boolean;
  commitHash?: string;
  error?: string;
  /** Present only when `merged` is false. */
  reason?: MergeFailureReason;
}

/**
 * Enough state to undo a merge: where `main` and the branch pointed before it.
 * Captured by `captureMergeCheckpoint`, consumed by `rollbackMerge`.
 */
export interface MergeCheckpoint {
  mainBranch: string;
  mainHead: string;
  branchName: string;
  branchHead: string;
}

/** Resolves the repo's integration branch — "main", else "master". */
async function resolveMainBranch(git: SimpleGit): Promise<string> {
  const branches = await git.branchLocal();
  return branches.all.includes("main") ? "main" : "master";
}

/**
 * Pathspecs per `git grep` invocation. Every changed file goes to git as an
 * argv pathspec, and a large enough diff would blow past ARG_MAX and kill
 * the spawn with E2BIG before git even starts — so the list is chunked and
 * the results unioned.
 */
const GREP_PATHSPEC_BATCH = 500;

/**
 * Lists the files in `ref`'s tree (restricted to `files`) where some line
 * starts with `pattern`. Uses `git grep` against the ref so the WORKING TREE
 * is never consulted — the guard must judge what the merge would actually
 * land, and it must work even when the worktree is already gone.
 *
 * `git grep` exits 1 when nothing matches, without a word on stderr, and
 * simple-git hands that back as an empty string rather than throwing — so
 * "no matches", the GOOD outcome here, needs no special handling. The catch
 * below is purely defensive, in case a simple-git version ever surfaces the
 * silent exit 1 as an empty-message error; real failures (bad ref, broken
 * repo) carry git's error output and are re-thrown.
 */
async function grepFilesInRef(
  git: SimpleGit,
  ref: string,
  pattern: string,
  files: string[],
): Promise<string[]> {
  const matches: string[] = [];
  for (let i = 0; i < files.length; i += GREP_PATHSPEC_BATCH) {
    const batch = files.slice(i, i + GREP_PATHSPEC_BATCH);
    let out: string;
    try {
      out = await git.raw([
        // Raw paths in the output: quotepath would octal-escape non-ASCII
        // filenames ("caf\303\251.ts"), which then match nothing when the
        // caller feeds them back as pathspecs.
        "-c",
        "core.quotepath=false",
        "grep",
        "-lE",
        pattern,
        ref,
        "--",
        ...batch,
      ]);
    } catch (e) {
      if (e instanceof Error && e.message.trim() === "") continue;
      throw e;
    }
    for (const line of out.split("\n")) {
      // Output lines look like `<ref>:<path>` — keep just the path.
      if (line) matches.push(line.slice(ref.length + 1));
    }
  }
  return matches;
}

/**
 * Files in `branchName`'s tree, among those it changes relative to
 * `mainBranch`, that still contain leftover git conflict markers.
 *
 * A file only counts when it has BOTH a line starting with `<<<<<<< ` AND a
 * line starting with `>>>>>>> ` — the pair git writes and a resolution must
 * remove. The `{7,}` run (not exactly 7) also catches the longer markers a
 * `conflict-marker-size` gitattribute produces. The line anchor plus
 * trailing space keeps prose that merely MENTIONS the markers mid-line
 * (e.g. lib/claude/prompt-builder.ts, which escapes them inside a template
 * string) from tripping the guard. Binary files are left to `git grep`,
 * which handles them without choking.
 */
async function findConflictMarkerFiles(
  git: SimpleGit,
  mainBranch: string,
  branchName: string,
): Promise<string[]> {
  const diff = await git.raw([
    // Raw paths — see the quotepath note in grepFilesInRef.
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    `${mainBranch}...${branchName}`,
  ]);
  const changedFiles = diff.split("\n").filter(Boolean);
  // `git grep <ref> --` with ZERO pathspecs would search the whole tree —
  // an empty diff must mean an empty answer instead.
  if (changedFiles.length === 0) return [];

  const withStart = await grepFilesInRef(
    git,
    branchName,
    "^<{7,} ",
    changedFiles,
  );
  if (withStart.length === 0) return [];
  const withEnd = new Set(
    await grepFilesInRef(git, branchName, "^>{7,} ", changedFiles),
  );
  return withStart.filter((file) => withEnd.has(file));
}

/**
 * Records where `main` and the epic branch point right now, so a merge that
 * turns out to have been unwanted can be undone. Returns null when the state
 * cannot be captured — the caller then simply has no rollback available.
 */
export async function captureMergeCheckpoint(
  repoPath: string,
  branchName: string,
): Promise<MergeCheckpoint | null> {
  try {
    const git = getGit(repoPath);
    const mainBranch = await resolveMainBranch(git);
    const mainHead = (await git.revparse([mainBranch])).trim();
    const branchHead = (await git.revparse([branchName])).trim();
    return { mainBranch, mainHead, branchName, branchHead };
  } catch {
    return null;
  }
}

/**
 * Undoes a merge captured by {@link captureMergeCheckpoint}: resets `main`
 * back to its pre-merge commit and restores the branch `mergeWorktree`
 * deleted. Used by unattended callers that must not leave `main` changed when
 * a post-merge check refuses the transition.
 */
export async function rollbackMerge(
  repoPath: string,
  checkpoint: MergeCheckpoint,
): Promise<{ restored: boolean; error?: string }> {
  const git = getGit(repoPath);
  try {
    await git.checkout(checkpoint.mainBranch);
    await git.reset(["--hard", checkpoint.mainHead]);

    const branches = await git.branchLocal();
    if (!branches.all.includes(checkpoint.branchName)) {
      // Invariant: branchName is validated to reject leading dashes.
      await git.raw(["branch", checkpoint.branchName, checkpoint.branchHead]);
    }
    return { restored: true };
  } catch (e) {
    return {
      restored: false,
      error: e instanceof Error ? e.message : "Rollback failed",
    };
  }
}

/**
 * Merges an epic branch into the main branch, then removes the worktree.
 * Returns the merge commit hash on success.
 *
 * Error handling is split at the point of no return. Everything up to and
 * including `git merge` can fail without `main` having changed, so those
 * failures report `merged: false` with a reason the caller can act on. Once
 * the merge command succeeds `main` HAS changed, and a later hiccup — the
 * `git log` lookup, or deleting the merged branch — must NOT be reported as
 * "not merged": a caller told that would go on to dispatch a
 * conflict-resolution agent for a merge that already landed.
 */
export async function mergeWorktree(
  repoPath: string,
  branchName: string,
  worktreePath?: string,
  options: BaseBranchOptions = {},
): Promise<MergeWorktreeResult> {
  // simple-git throws SYNCHRONOUSLY when repoPath itself no longer exists —
  // that must come back as `merged: false` like every other pre-merge
  // failure, not escape as an exception the caller has to special-case.
  let git!: SimpleGit;
  try {
    git = getGit(repoPath);
  } catch (e) {
    return {
      merged: false,
      error: e instanceof Error ? e.message : "Merge failed",
      reason: "error",
    };
  }

  if (branchName.startsWith("-")) {
    return {
      merged: false,
      error: `Invalid branch name: ${branchName}`,
      reason: "error",
    };
  }

  // ---- Pre-merge: nothing here can have modified main. -------------------
  try {
    // Get the branch to merge into
    const branches = await git.branchLocal();
    const mainBranch = await resolveBaseBranch(git, branches.all, {
      preferred: options.defaultBranch,
    });

    if (!branches.all.includes(branchName)) {
      return {
        merged: false,
        error: `Branch ${branchName} not found`,
        reason: "branch-missing",
      };
    }
    // Refuse to merge a branch whose COMMITTED tree still carries conflict
    // markers — the merge itself would be clean, so nothing downstream would
    // ever notice them. Checked before the worktree removal and the checkout
    // so a refusal leaves no state behind at all.
    const markerFiles = await findConflictMarkerFiles(
      git,
      mainBranch,
      branchName,
    );
    if (markerFiles.length > 0) {
      return {
        merged: false,
        error:
          `Branch ${branchName} contains unresolved conflict markers in: ` +
          markerFiles.join(", "),
        reason: "conflict-markers",
      };
    }

    // Remove the worktree first (git can't merge while worktree is active)
    if (worktreePath && fs.existsSync(worktreePath)) {
      // Invariant: `--` separator ensures worktreePath is not parsed as an option.
      await git.raw(["worktree", "remove", "--force", "--", worktreePath]);
      await git.raw(["worktree", "prune"]);
    }

    await git.checkout(mainBranch);
  } catch (e) {
    return {
      merged: false,
      error: e instanceof Error ? e.message : "Merge failed",
      reason: "error",
    };
  }

  // ---- The merge itself: the only step that can conflict. ----------------
  try {
    await git.merge([branchName, "--no-ff", "-m", `Merge ${branchName}`]);
  } catch (e) {
    try {
      await git.merge(["--abort"]);
    } catch {
      // ignore abort errors
    }
    return {
      merged: false,
      error: e instanceof Error ? e.message : "Merge failed",
      reason: "conflict",
    };
  }

  // ---- Post-merge: main has changed. Cleanup is best-effort. -------------
  let commitHash: string | undefined;
  try {
    commitHash = (await git.log({ maxCount: 1 })).latest?.hash;
  } catch (e) {
    console.warn(
      "[git] Merge landed but the commit hash lookup failed:",
      e instanceof Error ? e.message : e,
    );
  }

  try {
    await git.deleteLocalBranch(branchName, true);
  } catch (e) {
    console.warn(
      `[git] Merge landed but deleting ${branchName} failed:`,
      e instanceof Error ? e.message : e,
    );
  }

  return { merged: true, commitHash };
}

/**
 * Starts a merge of targetBranch into the worktree's current branch.
 * If the merge succeeds cleanly, returns { conflicted: false }.
 * If there are conflicts, leaves the worktree in a conflicted state
 * (does NOT abort) so an agent can resolve them.
 */
export async function startMergeInWorktree(
  worktreePath: string,
  targetBranch: string,
): Promise<{ conflicted: boolean; output: string }> {
  const git = getGit(worktreePath);

  try {
    // Fetch latest so the target branch ref is up to date
    const result = await git.merge([targetBranch]);
    return {
      conflicted: false,
      output: result.result || "Merge completed cleanly.",
    };
  } catch (e) {
    const output =
      e instanceof Error ? e.message : "Merge failed with conflicts";
    // Check if there are actually conflicted files
    const status = await git.status();
    if (status.conflicted.length > 0) {
      return { conflicted: true, output };
    }
    // Not a conflict — some other merge error; re-throw
    throw e;
  }
}

/**
 * Checks if a path is a valid git repository.
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const git = getGit(repoPath);
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}
