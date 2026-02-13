import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, userStories, pullRequests, settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { pushRemote } from "@/lib/git/remote";
import { generatePrBody, createPullRequest } from "@/lib/github/pull-requests";
import { logSyncOperation } from "@/lib/github/sync-log";

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
  let baseBranch = "main";
  let draft = false;
  try {
    const body = await request.json();
    if (body.baseBranch) baseBranch = body.baseBranch;
    if (body.draft !== undefined) draft = body.draft;
  } catch {
    // Empty body is fine, use defaults
  }

  // Validate project exists and has GitHub config
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return NextResponse.json(
      { error: "not_found", message: "Project not found." },
      { status: 404 }
    );
  }

  if (!project.githubOwnerRepo) {
    return NextResponse.json(
      { error: "not_configured", message: "GitHub owner/repo not configured for this project." },
      { status: 400 }
    );
  }

  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "not_configured", message: "No git repository path configured for this project." },
      { status: 400 }
    );
  }

  // Validate GitHub PAT exists
  const pat = db
    .select()
    .from(settings)
    .where(eq(settings.key, "github_pat"))
    .get();

  if (!pat) {
    return NextResponse.json(
      { error: "not_configured", message: "GitHub PAT not configured. Set it in Settings." },
      { status: 400 }
    );
  }

  // Get the epic
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, epicId))
    .get();

  if (!epic) {
    return NextResponse.json(
      { error: "not_found", message: "Epic not found." },
      { status: 404 }
    );
  }

  if (!epic.branchName) {
    return NextResponse.json(
      { error: "no_branch", message: "Epic has no branch associated." },
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
      { error: "pr_exists", message: `PR #${existingPr.number} already exists for this epic.` },
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

  // Push the branch
  try {
    await pushRemote(project.gitRepoPath, epic.branchName);

    logSyncOperation({
      projectId,
      operation: "push",
      branch: epic.branchName,
      status: "success",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Push failed";

    logSyncOperation({
      projectId,
      operation: "push",
      branch: epic.branchName,
      status: "failure",
      detail,
    });

    return NextResponse.json(
      { error: "push_failed", message: detail },
      { status: 500 }
    );
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

    logSyncOperation({
      projectId,
      operation: "pr",
      branch: epic.branchName,
      status: "success",
      detail: JSON.stringify({ prNumber: prResult.number, url: prResult.url }),
    });

    const pr = db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .get();

    return NextResponse.json({ data: { pr } }, { status: 201 });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "PR creation failed";

    logSyncOperation({
      projectId,
      operation: "pr",
      branch: epic.branchName,
      status: "failure",
      detail,
    });

    return NextResponse.json(
      { error: "pr_creation_failed", message: detail },
      { status: 500 }
    );
  }
}
