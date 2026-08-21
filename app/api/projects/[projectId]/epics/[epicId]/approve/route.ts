import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, userStories, reviewComments, ticketComments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import simpleGit from "simple-git";
import {
  applyStoryTransition,
  applyTransition,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import { getEpicOr404, isErrorResponse } from "@/lib/api/route-helpers";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  // Validate epic exists (project-scoped) and is in review
  const found = getEpicOr404(projectId, epicId);
  if (isErrorResponse(found)) return found;
  const { epic } = found;
  if (epic.status !== "review") {
    return NextResponse.json(
      { error: "Epic must be in review status to approve" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  // Bulk-resolve all open review comments (before validation so context sees them resolved)
  db.update(reviewComments)
    .set({ status: "resolved", updatedAt: now })
    .where(
      and(
        eq(reviewComments.epicId, epicId),
        eq(reviewComments.status, "open")
      )
    )
    .run();

  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .all();

  // Validate every child before applying any write; epic approval supplies
  // the review context for its synchronized story transitions.
  for (const story of stories) {
    const validation = applyStoryTransition({
      projectId,
      epicId,
      userStoryId: story.id,
      fromStatus: (story.status ?? "todo") as StoryStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "Parent epic review approved",
      reviewScope: "epic",
      validateOnly: true,
    });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  // Validate + apply the epic transition (DB update, event and log).
  const validation = applyTransition({
    projectId,
    epicId,
    fromStatus: "review",
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "Review approved",
  });
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Post approval activity comment
  db.insert(ticketComments)
    .values({
      id: createId(),
      epicId,
      author: "user",
      content: "**Review approved.** All review comments resolved.",
      createdAt: now,
    })
    .run();

  for (const story of stories) {
    applyStoryTransition({
      projectId,
      epicId,
      userStoryId: story.id,
      fromStatus: (story.status ?? "todo") as StoryStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "Parent epic review approved",
      reviewScope: "epic",
    });
  }

  // Attempt auto-merge
  let merged = false;
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (project?.gitRepoPath && epic.branchName) {
    try {
      const git = simpleGit(project.gitRepoPath);
      await git.merge([epic.branchName, "--no-ff"]);
      merged = true;
    } catch (e) {
      console.error("[epic-approve] Merge failed:", e);
    }
  }

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: {
      approved: true,
      merged,
    },
  });
}
