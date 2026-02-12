import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, userStories, pullRequests } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createOctokit, parseOwnerRepo } from "@/lib/github/client";
import {
  generatePrBody,
  createPullRequest,
  getPullRequestStatus,
  getDefaultBranch,
} from "@/lib/github/pull-requests";
import { logSyncOperation } from "@/lib/github/sync-log";
import simpleGit from "simple-git";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

/**
 * POST: Push branch to remote and create a GitHub pull request.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  // Validate epic
  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  if (!epic.branchName) {
    return NextResponse.json(
      { error: "Epic has no branch. Build the epic first to create a branch." },
      { status: 400 }
    );
  }

  if (epic.prNumber) {
    return NextResponse.json(
      { error: `PR #${epic.prNumber} already exists for this epic.` },
      { status: 409 }
    );
  }

  // Validate project
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project has no git repository configured." },
      { status: 400 }
    );
  }

  if (!project.githubOwnerRepo) {
    return NextResponse.json(
      {
        error:
          'GitHub owner/repo not configured. Go to project settings and set the GitHub repository (e.g. "owner/repo").',
      },
      { status: 400 }
    );
  }

  // Parse owner/repo
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(project.githubOwnerRepo));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid GitHub owner/repo" },
      { status: 400 }
    );
  }

  // Create Octokit
  let octokit;
  try {
    octokit = createOctokit();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create GitHub client" },
      { status: 400 }
    );
  }

  const branchName = epic.branchName;

  // Push branch to remote
  try {
    const git = simpleGit(project.gitRepoPath);
    await git.push("origin", branchName);
    logSyncOperation(projectId, "push", branchName, "success");
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "Push failed";
    logSyncOperation(projectId, "push", branchName, "failure", { error: errorMsg });
    return NextResponse.json(
      {
        error: `Failed to push branch "${branchName}" to remote. ${errorMsg}`,
        hint: "Ensure the remote 'origin' is configured and you have push access.",
      },
      { status: 500 }
    );
  }

  // Get default branch for the base
  let baseBranch: string;
  try {
    baseBranch = await getDefaultBranch(octokit, owner, repo);
  } catch {
    baseBranch = "main";
  }

  // Get user stories for PR body
  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const prBody = generatePrBody(epic, stories);
  const prTitle = epic.title;

  // Create PR
  try {
    const pr = await createPullRequest(
      octokit,
      owner,
      repo,
      branchName,
      baseBranch,
      prTitle,
      prBody
    );

    const now = new Date().toISOString();

    // Update epic with PR info
    db.update(epics)
      .set({
        prNumber: pr.number,
        prUrl: pr.htmlUrl,
        prStatus: pr.status,
        updatedAt: now,
      })
      .where(eq(epics.id, epicId))
      .run();

    // Insert into pullRequests table
    db.insert(pullRequests)
      .values({
        id: createId(),
        projectId,
        epicId,
        prNumber: pr.number,
        title: prTitle,
        body: prBody,
        htmlUrl: pr.htmlUrl,
        status: pr.status,
        headBranch: branchName,
        baseBranch,
        githubId: pr.githubId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    logSyncOperation(projectId, "pr_create", branchName, "success", {
      prNumber: pr.number,
      htmlUrl: pr.htmlUrl,
    });

    return NextResponse.json({
      data: {
        prNumber: pr.number,
        prUrl: pr.htmlUrl,
        prStatus: pr.status,
      },
    });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "PR creation failed";
    logSyncOperation(projectId, "pr_create", branchName, "failure", {
      error: errorMsg,
    });
    return NextResponse.json(
      {
        error: `Failed to create pull request: ${errorMsg}`,
        hint: "Check that the branch has commits ahead of the base branch and that your GitHub PAT has repo scope.",
      },
      { status: 500 }
    );
  }
}

/**
 * GET: Sync current PR status from GitHub.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  // Validate epic
  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  if (!epic.prNumber) {
    return NextResponse.json(
      { error: "No pull request exists for this epic." },
      { status: 404 }
    );
  }

  // Validate project
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.githubOwnerRepo) {
    return NextResponse.json(
      { error: "GitHub owner/repo not configured." },
      { status: 400 }
    );
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(project.githubOwnerRepo));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid GitHub owner/repo" },
      { status: 400 }
    );
  }

  let octokit;
  try {
    octokit = createOctokit();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create GitHub client" },
      { status: 400 }
    );
  }

  try {
    const prStatus = await getPullRequestStatus(
      octokit,
      owner,
      repo,
      epic.prNumber
    );

    const now = new Date().toISOString();

    // Update epic with latest status
    db.update(epics)
      .set({
        prStatus: prStatus.status,
        prUrl: prStatus.htmlUrl,
        updatedAt: now,
      })
      .where(eq(epics.id, epicId))
      .run();

    // Update pullRequests record
    db.update(pullRequests)
      .set({
        status: prStatus.status,
        title: prStatus.title,
        body: prStatus.body,
        htmlUrl: prStatus.htmlUrl,
        updatedAt: now,
      })
      .where(eq(pullRequests.epicId, epicId))
      .run();

    logSyncOperation(projectId, "pr_sync", epic.branchName, "success", {
      prNumber: epic.prNumber,
      status: prStatus.status,
    });

    return NextResponse.json({
      data: {
        prNumber: prStatus.number,
        prUrl: prStatus.htmlUrl,
        prStatus: prStatus.status,
        title: prStatus.title,
      },
    });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "Failed to sync PR status";
    logSyncOperation(projectId, "pr_sync", epic.branchName, "failure", {
      error: errorMsg,
    });
    return NextResponse.json(
      {
        error: `Failed to sync PR status: ${errorMsg}`,
        hint: "Check that your GitHub PAT is valid and has repo scope.",
      },
      { status: 500 }
    );
  }
}
