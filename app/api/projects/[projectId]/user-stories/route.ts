import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userStories } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  deleteUserStoryPermanently,
  ScopedDeleteNotFoundError,
} from "@/lib/planning/permanent-delete";
import { createStorySchema, updateStoryByIdSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const epicId = request.nextUrl.searchParams.get("epicId");

  if (!epicId) {
    return NextResponse.json({ error: "epicId query param is required" }, { status: 400 });
  }

  const result = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  return NextResponse.json({ data: result });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(createStorySchema, request);
  if (isValidationError(validated)) return validated;

  const body = validated.data;

  const maxPos = db
    .select({ max: sql<number>`COALESCE(MAX(position), -1)` })
    .from(userStories)
    .where(eq(userStories.epicId, body.epicId))
    .get();

  const id = createId();

  db.insert(userStories)
    .values({
      id,
      epicId: body.epicId,
      title: body.title,
      description: body.description || null,
      acceptanceCriteria: body.acceptanceCriteria || null,
      status: body.status || "todo",
      position: (maxPos?.max ?? -1) + 1,
      createdAt: new Date().toISOString(),
    })
    .run();

  const us = db.select().from(userStories).where(eq(userStories.id, id)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json({ data: us }, { status: 201 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(updateStoryByIdSchema, request);
  if (isValidationError(validated)) return validated;

  const body = validated.data;

  const existing = db.select().from(userStories).where(eq(userStories.id, body.id)).get();
  if (!existing) {
    return NextResponse.json({ error: "User story not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.acceptanceCriteria !== undefined) updates.acceptanceCriteria = body.acceptanceCriteria;
  if (body.status !== undefined) updates.status = body.status;
  if (body.position !== undefined) updates.position = body.position;

  db.update(userStories).set(updates).where(eq(userStories.id, body.id)).run();

  const updated = db.select().from(userStories).where(eq(userStories.id, body.id)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json({ data: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const id = request.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id query param is required" }, { status: 400 });
  }

  try {
    const result = deleteUserStoryPermanently(projectId, id);
    tryExportArjiJson(projectId);
    return NextResponse.json({ data: { deleted: true, epicId: result.epicId } });
  } catch (error) {
    if (error instanceof ScopedDeleteNotFoundError) {
      return NextResponse.json({ error: "User story not found" }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to delete user story: ${message}` },
      { status: 409 },
    );
  }
}
