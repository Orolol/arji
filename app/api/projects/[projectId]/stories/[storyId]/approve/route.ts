import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import simpleGit from "simple-git";
import { getStoryOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  applyStoryTransition,
  applyTransition,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import type { KanbanStatus } from "@/lib/types/kanban";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
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

  // Check whether this approval will complete the epic before applying any
  // status write, so all workflow guards can be validated as one decision.
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  const allStories = epic ? db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epic.id))
    .all() : [];

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
    validateOnly: true,
  });
  if (!storyValidation.valid) {
    return NextResponse.json({ error: storyValidation.error }, { status: 400 });
  }

  if (epic && allDone) {
    const epicValidation = applyTransition({
      projectId,
      epicId: epic.id,
      fromStatus: (epic.status ?? "review") as KanbanStatus,
      toStatus: "done",
      actor: "user",
      source: "approve",
      reason: "All stories approved",
      validateOnly: true,
    });
    if (!epicValidation.valid) {
      return NextResponse.json({ error: epicValidation.error }, { status: 400 });
    }
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
  });

  let merged = false;

  if (epic && allDone) {
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
  }

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: {
      approved: true,
      epicComplete: allDone,
      merged,
    },
  });
}
