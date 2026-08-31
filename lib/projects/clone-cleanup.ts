import fs from "node:fs";
import fsp from "node:fs/promises";
import simpleGit from "simple-git";
import { listWorktrees } from "@/lib/git/worktrees";
import { redactedErrorMessage } from "@/lib/git/redact";
import { isArijManagedClone } from "@/lib/git/clone-marker";
import { GITHUB_CLONE_SOURCE } from "./clone-provenance";
import {
  containsPathOnDisk,
  isInsideProjectsRoot,
  resolveProjectsRoot,
  worktreesRootFor,
} from "./workspace";

/**
 * Removal of an app-managed clone from disk.
 *
 * The rule this module exists to enforce: **Arij only deletes directories Arij
 * created.** Three independent gates have to pass before a single file is
 * touched:
 *
 *  1. the project is flagged `clone_source = "github"` — Arij is being *asked*
 *     to treat this as its own clone;
 *  2. the resolved path is still a strict descendant of the *current* projects
 *     root — it is still where Arij puts clones;
 *  3. the directory itself carries Arij's clone marker — it really is one Arij
 *     created.
 *
 * The third gate is the one that cannot be talked into a lie. The first is a
 * database column, and every column is reachable from the API; the second is a
 * statement about location, and users may keep their own checkouts under the
 * root. Only the marker is written by the clone service into a directory it
 * made itself, so only the marker is evidence. A user-supplied `gitRepoPath` is
 * untouchable no matter what the other two say.
 *
 * No gate is a request error: the project is deleted either way, and the
 * response reports why the directory was left alone.
 */

export type CloneRemovalSkipReason =
  /** The project has no `gitRepoPath` at all. */
  | "no_path"
  /** `clone_source` is NULL — a user-supplied directory Arij must not delete. */
  | "not_managed"
  /** The path is outside the configured projects root (moved root, hand-edited row). */
  | "outside_projects_root"
  /** Flagged and in-root, but already gone from disk. */
  | "missing"
  /** Flagged and in-root, but the directory carries no Arij clone marker. */
  | "not_arij_clone";

export const CLONE_REMOVAL_SKIP_MESSAGES: Record<CloneRemovalSkipReason, string> = {
  no_path: "Project has no repository path; nothing to remove.",
  not_managed:
    "Directory left untouched: this project's repository was supplied by you, not cloned by Arij.",
  outside_projects_root:
    "Directory left untouched: it is outside the configured projects root.",
  missing: "Directory was already gone; nothing to remove.",
  not_arij_clone:
    "Directory left untouched: it carries no Arij clone marker, so Arij cannot confirm it created it.",
};

export interface ProjectClonePointer {
  gitRepoPath: string | null;
  cloneSource: string | null;
}

export type RemovableCloneCheck =
  | { ok: true; path: string }
  | { ok: false; reason: CloneRemovalSkipReason };

export { GITHUB_CLONE_SOURCE };

/**
 * Decides whether a project's directory may be removed, without touching it.
 *
 * Exported separately from {@link removeProjectClone} so the two guards can be
 * unit-tested exhaustively — they are the whole safety story of this feature.
 */
export function resolveRemovableClonePath(
  project: ProjectClonePointer,
  projectsRoot: string
): RemovableCloneCheck {
  const rawPath = project.gitRepoPath?.trim();
  if (!rawPath) return { ok: false, reason: "no_path" };

  if (project.cloneSource !== GITHUB_CLONE_SOURCE) {
    return { ok: false, reason: "not_managed" };
  }

  // Plain containment first (cheap, and the only check that applies when the
  // path does not exist), then the symlink-collapsing variant.
  if (
    !isInsideProjectsRoot(rawPath, projectsRoot) ||
    !containsPathOnDisk(rawPath, projectsRoot)
  ) {
    return { ok: false, reason: "outside_projects_root" };
  }

  return { ok: true, path: rawPath };
}

export interface CloneRemovalResult {
  removed: boolean;
  /** The directory that was (or would have been) removed. */
  path: string | null;
  /** Worktree directories removed alongside the clone. */
  worktreesRemoved: string[];
  /** Stale worktree records dropped by `git worktree prune`. */
  worktreesPruned: number;
  reason?: CloneRemovalSkipReason;
  message?: string;
  /** Set when removal was attempted and failed; already credential-redacted. */
  error?: string;
}

function skip(reason: CloneRemovalSkipReason, path: string | null): CloneRemovalResult {
  return {
    removed: false,
    path,
    worktreesRemoved: [],
    worktreesPruned: 0,
    reason,
    message: CLONE_REMOVAL_SKIP_MESSAGES[reason],
  };
}

