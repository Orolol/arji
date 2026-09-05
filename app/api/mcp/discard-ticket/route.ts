/**
 * POST /api/mcp/discard-ticket — the mcp__arij__discard_ticket tool.
 *
 * The refinement pass's answer to a ticket that is no longer worth doing:
 * the board has drifted, the feature shipped another way, the bug is not
 * reproducible any more. Arij has no archived column, so the row is deleted
 * for real — which is why this route is the most heavily guarded of the
 * refinement toolset:
 *
 *   - refinement agent type only (`requireRefinementSessionToken`): a build
 *     or review session deleting Backlog tickets is a runaway;
 *   - Backlog / To do only, like every refinement write;
 *   - refused for a ticket carrying agent session history — deleting it
 *     would take the transcripts and usage figures with it
 *     (lib/refinement/retire.ts);
 *   - refused while another planning ticket depends on it, because dropping
 *     that edge silently unblocks work whose prerequisite never happened.
 *     The agent is told to call `remove_dependency` first, which forces the
 *     unblocking to carry its own justification;
 *   - and it leaves a tombstone: the ticket's full text is captured before
 *     the delete and published in the end-of-run recap comment and the
 *     notification, so the user can retype it if they disagree.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  refinementReasonSchema,
  requireAgentSessionToken,
  requireRefinementSessionToken,
  resolveRefinementTicket,
  ticketLabel,
} from "@/lib/mcp/refinement";
import { tryExportArjiJson } from "@/lib/sync/export";
import { recordRefinementChange } from "@/lib/refinement/registry";
import {
  captureTicketSnapshot,
  formatTicketSnapshot,
  retireTicket,
  ticketDependents,
  ticketRetirementGuard,
} from "@/lib/refinement/retire";

const bodySchema = z
  .object({
    ticket_id: z.string().min(1),
    reason: refinementReasonSchema,
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "discard_ticket");
  if (agentOnly) return agentOnly;
  const refinementOnly = requireRefinementSessionToken(auth, "discard_ticket");
  if (refinementOnly) return refinementOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveRefinementTicket(auth.projectId, body.ticket_id);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const historyGuard = ticketRetirementGuard(epic, "discard_ticket");
  if (historyGuard) return historyGuard;

  const dependents = ticketDependents(auth.projectId, epic.id);
  if (dependents.length > 0) {
    return NextResponse.json(
      {
        error: `${dependents.map(ticketLabel).join(", ")} still depend${dependents.length === 1 ? "s" : ""} on ${ticketLabel(epic)}. Remove those edges with remove_dependency first — deleting the ticket underneath them would unblock work whose prerequisite never happened.`,
        code: "TICKET_HAS_DEPENDENTS",
      },
      { status: 409 }
    );
  }

  // Read the whole ticket while it still exists: after `retireTicket` this
  // text is the only copy anywhere.
  const snapshot = captureTicketSnapshot(auth.projectId, epic);

  // No activity-log entry: `ticket_activity_log.epic_id` cascades on delete,
  // so a row written here would be erased by the very delete it records.
  // The tombstone below is the durable trace instead.
  retireTicket(auth.projectId, epic.id);

  recordRefinementChange(auth, {
    kind: "discarded",
    ticketId: epic.id,
    label: snapshot.label,
    detail: `deleted — "${snapshot.title}"`,
    reason: body.reason,
    ticketGone: true,
    snapshot: formatTicketSnapshot(snapshot),
  });

  tryExportArjiJson(auth.projectId);

  return NextResponse.json({
    data: {
      ticketId: epic.id,
      ticket: snapshot.label,
      title: snapshot.title,
      deleted: true,
      storiesDeleted: snapshot.stories.length,
    },
  });
}
