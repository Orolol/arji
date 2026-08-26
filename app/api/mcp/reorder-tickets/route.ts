/**
 * POST /api/mcp/reorder-tickets — the mcp__arij__reorder_tickets tool.
 *
 * Part of the refinement toolset: the agent re-ranks the execution queue
 * inside a column. Pure position moves — column changes go through
 * promote_ticket, so the workflow engine stays the only thing that moves a
 * ticket between columns. Both the guard (Backlog / To do only) and the
 * transactional position write come from the shared core the board's
 * drag-and-drop route uses, so agent ordering and drag ordering can never
 * drift apart.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  REFINEMENT_STATUSES,
  refinementReasonSchema,
  requireAgentSessionToken,
  resolveRefinementTicket,
  ticketLabel,
} from "@/lib/mcp/refinement";
import { reorderTickets, type ReorderItemInput } from "@/lib/workflow/reorder";
import { logWorkflowDecision } from "@/lib/workflow/transition-service";
import { tryExportArjiJson } from "@/lib/sync/export";
import { recordRefinementChange } from "@/lib/refinement/registry";

const bodySchema = z
  .object({
    items: z
      .array(
        z.object({
          ticket_id: z.string().min(1),
          position: z.number().int().min(0),
        })
      )
      .min(1)
      .max(200),
    reason: refinementReasonSchema,
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "reorder_tickets");
  if (agentOnly) return agentOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  // One id twice would make the resulting order depend on which entry the
  // transaction happened to write last — reject rather than pick a winner.
  const seen = new Set<string>();
  const seenPositions = new Set<number>();
  for (const item of body.items) {
    if (seen.has(item.ticket_id)) {
      return NextResponse.json(
        {
          error: `Ticket ${item.ticket_id} appears more than once in the reorder request.`,
          code: "DUPLICATE_TICKET",
        },
        { status: 400 }
      );
    }
    seen.add(item.ticket_id);

    // Two tickets asking for the same rank is the same defect as a repeated
    // id: the board sorts on `position` and breaks ties by fetch order, and
    // the execution queue is derived from that — so a colliding ranking
    // silently decides which ticket is "next".
    if (seenPositions.has(item.position)) {
      return NextResponse.json(
        {
          error: `Position ${item.position} is requested by more than one ticket. Every ticket in the batch needs a distinct rank.`,
          code: "DUPLICATE_POSITION",
        },
        { status: 400 }
      );
    }
    seenPositions.add(item.position);
  }

  // Resolve every target and guard each one: refinement only touches
  // Backlog and To do, and a reorder never changes status.
  const items: ReorderItemInput[] = [];
  const labels: string[] = [];
  for (const item of body.items) {
    const found = resolveRefinementTicket(auth.projectId, item.ticket_id);
    if (isErrorResponse(found)) return found;
    const { epic } = found;
    items.push({
      id: epic.id,
      status: epic.status ?? "backlog",
      position: item.position,
    });
    labels.push(ticketLabel(epic));
  }

  let updated = 0;
  let skipped = 0;
  let updatedIds: string[] = [];
  try {
    const result = reorderTickets(auth.projectId, items, {
      actor: "agent",
      source: "refinement",
      reason: body.reason,
      // Positions only. The status passed for each item is the one just
      // read above, so this is the guard for the window between that read
      // and this write: a ticket that moved column in between is skipped
      // rather than dragged back into the column the agent saw it in.
      reorderOnly: true,
      onlyFromStatuses: REFINEMENT_STATUSES,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.statusCode }
      );
    }
    updated = result.updated;
    skipped = result.skipped;
    updatedIds = result.updatedIds;
  } catch (error) {
    return errorResponse(error, "Failed to reorder tickets");
  }

  // One same-state decision entry per ticket that was ACTUALLY written.
  // Journalling the skipped ones too would put "Reordered to position N" in
  // the activity log of a ticket that never moved, and would over-count the
  // end-of-run report.
  const written = new Set(updatedIds);
  items.forEach((item, index) => {
    if (!written.has(item.id)) return;
    logWorkflowDecision({
      projectId: auth.projectId,
      epicId: item.id,
      status: item.status,
      actor: "agent",
      reason: `Reordered to position ${item.position} in ${item.status} — ${body.reason}`,
      sessionId: auth.sessionId,
    });
    recordRefinementChange(auth, {
      kind: "reordered",
      ticketId: item.id,
      label: labels[index],
      detail: `${item.status} position ${item.position}`,
      reason: body.reason,
    });
  });

  tryExportArjiJson(auth.projectId);

  return NextResponse.json({ data: { updated, skipped, tickets: labels } });
}
