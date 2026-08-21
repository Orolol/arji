import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, reviewComments, userStories } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import simpleGit from "simple-git";
import { getStoryOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  applyStoryTransition,
  applyTransition,
  logWorkflowDecision,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import type { KanbanStatus } from "@/lib/types/kanban";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

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

  // review_comments are epic-scoped in the current schema. Story approval is
  // an explicit human review decision, so mirror epic approval by resolving
  // the parent epic's open findings before validating this story.
  const now = new Date().toISOString();
  db.update(reviewComments)
    .set({ status: "resolved", updatedAt: now })
    .where(
      and(
        eq(reviewComments.epicId, story.epicId),
        eq(reviewComments.status, "open")
      )
    )
    .run();

  // Check whether this approval will complete the epic before applying any
  // status write, so all workflow guards can be validated as one decision.
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  const allStories = epic
    ? db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epic.id))
        .all()
    : [];

  const allDone = allStories.every((s) => s.id === storyId || s.status === "done");

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

  const epicValidation =
    epic && allDone
      ? applyTransition({
          projectId,
          epicId: epic.id,
          fromStatus: (epic.status ?? "review") as KanbanStatus,
          toStatus: "done",
          actor: "user",
          source: "approve",
          reason: "All stories approved",
          validateOnly: true,
        })
      : null;

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

  let merged = false;

  if (epic && allDone && epicValidation?.valid) {
    applyTransition({
      projectId,
      epicId: epic.id,
      fromStatus: (epic.status ?? "review") as KanbanStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "All stories approved",
    });

    // Attempt to merge the epic branch
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
        console.error("[approve] Merge failed:", e);
        // Don't fail the approve — the merge can be done manually
      }
    }
  } else if (epic && allDone && epicValidation && !epicValidation.valid) {
    logWorkflowDecision({
      projectId,
      epicId: epic.id,
      status: (epic.status ?? "review") as KanbanStatus,
      actor: "user",
      reason: `Story approved; parent epic held because completion was refused: ${epicValidation.error ?? "unknown workflow guard failure"}`,
    });
  }

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: {
      approved: true,
      epicComplete: allDone && (epicValidation?.valid ?? false),
      ...(allDone && epicValidation && !epicValidation.valid
        ? { epicHoldReason: epicValidation.error }
        : {}),
      merged,
    },
  });
}
