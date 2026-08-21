import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userStories, epics } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  deleteUserStoryPermanently,
  ScopedDeleteNotFoundError,
} from "@/lib/planning/permanent-delete";
import { updateStorySchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { getStoryOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  applyStoryTransition,
  type StoryStatus,
} from "@/lib/workflow/transition-service";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  const found = getStoryOr404(projectId, storyId);
  if (isErrorResponse(found)) return found;
  const { story } = found;

  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  return NextResponse.json({
    data: {
      ...story,
      epic: epic
        ? {
            id: epic.id,
            title: epic.title,
            description: epic.description,
            status: epic.status,
            branchName: epic.branchName,
            projectId: epic.projectId,
          }
        : null,
    },
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  const validated = await validateBody(updateStorySchema, request);
  if (isValidationError(validated)) return validated;

  const body = validated.data;

  const existing = getStoryOr404(projectId, storyId);
  if (isErrorResponse(existing)) return existing;

  if (body.status !== undefined && body.status !== existing.story.status) {
    const result = applyStoryTransition({
      projectId,
      epicId: existing.story.epicId,
      userStoryId: storyId,
      fromStatus: (existing.story.status ?? "todo") as StoryStatus,
      toStatus: body.status as StoryStatus,
      actor: "user",
      source: "api",
      reason: "Manual story status update",
    });
    if (!result.valid) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
  }

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.acceptanceCriteria !== undefined)
    updates.acceptanceCriteria = body.acceptanceCriteria;
  if (body.position !== undefined) updates.position = body.position;

  db.update(userStories)
    .set(updates)
    .where(eq(userStories.id, storyId))
    .run();

  const updated = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  tryExportArjiJson(projectId);
  return NextResponse.json({ data: updated });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  try {
    const result = deleteUserStoryPermanently(projectId, storyId);
    tryExportArjiJson(projectId);
    return NextResponse.json({ data: { deleted: true, epicId: result.epicId } });
  } catch (error) {
    if (error instanceof ScopedDeleteNotFoundError) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to delete story: ${message}` },
      { status: 409 },
    );
  }
}
