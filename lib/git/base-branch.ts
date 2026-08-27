import type { SimpleGit } from "simple-git";

/**
 * Which branch new work is based on, and what release branches are cut from.
 *
 * This used to be `branches.includes("main") ? "main" : "master"`, which is
 * wrong twice over for anything else: a repository on `develop` or `trunk`
 * clones fine and then fails at the first `worktree add`, because it is being
 * pointed at a branch that does not exist. Repositories cloned by Arij record
 * what the clone actually checked out (`projects.default_branch`), and every
 * repository — cloned or user-supplied — can be asked directly through
 * `origin/HEAD`.
 *
 * Order of preference:
 *
 *  1. the branch recorded for the project, when it still exists locally;
 *  2. `origin/HEAD`, i.e. what the remote says its default is;
 *  3. `main`, then `master`, the historical guess;
 *  4. whatever branch the repository does have.
 *
 * Each step is a fact about this repository, so the guess is only reached when
 * the repository has told us nothing.
 */

/** Reads `origin/HEAD` and returns the short branch name, or null. */
async function remoteDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    // Invariant: Uses hardcoded symbolic-ref subcommands and args with no caller-supplied inputs.
    const ref = (
      await git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : null;
  } catch {
    return null;
  }
}

export interface ResolveBaseBranchOptions {
  /** `projects.default_branch`, when the caller has the project row. */
  preferred?: string | null;
}

/**
 * Resolves the branch to base new work on.
 *
 * `localBranches` is passed in because every caller has already run
 * `branchLocal()` for its own reasons; nothing here re-runs it.
 *
 * Throws only when the repository has no local branches at all — an unborn
 * HEAD, which no caller can do anything useful with.
 */
export async function resolveBaseBranch(
  git: SimpleGit,
  localBranches: string[],
  options: ResolveBaseBranchOptions = {}
): Promise<string> {
  const has = (branch: string | null | undefined): branch is string =>
    !!branch && localBranches.includes(branch);

  const preferred = options.preferred?.trim();
  if (has(preferred)) return preferred;

  const remote = await remoteDefaultBranch(git);
  if (has(remote)) return remote;

  if (has("main")) return "main";
  if (has("master")) return "master";

  if (localBranches.length > 0) return localBranches[0];

  throw new Error("No local branches found in repository.");
}
