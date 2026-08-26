/**
 * POST /api/mcp/remove-dependency — the mcp__arij__remove_dependency tool.
 *
 * Part of the refinement toolset: the agent prunes stale dependency edges
 * while re-passing the board. The guardrail is asymmetric: the DEPENDENT
 * ticket must sit in Backlog / To do because it is the row being written to,
 * while the prerequisite may be in any column — pruning an edge to work that
 * has since shipped is exactly what this tool is for. Removing an edge that
 * is not there is a reported no-op the agent can move past rather than an
 * error.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  getProjectTicket,
  refinementReasonSchema,
  requireAgentSessionToken,
  resolveRefinementTicket,
  ticketLabel,
} from "@/lib/mcp/refinement";
import { deleteDependencyEdge } from "@/lib/dependencies/crud";
import { logWorkflowDecision } from "@/lib/workflow/transition-service";
import { tryExportArjiJson } from "@/lib/sync/export";
import { recordRefinementChange } from "@/lib/refinement/registry";

const bodySchema = z
  .object({
    ticket_id: z.string().min(1),
    depends_on_ticket_id: z.string().min(1),
    reason: refinementReasonSchema,
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "remove_dependency");
  if (agentOnly) return agentOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveRefinementTicket(auth.projectId, body.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  // Only the DEPENDENT ticket is held to the Backlog/To do guardrail: it is
  // the row being written to and the one that gets the activity-log entry.
  // The prerequisite is merely referenced — neither creating nor deleting an
  // edge touches it — so requiring it to be in the planning columns would
  // block the most ordinary dependency there is ("this Backlog ticket builds
  // on the epic already in Review") and would make an edge pointing at
  // shipped work permanently unprunable. The snapshot deliberately shows
  // those endpoints to the agent, so the tools must accept them.
  const dependsOn = getProjectTicket(auth.projectId, body.depends_on_ticket_id);
  if (!dependsOn) {
    return NextResponse.json(
      {
        error: "Ticket not found in this session's project",
        code: "TICKET_NOT_FOUND",
      },
      { status: 404 }
    );
  }

  const removed = deleteDependencyEdge(auth.projectId, epic.id, dependsOn.id);

  // Only journal a decision when an edge was actually removed.
  if (removed > 0) {
    logWorkflowDecision({
      projectId: auth.projectId,
      epicId: epic.id,
      status: epic.status ?? "backlog",
      actor: "agent",
      reason: `No longer depends on ${ticketLabel(dependsOn)} — ${body.reason}`,
      sessionId: auth.sessionId,
    });
    recordRefinementChange(auth, {
      kind: "dependency_removed",
      ticketId: epic.id,
      label: ticketLabel(epic),
      detail: `no longer depends on ${ticketLabel(dependsOn)}`,
      reason: body.reason,
    });
    tryExportArjiJson(auth.projectId);
  }

  return NextResponse.json({
    data: {
      ticketId: epic.id,
      dependsOnTicketId: dependsOn.id,
      removed: removed > 0,
    },
  });
}
