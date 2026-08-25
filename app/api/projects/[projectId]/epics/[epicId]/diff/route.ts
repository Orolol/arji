import { NextRequest, NextResponse } from "next/server";
import { getWorktreeDiff } from "@/lib/git/diff";
import {
  createWorktree,
  isGitRepo,
  resolveDefaultBranch,
} from "@/lib/git/manager";
import {
  errorResponse,
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  if (!epic.branchName) {
    return NextResponse.json(
      { error: "Epic has no branch — nothing to diff" },
      { status: 400 }
    );
  }

  const isRepo = await isGitRepo(project.gitRepoPath);
  if (!isRepo) {
    return NextResponse.json(
      { error: "Project path is not a git repository" },
      { status: 400 }
    );
  }

  // Ensure worktree exists
  const { worktreePath } = await createWorktree(
    project.gitRepoPath,
    epic.id,
    epic.title,
    { defaultBranch: project.defaultBranch }
  );

  try {
    // Diff against the branch the worktree was actually cut from. createWorktree
    // above resolved its base through resolveBaseBranch (stored default,
    // existence-checked, then origin/HEAD → main → master → fallback); the
    // diff must use the very same resolution. Feeding the stored value raw
    // made a stored default branch that no longer exists locally (renamed
    // after import, or the clone's local branch set diverging from the
    // remote's) feed `merge-base` a non-existent ref — a silent empty diff
    // with 0 ahead/behind over an epic with real commits.
    const baseBranch = await resolveDefaultBranch(
      project.gitRepoPath,
      project.defaultBranch
    );
    const result = await getWorktreeDiff(worktreePath, baseBranch);
    return NextResponse.json({ data: result });
  } catch (error) {
    return errorResponse(error, "Failed to generate diff");
  }
}
