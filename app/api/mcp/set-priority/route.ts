/**
 * POST /api/mcp/set-priority — the mcp__arij__set_priority tool.
 *
 * Part of the refinement toolset: an agent re-prioritises a ticket during a
 * board re-pass. The write is scoped to Backlog / To do tickets (the
 * refinement guardrail) and leaves an activity-log entry carrying the
 * agent's justification, so the ticket records why it changed.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  refinementReasonSchema,
  requireAgentSessionToken,
  resolveRefinementTicket,
} from "@/lib/mcp/refinement";
import { logWorkflowDecision } from "@/lib/workflow/transition-service";
import { tryExportArjiJson } from "@/lib/sync/export";

const bodySchema = z
  .object({
    ticket_id: z.string().min(1),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    reason: refinementReasonSchema,
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "set_priority");
  if (agentOnly) return agentOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveRefinementTicket(auth.projectId, body.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const oldPriority = epic.priority ?? 0;
  if (oldPriority === body.priority) {
    return NextResponse.json({
      data: { ticketId: epic.id, priority: body.priority, changed: false },
    });
  }

  db.update(epics)
    .set({ priority: body.priority, updatedAt: new Date().toISOString() })
    .where(eq(epics.id, epic.id))
    .run();

  // Same-state decision entry: the trace of why the agent made the change.
  logWorkflowDecision({
    projectId: auth.projectId,
    epicId: epic.id,
    status: epic.status ?? "backlog",
    actor: "agent",
    reason: `Priority ${oldPriority} → ${body.priority} — ${body.reason}`,
    sessionId: auth.sessionId,
  });

  // Every other mutating route mirrors the board into arji.json; a priority
  // set through the agent tool channel must not leave the export stale.
  tryExportArjiJson(auth.projectId);

  return NextResponse.json({
    data: {
      ticketId: epic.id,
      oldPriority,
      priority: body.priority,
      changed: true,
    },
  });
}
