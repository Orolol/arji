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
  /**
   * "I am only reordering; never move anything."
   *
   * Each item carries the status the CLIENT believes the ticket has, and a
   * mismatch with the stored one is otherwise read as a requested move. That
   * is right for drag-and-drop, which really does move a card, but wrong for
   * a whole-column action like "Sort by priority": on a board the server has
   * moved on from, it would either fail the entire sort on a refused
   * transition or silently demote a ticket the user never dragged.
   *
   * With this flag an item whose stored status differs is skipped instead —
   * its index means nothing in a column it is not in — and the response says
   * how many, so the client can re-sync.
   */
  reorderOnly: z.boolean().optional(),
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
  let skipped = 0;
  for (const item of body.items) {
    const epic = db
      .select()
      .from(epics)
      .where(and(eq(epics.id, item.id), eq(epics.projectId, projectId)))
      .get();
    if (!epic) continue;

    const fromStatus = (epic.status ?? "backlog") as KanbanStatus;
    const toStatus = item.status as KanbanStatus;

    // A pure reorder leaves stale rows alone rather than moving them (see
    // `reorderOnly`). This covers a card the caller believes is elsewhere,
    // including one that has since been released.
    if (body.reorderOnly && fromStatus !== toStatus) {
      skipped += 1;
      continue;
    }

    validItems.push(item);

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
    return NextResponse.json({
      data: { updated: validItems.length, skipped },
    });
  } catch (error) {
    return errorResponse(error, "Failed to reorder epics");
  }
}
