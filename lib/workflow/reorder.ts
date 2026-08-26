/**
 * Shared reorder core — the transactional position update used by the board
 * drag route and by agent-facing reordering (the refinement MCP tools).
 *
 * One pass validates every status change through the workflow engine, one
 * better-sqlite3 transaction writes all positions atomically, and status
 * changes are applied through the same transition service afterwards, so a
 * half-reordered board is never visible.
 */

import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import type { KanbanStatus } from "@/lib/types/kanban";
import { KANBAN_COLUMNS } from "@/lib/types/kanban";
import { applyTransition } from "@/lib/workflow/transition-service";

export interface ReorderItemInput {
  id: string;
  /** Target status; equal to the current status when the item only moves in position. */
  status: string;
  position: number;
}

export interface ReorderContext {
  actor: "user" | "agent";
  /**
   * Drag for the board route, "refinement" for the agent re-pass. The
   * source reaches the workflow engine, where "refinement" is what pins a
   * transition to the Backlog / To do columns.
   */
  source: "drag" | "api" | "refinement";
  /** Activity-log reason recorded for any status change. */
  reason?: string;
  /**
   * Restrict which columns the items may currently sit in. The refinement
   * tools pass ["backlog", "todo"] — their guardrail is that they never
   * touch in progress / review / done.
   */
  onlyFromStatuses?: readonly string[];
}

export type ReorderTicketsResult =
  | { ok: true; updated: number }
  | { ok: false; error: string; statusCode: number };

export function reorderTickets(
  projectId: string,
  items: ReorderItemInput[],
  ctx: ReorderContext
): ReorderTicketsResult {
  const now = new Date().toISOString();

  // Reject any items that target the "released" column.
  for (const item of items) {
    if (item.status === "released") {
      return {
        ok: false,
        error:
          "Cannot move tickets to the Released column. Tickets are moved there automatically when a release is created.",
        statusCode: 400,
      };
    }
  }

  // Validate workflow rules for any status changes and track moves.
  // Lookups are project-scoped: epic ids from other projects are skipped.
  const statusChanges: { epicId: string; from: KanbanStatus; to: KanbanStatus }[] = [];
  const validItems: ReorderItemInput[] = [];
  for (const item of items) {
    const epic = db
      .select()
      .from(epics)
      .where(and(eq(epics.id, item.id), eq(epics.projectId, projectId)))
      .get();
    if (!epic) continue;
    validItems.push(item);

    const fromStatus = (epic.status ?? "backlog") as KanbanStatus;

    // Reject moves from the released column
    if (fromStatus === "released") {
      return {
        ok: false,
        error:
          "Cannot move tickets out of the Released column. Released tickets cannot be moved.",
        statusCode: 400,
      };
    }

    if (ctx.onlyFromStatuses && !ctx.onlyFromStatuses.includes(fromStatus)) {
      return {
        ok: false,
        error: `Cannot reorder ${epic.readableId ?? item.id} from the ${fromStatus} column.`,
        statusCode: 409,
      };
    }

    const toStatus = item.status as KanbanStatus;

    // Only validate if status is actually changing
    if (fromStatus !== toStatus) {
      if (!KANBAN_COLUMNS.includes(toStatus)) {
        return { ok: false, error: `Invalid status: ${toStatus}`, statusCode: 400 };
      }

      const result = applyTransition({
        projectId,
        epicId: item.id,
        fromStatus,
        toStatus,
        actor: ctx.actor,
        source: ctx.source,
        validateOnly: true,
      });
      if (!result.valid) {
        return {
          ok: false,
          error: result.error ?? `Cannot move from ${fromStatus} to ${toStatus}.`,
          statusCode: 400,
        };
      }
      statusChanges.push({ epicId: item.id, from: fromStatus, to: toStatus });
    }
  }

  // Use a transaction for atomic reorder.
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
      actor: ctx.actor,
      source: ctx.source,
      reason: ctx.reason,
      // No sessionId on purpose: applyTransition treats it as the engine's
      // owning-session exemption input, not as provenance, and no reorder
      // caller owns the ticket it is moving.
    });
    if (!result.valid) {
      return {
        ok: false,
        error:
          result.error ??
          `Cannot move from ${change.from} to ${change.to}.`,
        statusCode: 409,
      };
    }
  }

  return { ok: true, updated: validItems.length };
}
