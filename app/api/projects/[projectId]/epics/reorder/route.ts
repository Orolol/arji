import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { tryExportArjiJson } from "@/lib/sync/export";
import type { KanbanStatus } from "@/lib/types/kanban";
import { KANBAN_COLUMNS } from "@/lib/types/kanban";
import { applyTransition } from "@/lib/workflow/transition-service";
import { errorResponse } from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";

const reorderSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      position: z.number(),
    })
  ),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(reorderSchema, request);
  if (isValidationError(validated)) return validated;
  const body = validated.data;

  const now = new Date().toISOString();

  // Reject any items that touch the "released" column
  for (const item of body.items) {
    if (item.status === "released") {
      return NextResponse.json(
        { error: "Cannot move tickets to the Released column. Tickets are moved there automatically when a release is created." },
        { status: 400 }
      );
    }
  }

  // Validate workflow rules for any status changes and track moves.
  // Lookups are project-scoped: epic ids from other projects are skipped.
  const statusChanges: { epicId: string; from: KanbanStatus; to: KanbanStatus }[] = [];
  const validItems: typeof body.items = [];
  for (const item of body.items) {
    const epic = db
      .select()
      .from(epics)
      .where(and(eq(epics.id, item.id), eq(epics.projectId, projectId)))
      .get();
    if (!epic) continue;
    validItems.push(item);

    const fromStatus = (epic.status ?? "backlog") as KanbanStatus;
    const toStatus = item.status as KanbanStatus;

    // Reject moves from the released column
    if (fromStatus === "released") {
      return NextResponse.json(
        { error: "Cannot move tickets out of the Released column. Released tickets cannot be moved." },
        { status: 400 }
      );
    }

    // Only validate if status is actually changing
    if (fromStatus !== toStatus) {
      if (!KANBAN_COLUMNS.includes(toStatus)) {
        return NextResponse.json(
          { error: `Invalid status: ${toStatus}` },
          { status: 400 }
        );
      }

      const result = applyTransition({
        projectId,
        epicId: item.id,
        fromStatus,
        toStatus,
        actor: "user",
        source: "drag",
        validateOnly: true,
      });
      if (!result.valid) {
        return NextResponse.json(
          { error: result.error },
          { status: 400 }
        );
      }
      statusChanges.push({ epicId: item.id, from: fromStatus, to: toStatus });
    }
  }

  try {
    // Use a transaction for atomic reorder
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const transaction = sqlite.transaction(() => {
      for (const item of validItems) {
        db.update(epics)
          .set({
            position: item.position,
            updatedAt: now,
          })
          .where(eq(epics.id, item.id))
          .run();
      }
    });

    transaction();

    // Apply status changes through the workflow service after the atomic
    // position update; the full set was validated above.
    for (const change of statusChanges) {
      const result = applyTransition({
        projectId,
        epicId: change.epicId,
        fromStatus: change.from,
        toStatus: change.to,
        actor: "user",
        source: "drag",
        reason: "Kanban drag-and-drop",
      });
      if (!result.valid) {
        return NextResponse.json({ error: result.error }, { status: 409 });
      }
    }

    tryExportArjiJson(projectId);
    return NextResponse.json({ data: { updated: validItems.length } });
  } catch (error) {
    return errorResponse(error, "Failed to reorder epics");
  }
}
