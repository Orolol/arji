import simpleGit from "simple-git";
import fs from "fs";
import path from "path";

/**
 * Read-side view of the git worktrees an agent build leaves behind.
 *
 * `lib/git/manager.ts` owns creation/removal (one worktree per epic branch,
 * under `../.arij-worktrees`); this module only *reports* what git currently
 * knows about, so the UI can show a count and offer to clean up the stale
 * administrative records. Nothing here mutates a live worktree.
 */

export interface GitWorktreeInfo {
  /** Absolute path git has registered for the worktree. */
  path: string;
  /** Short branch name (`refs/heads/` stripped), or null when detached. */
  branch: string | null;
  /** Commit the worktree points at, when git reported one. */
  head: string | null;
  /** False when git still lists the worktree but its directory is gone. */
  exists: boolean;
  /**
   * True when this worktree is only a leftover record: either git annotated
   * it `prunable`, or its directory no longer exists. These are exactly the
   * entries `git worktree prune` removes.
   */
  orphaned: boolean;
  /** The repository's own working tree — never an agent worktree. */
  isMain: boolean;
}

function shortBranch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Parses `git worktree list --porcelain` output.
 *
 * Exported so the parsing is testable without spawning git. The first block
 * is always the main working tree; we additionally compare resolved paths so
 * a repo opened through a symlink still classifies correctly.
 */
export function parseWorktreeList(
  porcelain: string,
  repoPath: string,
  pathExists: (candidate: string) => boolean = fs.existsSync
): GitWorktreeInfo[] {
  const blocks = porcelain
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const mainPath = path.resolve(repoPath);

  return blocks.flatMap((block, index) => {
    let worktreePath: string | null = null;
    let branch: string | null = null;
    let head: string | null = null;
    let prunable = false;

    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("worktree ")) {
        worktreePath = trimmed.slice("worktree ".length).trim();
      } else if (trimmed.startsWith("branch ")) {
        branch = shortBranch(trimmed.slice("branch ".length).trim());
      } else if (trimmed.startsWith("HEAD ")) {
        head = trimmed.slice("HEAD ".length).trim();
      } else if (trimmed === "prunable" || trimmed.startsWith("prunable ")) {
        prunable = true;
      }
    }

    if (!worktreePath) return [];

    const exists = pathExists(worktreePath);
    // A user's worktree lives wherever git says it does, outside this app's
    // tree entirely, so there is nothing here for the build to trace.
    const isMain =
      index === 0 ||
      path.resolve(/*turbopackIgnore: true*/ worktreePath) === mainPath;

    return [
      {
        path: worktreePath,
        branch,
        head,
        exists,
        // The main working tree is never reported as cleanable, even if the
        // path check fails for some exotic reason.
        orphaned: !isMain && (prunable || !exists),
        isMain,
      },
    ];
  });
}

/**
 * Every worktree git knows about, main working tree included.
 * Throws only when the path is not a git repository.
 */
export async function listWorktrees(
  repoPath: string
): Promise<GitWorktreeInfo[]> {
  // Invariant: Uses hardcoded subcommand and porcelain flag with no caller-supplied args.
  const out = await simpleGit(repoPath).raw([
    "worktree",
    "list",
    "--porcelain",
  ]);
  return parseWorktreeList(out ?? "", repoPath);
}

/**
 * Drops the administrative records of worktrees whose directory is gone
 * (`git worktree prune`). Live worktrees are never touched — this cannot
 * delete an agent's work in progress.
 *
 * Returns how many orphans disappeared, measured by listing before/after.
 */
export async function pruneOrphanWorktrees(
  repoPath: string
): Promise<{ pruned: number; remaining: GitWorktreeInfo[] }> {
  const before = await listWorktrees(repoPath);
  // Invariant: Uses hardcoded subcommand arguments with no caller-supplied options.
  await simpleGit(repoPath).raw(["worktree", "prune"]);
  const remaining = await listWorktrees(repoPath);

  const orphansBefore = before.filter((w) => w.orphaned).length;
  const orphansAfter = remaining.filter((w) => w.orphaned).length;

  return { pruned: Math.max(0, orphansBefore - orphansAfter), remaining };
}
