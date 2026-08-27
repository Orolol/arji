import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics, userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import { getStoryOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  applyStoryTransition,
  logWorkflowDecision,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import type { KanbanStatus } from "@/lib/types/kanban";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

/**
 * Approve a user story in review.
 *
 * Approving a story is a review verdict on that story alone: the story goes
 * done, nothing else moves. The parent epic closes exclusively through its
 * merge (`to_merge → done`, lib/workflow/engine.ts) — the epic-level review
 * verdict promotes it to To Merge and the merge cascades its remaining
 * reviewed stories. This route therefore never touches git and never writes
 * the epic's status; when the approval was the last open story, it records a
 * decision line so the trail says why the epic did not move here.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  // Validate story exists (project-scoped) and is in review
  const found = getStoryOr404(projectId, storyId);
  if (isErrorResponse(found)) return found;
  const { story } = found;

  if (story.status !== "review") {
    return NextResponse.json(
      { error: "Story must be in review status to approve" },
      { status: 400 }
    );
  }

  // Explicit human approval of a story is itself the review verdict for it.
  const storyValidation = applyStoryTransition({
    projectId,
    epicId: story.epicId,
    userStoryId: storyId,
    fromStatus: (story.status ?? "review") as StoryStatus,
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "Story review approved",
    requireCompletedReview: false,
    validateOnly: true,
  });
  if (!storyValidation.valid) {
    return NextResponse.json({ error: storyValidation.error }, { status: 400 });
  }

  applyStoryTransition({
    projectId,
    epicId: story.epicId,
    userStoryId: storyId,
    fromStatus: (story.status ?? "review") as StoryStatus,
    toStatus: "done",
    actor: "user",
    source: "approve",
    reason: "Story review approved",
    requireCompletedReview: false,
  });

  // When this closed the last open story, say so in the trail — and say why
  // the epic stays put: it closes through its merge, not through approvals.
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();
  let epicComplete = false;
  if (epic) {
    const remaining = db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, epic.id))
      .all()
      .filter((s) => s.id !== storyId && s.status !== "done");
    epicComplete = remaining.length === 0;
    if (epicComplete) {
      logWorkflowDecision({
        projectId,
        epicId: epic.id,
        status: (epic.status ?? "review") as KanbanStatus,
        actor: "user",
        reason:
          "All stories approved. The epic closes through its merge: a passing review moves it to To Merge, and merging the branch marks it Done.",
      });
    }
  }

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: { approved: true, epicComplete, merged: false },
  });
}
