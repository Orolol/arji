import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics, userStories, pullRequests } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  getProjectOr404,
  getEpicOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import { getGitHubTokenFromSettings } from "@/lib/github/client";
import { pushGitBranch } from "@/lib/git/remote";
import { resolveDefaultBranch } from "@/lib/git/manager";
import { generatePrBody, createPullRequest } from "@/lib/github/pull-requests";
import { writeGitSyncLog } from "@/lib/github/sync-log";

type RouteParams = { params: Promise<{ projectId: string; epicId: string }> };

/**
 * GET /api/projects/[projectId]/epics/[epicId]/pr
 * Returns current PR metadata for the epic if it exists.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { epicId } = await params;

  const pr = db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.epicId, epicId))
    .get();

  if (!pr) {
    return NextResponse.json({ data: null });
  }

  return NextResponse.json({ data: pr });
}

/**
 * POST /api/projects/[projectId]/epics/[epicId]/pr
 * Pushes the epic branch and creates a PR on GitHub.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { projectId, epicId } = await params;

  // Get optional body params (base branch, draft flag)
  let explicitBaseBranch: string | undefined;
  let draft = false;
  try {
    const body = await request.json();
    if (body.baseBranch) explicitBaseBranch = body.baseBranch;
    if (body.draft !== undefined) draft = body.draft;
  } catch {
    // Empty body is fine, use defaults
  }

  // Validate project exists and has GitHub config
  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  if (!project.githubOwnerRepo) {
    return NextResponse.json(
      { error: "GitHub owner/repo not configured for this project." },
      { status: 400 }
    );
  }

  // Validate GitHub PAT exists (empty/blank tokens count as not configured)
  const token = getGitHubTokenFromSettings();
  if (!token) {
    return NextResponse.json(
      { error: "GitHub PAT not configured. Set it in Settings." },
      { status: 400 }
    );
  }

  // Get the epic (scoped to the project)
  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  if (!epic.branchName) {
    return NextResponse.json(
      { error: "Epic has no branch associated." },
      { status: 400 }
    );
  }

  // Check if PR already exists for this epic
  const existingPr = db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.epicId, epicId))
    .get();

  if (existingPr) {
    return NextResponse.json(
      { error: `PR #${existingPr.number} already exists for this epic.` },
      { status: 409 }
    );
  }

  // Get user stories for PR body
  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const [owner, repo] = project.githubOwnerRepo.split("/");

  // The PR must target a branch that exists on the remote. The project's
  // stored default_branch (set by a GitHub import) is authoritative for
  // Arij-cloned projects — a hard-coded "main" makes GitHub answer 422
  // "Base ref must be a branch" on a develop-default clone. Projects without
  // a stored value fall back to asking the repository itself (main →
  // master → origin/HEAD → current branch).
  let baseBranch = explicitBaseBranch;
  if (!baseBranch) {
    try {
      baseBranch = await resolveDefaultBranch(
        project.gitRepoPath!,
        project.defaultBranch || undefined
      );
    } catch {
      // The repository cannot be resolved — keep the historical default so
      // the GitHub-side error (if any) is what the user sees, not a crash.
      baseBranch = "main";
    }
  }

  // Push the branch
  try {
    await pushGitBranch(project.gitRepoPath, epic.branchName);

    writeGitSyncLog({
      projectId,
      operation: "push",
      branch: epic.branchName,
      status: "success",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Push failed";

    writeGitSyncLog({
      projectId,
      operation: "push",
      branch: epic.branchName,
      status: "failed",
      detail: { error: detail },
    });

    return errorResponse(e, "Failed to push branch for pull request.");
  }

  // Create PR on GitHub
  try {
    const storiesForPr = stories.map((s) => ({
      title: s.title,
      status: s.status ?? "todo",
    }));
    const body = generatePrBody(epic, storiesForPr);
    const prResult = await createPullRequest({
      owner,
      repo,
      title: epic.title,
      body,
      head: epic.branchName,
      base: baseBranch,
      draft,
    });

    const now = new Date().toISOString();
    const prId = createId();

    // Persist in pullRequests table
    db.insert(pullRequests)
      .values({
        id: prId,
        projectId,
        epicId,
        number: prResult.number,
        url: prResult.url,
        title: prResult.title,
        status: prResult.status,
        headBranch: prResult.headBranch,
        baseBranch: prResult.baseBranch,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Update epic with PR metadata
    db.update(epics)
      .set({
        prNumber: prResult.number,
        prUrl: prResult.url,
        prStatus: prResult.status,
        updatedAt: now,
      })
      .where(eq(epics.id, epicId))
      .run();

    writeGitSyncLog({
      projectId,
      operation: "push",
      branch: epic.branchName,
      status: "success",
      detail: { prNumber: prResult.number, url: prResult.url },
    });

    const pr = db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .get();

    return NextResponse.json({ data: { pr } }, { status: 201 });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "PR creation failed";

    writeGitSyncLog({
      projectId,
      operation: "push",
      branch: epic.branchName,
      status: "failed",
      detail: { error: detail },
    });

    return errorResponse(e, "Failed to create the pull request on GitHub.");
  }
}
