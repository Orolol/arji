import { containsPathOnDisk, worktreesRootFor } from "@/lib/projects/workspace";

/**
 * The only filesystem location in which Arij may execute verification.
 * This intentionally rejects the repository checkout itself and arbitrary
 * paths copied into durable session state.
 */
export function isManagedEpicWorktreePath(
  worktreePath: string,
  repoPath: string,
): boolean {
  if (!worktreePath.trim() || !repoPath.trim()) return false;
  return containsPathOnDisk(worktreePath, worktreesRootFor(repoPath));
}

export function assertManagedEpicWorktreePath(
  worktreePath: string,
  repoPath: string,
): void {
  if (!isManagedEpicWorktreePath(worktreePath, repoPath)) {
    throw new Error(
      "Deterministic verification requires a managed epic worktree and refuses the repository checkout.",
    );
  }
}