/**
 * Detaches and deletes every worktree git has registered for this clone.
 *
 * Uses git's own registry rather than guessing directory names: worktrees are
 * named after the branch, not the repository, so two clones sharing a branch
 * name would otherwise be indistinguishable inside `.arij-worktrees`. The
 * shared `.arij-worktrees` directory itself is never removed — it belongs to
 * every clone under the root, not to this one.
 *
 * Removal is confined to that `.arij-worktrees` directory, which is the only
 * place `createWorktree()` puts them. Being registered to this clone is not on
 * its own a licence to delete: a worktree the user added by hand somewhere else
 * under the projects root is their working directory, quite possibly holding
 * uncommitted work, and is reported instead.
 */
async function removeWorktrees(
  repoPath: string,
  projectsRoot: string
): Promise<{ removed: string[]; pruned: number }> {
  const worktreesRoot = worktreesRootFor(repoPath);
  // simple-git throws synchronously from its factory for a missing directory,
  // so every use sits inside a guard — the repo can vanish under us at any point.
  const runGit = async (args: string[]): Promise<void> => {
    await simpleGit(repoPath).raw(args);
  };

  let prunedBefore = 0;
  try {
    const before = await listWorktrees(repoPath);
    prunedBefore = before.filter((worktree) => worktree.orphaned).length;
    await runGit(["worktree", "prune"]);
  } catch (error) {
    console.warn(
      "[clone-cleanup] worktree prune failed:",
      redactedErrorMessage(error)
    );
  }

  let entries: Awaited<ReturnType<typeof listWorktrees>> = [];
  try {
    entries = await listWorktrees(repoPath);
  } catch (error) {
    console.warn(
      "[clone-cleanup] worktree list failed:",
      redactedErrorMessage(error)
    );
    return { removed: [], pruned: prunedBefore };
  }

  const removed: string[] = [];
  for (const worktree of entries) {
    if (worktree.isMain) continue;
    // Must be one of Arij's own worktrees: a strict descendant of the shared
    // `.arij-worktrees` directory (and, transitively, of the projects root).
    // Anything else is the user's, wherever git has it registered.
    if (
      !containsPathOnDisk(worktree.path, worktreesRoot) ||
      !containsPathOnDisk(worktree.path, projectsRoot)
    ) {
      console.warn(
        "[clone-cleanup] skipping worktree outside .arij-worktrees:",
        worktree.path
      );
      continue;
    }

    try {
      await runGit(["worktree", "remove", worktree.path, "--force"]);
    } catch {
      // git refuses for records whose directory is already gone; the explicit
      // rm below is the fallback.
    }

    try {
      await fsp.rm(worktree.path, { recursive: true, force: true });
      removed.push(worktree.path);
    } catch (error) {
      console.warn(
        "[clone-cleanup] failed to remove worktree",
        worktree.path,
        redactedErrorMessage(error)
      );
    }
  }

  try {
    await runGit(["worktree", "prune"]);
  } catch {
    // best-effort; the repository is about to be deleted anyway
  }

  return { removed, pruned: prunedBefore };
}

/**
 * Removes an app-managed clone and its worktrees.
 *
 * Never throws: a filesystem failure is reported on the result so the project
 * deletion it accompanies can still succeed.
 */
export async function removeProjectClone(
  project: ProjectClonePointer,
  options: { projectsRoot?: string } = {}
): Promise<CloneRemovalResult> {
  const projectsRoot = options.projectsRoot ?? resolveProjectsRoot();
  const check = resolveRemovableClonePath(project, projectsRoot);

  if (!check.ok) {
    return skip(check.reason, project.gitRepoPath ?? null);
  }

  // The projects root is user-configurable and sits outside the app's own
  // tree, so there is nothing here for the build to trace.
  if (!fs.existsSync(/*turbopackIgnore: true*/ check.path)) {
    return skip("missing", check.path);
  }

  // Third gate, and the only one backed by evidence rather than intent: the
  // directory must carry the marker the clone service stamps into repositories
  // it created. Checked here rather than in `resolveRemovableClonePath` so that
  // function stays a pure decision over the project row, and so a path that is
  // simply gone reports `missing` instead of an unmarked-directory refusal.
  if (!isArijManagedClone(check.path)) {
    return skip("not_arij_clone", check.path);
  }

  const worktrees = await removeWorktrees(check.path, projectsRoot);

  try {
    await fsp.rm(check.path, { recursive: true, force: true });
  } catch (error) {
    return {
      removed: false,
      path: check.path,
      worktreesRemoved: worktrees.removed,
      worktreesPruned: worktrees.pruned,
      error: redactedErrorMessage(error, "Failed to remove the clone directory."),
    };
  }

  return {
    removed: true,
    path: check.path,
    worktreesRemoved: worktrees.removed,
    worktreesPruned: worktrees.pruned,
  };
}
