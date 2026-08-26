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
  try {
    const result = reorderTickets(auth.projectId, items, {
      actor: "agent",
      source: "refinement",
      reason: body.reason,
      onlyFromStatuses: REFINEMENT_STATUSES,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.statusCode }
      );
    }
    updated = result.updated;
  } catch (error) {
    return errorResponse(error, "Failed to reorder tickets");
  }

  // One same-state decision entry per touched ticket — where the agent
  // moved it and why.
  for (const item of items) {
    logWorkflowDecision({
      projectId: auth.projectId,
      epicId: item.id,
      status: item.status,
      actor: "agent",
      reason: `Reordered to position ${item.position} in ${item.status} — ${body.reason}`,
      sessionId: auth.sessionId,
    });
  }

  tryExportArjiJson(auth.projectId);

  return NextResponse.json({ data: { updated, tickets: labels } });
}
