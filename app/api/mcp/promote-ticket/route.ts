/**
 * POST /api/mcp/promote-ticket — the mcp__arij__promote_ticket tool.
 *
 * The one refinement tool that changes a ticket's column: Backlog → To do
 * when the work is ready to be picked up, and To do → Backlog when it is
 * not. Both directions run through the shared transition service with
 * `source: "refinement"`, which is what makes the guardrail real — the
 * workflow engine refuses that source anywhere outside the two planning
 * columns, so this route cannot promote something out of Review or Done
 * even if it is asked to.
 *
 * A demotion is the agent saying "this is not ready". The tool therefore
 * requires the missing question alongside the justification and posts it as
 * a ticket comment, so the ticket lands back in Backlog carrying the reason
 * it went there rather than silently losing its place in the queue.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { and, eq, max, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, ticketComments } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  refinementReasonSchema,
  requireAgentSessionToken,
  resolveRefinementTicket,
  ticketLabel,
} from "@/lib/mcp/refinement";
import { applyTransition } from "@/lib/workflow/transition-service";
import type { KanbanStatus } from "@/lib/types/kanban";
import { tryExportArjiJson } from "@/lib/sync/export";
import { recordRefinementChange } from "@/lib/refinement/registry";

const bodySchema = z
  .object({
    ticket_id: z.string().min(1),
    status: z.enum(["backlog", "todo"]),
    reason: refinementReasonSchema,
    /**
     * Required when demoting: the question that has to be answered before
     * the ticket is ready. Posted as a comment on the ticket.
     */
    question: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "promote_ticket");
  if (agentOnly) return agentOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveRefinementTicket(auth.projectId, body.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const fromStatus = (epic.status ?? "backlog") as KanbanStatus;
  const toStatus = body.status as KanbanStatus;

  if (fromStatus === toStatus) {
    return NextResponse.json({
      data: { ticketId: epic.id, status: toStatus, changed: false },
    });
  }

  const demoting = toStatus === "backlog";
  if (demoting && !body.question) {
    return NextResponse.json(
      {
        error:
          "Sending a ticket back to Backlog requires `question` — the missing answer that makes it not ready.",
        code: "MISSING_QUESTION",
      },
      { status: 400 }
    );
  }

  const result = applyTransition({
    projectId: auth.projectId,
    epicId: epic.id,
    fromStatus,
    toStatus,
    actor: "agent",
    source: "refinement",
    reason: `Refinement re-pass — ${body.reason}`,
    // Deliberately no sessionId: that field is the engine's owning-session
    // exemption input, and a refinement session owns no ticket. The
    // provenance a refinement write needs is the actor and the reason.
  });

  if (!result.valid) {
    return NextResponse.json(
      { error: result.error, code: "TRANSITION_REFUSED" },
      { status: 409 }
    );
  }

  // `position` is a per-column 0-based index, and the transition service does
  // not touch it — so without this the ticket arrives in its new column still
  // carrying the index it held in the old one, colliding with whatever sits
  // there. The board breaks that tie by fetch order and the execution queue
  // is derived from it, so a promoted ticket could silently take rank #1.
  //
  // Appending is the honest default: newly ready work queues behind what is
  // already ranked until the agent (or the user) ranks it deliberately.
  const position = appendPosition(auth.projectId, toStatus, epic.id);
  db.update(epics)
    .set({ position, updatedAt: new Date().toISOString() })
    .where(eq(epics.id, epic.id))
    .run();

  // The demotion's missing question, on the ticket, attributed to the run.
  if (demoting && body.question) {
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId: epic.id,
        author: "agent",
        content: `**Sent back to Backlog by the refinement re-pass.**\n\n${body.reason}\n\n**Open question:** ${body.question}`,
        agentSessionId: auth.sessionId,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  recordRefinementChange(auth, {
    kind: demoting ? "demoted" : "promoted",
    ticketId: epic.id,
    label: ticketLabel(epic),
    detail: demoting
      ? `sent back to Backlog — ${body.question ?? ""}`.trim()
      : "promoted to To do",
    reason: body.reason,
  });

  tryExportArjiJson(auth.projectId);

  return NextResponse.json({
    data: {
      ticketId: epic.id,
      ticket: ticketLabel(epic),
      fromStatus,
      status: toStatus,
      changed: true,
    },
  });
}

/**
 * The next free position at the bottom of a column.
 *
 * The moving ticket is excluded: this runs after the transition committed, so
 * it already sits in the destination column carrying its stale index, and
 * counting it would push the result past the real tail for no reason. An
 * empty destination yields 0.
 */
function appendPosition(
  projectId: string,
  status: KanbanStatus,
  excludeEpicId: string,
): number {
  const row = db
    .select({ highest: max(epics.position) })
    .from(epics)
    .where(
      and(
        eq(epics.projectId, projectId),
        eq(epics.status, status),
        ne(epics.id, excludeEpicId),
      ),
    )
    .get();
  return (row?.highest ?? -1) + 1;
}
