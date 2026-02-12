import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userStories, epics } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

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
  const body = await request.json();

  const existing = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!existing) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.acceptanceCriteria !== undefined)
    updates.acceptanceCriteria = body.acceptanceCriteria;
  if (body.status !== undefined) updates.status = body.status;
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
