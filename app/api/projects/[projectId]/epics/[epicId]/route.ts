import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  deleteEpicPermanently,
  ScopedDeleteNotFoundError,
} from "@/lib/planning/permanent-delete";
import { updateEpicSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; epicId: string }> }
) {
  const { projectId, epicId } = await params;

  const validated = await validateBody(updateEpicSchema, request);
  if (isValidationError(validated)) return validated;

  const body = validated.data;

  const existing = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!existing) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.status !== undefined) updates.status = body.status;
  if (body.position !== undefined) updates.position = body.position;
  if (body.branchName !== undefined) updates.branchName = body.branchName;

  db.update(epics).set(updates).where(eq(epics.id, epicId)).run();

  const updated = db.select().from(epics).where(eq(epics.id, epicId)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; epicId: string }> }
) {
  const { projectId, epicId } = await params;

  try {
    deleteEpicPermanently(projectId, epicId);
    tryExportArjiJson(projectId);
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    if (error instanceof ScopedDeleteNotFoundError) {
      return NextResponse.json({ error: "Epic not found" }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to delete epic: ${message}` },
      { status: 409 },
    );
  }
}
