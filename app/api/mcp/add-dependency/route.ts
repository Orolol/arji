/**
 * POST /api/mcp/add-dependency — the mcp__arij__add_dependency tool.
 *
 * Part of the refinement toolset: the agent completes or adjusts the
 * dependency graph while re-passing the board. The guardrail is asymmetric:
 * the DEPENDENT ticket must sit in Backlog / To do because it is the row
 * being written to, while the prerequisite may be in any column of the
 * project — see the inline note below for why. The DAG validation — no
 * cycles, no cross-project edges, no self-edges — is the existing shared
 * dependency helper, not a second implementation.
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
import { createDependencies } from "@/lib/dependencies/crud";
import { CycleError } from "@/lib/dependencies/validation";
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
  const auth = requireMcpToken(request, "add_dependency");
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "add_dependency");
  if (agentOnly) return agentOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  if (body.ticket_id === body.depends_on_ticket_id) {
    return NextResponse.json(
      {
        error: "A ticket cannot depend on itself.",
        code: "SELF_DEPENDENCY",
      },
      { status: 400 }
    );
  }

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

  let created: ReturnType<typeof createDependencies>;
  try {
    created = createDependencies(auth.projectId, [
      { ticketId: epic.id, dependsOnTicketId: dependsOn.id },
    ]);
  } catch (error) {
    if (error instanceof CycleError) {
      return NextResponse.json(
        {
          error: `Adding ${ticketLabel(epic)} → ${ticketLabel(dependsOn)} would create a dependency cycle.`,
          code: "DEPENDENCY_CYCLE",
        },
        { status: 400 }
      );
    }
    throw error;
  }

  // Re-adding an edge that already exists is a no-op; journalling it would
  // put a decision entry on the ticket for a change that did not happen.
  if (created.length === 0) {
    return NextResponse.json({
      data: {
        ticketId: epic.id,
        dependsOnTicketId: dependsOn.id,
        created: false,
      },
    });
  }

  // A same-state decision entry on the dependent ticket: the edge the agent
  // added and why.
  logWorkflowDecision({
    projectId: auth.projectId,
    epicId: epic.id,
    status: epic.status ?? "backlog",
    actor: "agent",
    reason: `Now depends on ${ticketLabel(dependsOn)} — ${body.reason}`,
    sessionId: auth.sessionId,
  });

  recordRefinementChange(auth, {
    kind: "dependency_added",
    ticketId: epic.id,
    label: ticketLabel(epic),
    detail: `now depends on ${ticketLabel(dependsOn)}`,
    reason: body.reason,
  });

  tryExportArjiJson(auth.projectId);

  return NextResponse.json({
    data: {
      ticketId: epic.id,
      dependsOnTicketId: dependsOn.id,
      created: true,
    },
  });
}
