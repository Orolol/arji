import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, epics } from "@/lib/db/schema";
import {
  errorResponse,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import {
  assertGitRepository,
  GitRepositoryUnavailableError,
} from "@/lib/git/remote";
import { listWorktrees, pruneOrphanWorktrees } from "@/lib/git/worktrees";
import type { GitWorktreeInfo } from "@/lib/git/worktrees";

type Params = { params: Promise<{ projectId: string }> };

/** What a worktree is doing right now, from the agent's point of view. */
export type WorktreeState = "running" | "idle" | "orphan";

export interface WorktreeSummary {
  path: string;
  branch: string | null;
  state: WorktreeState;
  /** Epic that owns the branch, when one still matches. */
  epicId: string | null;
  epicReadableId: string | null;
  epicTitle: string | null;
}

/**
 * Joins git's worktree list to the epics/sessions that explain it.
 *
 * A worktree is `running` when a session is live on its branch, `orphan` when
 * git only holds a stale record (directory gone), `idle` otherwise — including
 * worktrees whose epic was deleted, because those still hold real files on
 * disk and must not be advertised as safely cleanable.
 */
function summarize(
  projectId: string,
  worktrees: GitWorktreeInfo[]
): WorktreeSummary[] {
  const agentTrees = worktrees.filter((tree) => !tree.isMain);
  if (agentTrees.length === 0) return [];

  const epicRows = db
    .select({
      id: epics.id,
      branchName: epics.branchName,
      readableId: epics.readableId,
      title: epics.title,
    })
    .from(epics)
    .where(and(eq(epics.projectId, projectId), isNotNull(epics.branchName)))
    .all();

  const epicByBranch = new Map(
    epicRows.filter((row) => row.branchName).map((row) => [row.branchName, row])
  );

  const runningRows = db
    .select({
      branchName: agentSessions.branchName,
      worktreePath: agentSessions.worktreePath,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, "running")
      )
    )
    .all();

  const runningBranches = new Set(
    runningRows.map((row) => row.branchName).filter(Boolean)
  );
  const runningPaths = new Set(
    runningRows.map((row) => row.worktreePath).filter(Boolean)
  );

  return agentTrees.map((tree) => {
    const epic = tree.branch ? epicByBranch.get(tree.branch) : undefined;
    const isRunning =
      (tree.branch !== null && runningBranches.has(tree.branch)) ||
      runningPaths.has(tree.path);

    const state: WorktreeState = tree.orphaned
      ? "orphan"
      : isRunning
        ? "running"
        : "idle";

    return {
      path: tree.path,
      branch: tree.branch,
      state,
      epicId: epic?.id ?? null,
      epicReadableId: epic?.readableId ?? null,
      epicTitle: epic?.title ?? null,
    };
  });
}

/**
 * A `gitRepoPath` that is not a usable repository is a configuration state the
 * user can fix, not a server fault — the same answer `github/detect`,
 * `git/detect-remote`, `git/status`, `git/push` and `git/pull` already give.
 * The Git Sync page mounts the worktrees panel, so without this the console
 * logged a 500 on every load for such a project.
 */
function repositoryUnavailableResponse(
  error: GitRepositoryUnavailableError
): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: 400 }
  );
}

function payload(summaries: WorktreeSummary[]) {
  return {
    worktrees: summaries,
    count: summaries.length,
    orphanCount: summaries.filter((tree) => tree.state === "orphan").length,
  };
}

/**
 * GET /api/projects/[projectId]/worktrees
 *
 * The agent worktrees of the project (the repository's own working tree is
 * excluded — it is not an agent's). Read-only: it shells out to
 * `git worktree list --porcelain` and never mutates anything.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) return found;

  try {
    // First, before any git read: unlike an empty worktree list, an unusable
    // path has no in-payload representation — a `count: 0` nobody can vouch
    // for would be a fabrication, so it is a refusal.
    await assertGitRepository(found.project.gitRepoPath);

    const worktrees = await listWorktrees(found.project.gitRepoPath);
    return NextResponse.json({ data: payload(summarize(projectId, worktrees)) });
  } catch (error) {
    if (error instanceof GitRepositoryUnavailableError) {
      return repositoryUnavailableResponse(error);
    }

    return errorResponse(error, "Failed to list git worktrees.");
  }
}

/**
 * POST /api/projects/[projectId]/worktrees
 *
 * Runs `git worktree prune`: drops the records of worktrees whose directory
 * no longer exists. Worktrees still present on disk — including those of a
 * running agent — are untouched, so this cannot destroy work in progress.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) return found;

  try {
    // Same guard as the read above: there is nothing to prune in a directory
    // that is not a repository, and saying so is not a fault.
    await assertGitRepository(found.project.gitRepoPath);

    const { pruned, remaining } = await pruneOrphanWorktrees(
      found.project.gitRepoPath
    );
    return NextResponse.json({
      data: { pruned, ...payload(summarize(projectId, remaining)) },
    });
  } catch (error) {
    if (error instanceof GitRepositoryUnavailableError) {
      return repositoryUnavailableResponse(error);
    }

    return errorResponse(error, "Failed to prune git worktrees.");
  }
}
