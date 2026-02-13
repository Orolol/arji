import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, pullRequests } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchPrStatus } from "@/lib/github/pull-requests";
import { logSyncOperation } from "@/lib/github/sync-log";

type RouteParams = { params: Promise<{ projectId: string; epicId: string }> };

/**
 * POST /api/projects/[projectId]/epics/[epicId]/pr/sync
 * Fetches the current PR status from GitHub and updates local records.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { projectId, epicId } = await params;

  // Get project
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
      { error: "not_configured", message: "GitHub owner/repo not configured." },
      { status: 400 }
    );
  }

  // Get the PR record for this epic
  const pr = db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.epicId, epicId))
    .get();

  if (!pr) {
    return NextResponse.json(
      { error: "no_pr", message: "No pull request found for this epic." },
      { status: 404 }
    );
  }

  const [owner, repo] = project.githubOwnerRepo.split("/");

  try {
    const { status, title } = await fetchPrStatus(owner, repo, pr.number);
    const now = new Date().toISOString();

    // Update pullRequests record
    db.update(pullRequests)
      .set({
        status,
        title,
        updatedAt: now,
      })
      .where(eq(pullRequests.id, pr.id))
      .run();

    // Update epic's prStatus
    db.update(epics)
      .set({
        prStatus: status,
        updatedAt: now,
      })
      .where(eq(epics.id, epicId))
      .run();

    logSyncOperation({
      projectId,
      operation: "pr",
      branch: pr.headBranch,
      status: "success",
      detail: JSON.stringify({ action: "sync", prNumber: pr.number, newStatus: status }),
    });

    const updated = db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, pr.id))
      .get();

    return NextResponse.json({ data: updated });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "PR sync failed";

    logSyncOperation({
      projectId,
      operation: "pr",
      branch: pr.headBranch,
      status: "failure",
      detail,
    });

    return NextResponse.json(
      { error: "sync_failed", message: detail },
      { status: 500 }
    );
  }
}
