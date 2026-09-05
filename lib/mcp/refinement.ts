/**
 * Shared guardrails for the refinement MCP tools (set-priority,
 * reorder-tickets, add-dependency, remove-dependency, promote-ticket,
 * merge-tickets, discard-ticket, create-planning-ticket).
 *
 * Refinement is a re-pass over the planning half of the board: it may only
 * touch the Backlog and To do columns — never in progress, review, done or
 * released. Three layers enforce that, deliberately:
 *
 *   1. the workflow engine refuses any `source: "refinement"` transition
 *      that leaves the two planning columns (lib/workflow/engine.ts) — the
 *      authority, since it covers every caller;
 *   2. these route helpers reject out-of-scope tickets before any write,
 *      so the agent gets a precise 409 instead of a transition refusal;
 *   3. the prompt tells the agent the rule, which is guidance, not a guard.
 *
 * Every refinement write also requires a non-empty justification. The board
 * is user-owned: a ticket that moved because an agent decided so must carry
 * why, in its own activity log.
 *
 * The three tools that CREATE or DESTROY board rows carry a fourth layer:
 * `requireRefinementSessionToken` narrows them to the refinement agent type,
 * where the other five are open to any non-chat session. See its comment.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { REFINEMENT_AGENT_TYPE } from "@/lib/refinement/constants";
import type { McpTokenRecord } from "./token-store";

type Epic = typeof epics.$inferSelect;

/** The columns a refinement re-pass is allowed to read and write. */
export const REFINEMENT_STATUSES = ["backlog", "todo"] as const;

export type RefinementStatus = (typeof REFINEMENT_STATUSES)[number];

export function isRefinementStatus(
  status: string | null | undefined
): status is RefinementStatus {
  return (REFINEMENT_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * The mandatory justification carried by every refinement tool call.
 *
 * Required, not optional: the acceptance contract for these tools is that a
 * ticket the agent reshaped explains itself in `ticket_activity_log`. A
 * blank string is rejected by `.min(1)` after trimming at the route.
 */
export const refinementReasonSchema = z
  .string()
  .trim()
  .min(1, "A justification is required — it is recorded in the ticket activity log.")
  .max(500);

/** A project-scoped ticket lookup for an explicit ticket id. */
export function getProjectTicket(
  projectId: string,
  ticketId: string
): Epic | undefined {
  return db
    .select()
    .from(epics)
    .where(and(eq(epics.id, ticketId), eq(epics.projectId, projectId)))
    .get();
}

/**
 * 409 when the ticket sits outside the columns refinement may touch;
 * null when the ticket is in scope.
 */
export function refinementStatusGuard(epic: Epic): NextResponse | null {
  const status = epic.status ?? "backlog";
  if (isRefinementStatus(status)) return null;
  return NextResponse.json(
    {
      error: `${epic.readableId ?? epic.id} is in the ${status} column — refinement only touches Backlog and To do.`,
      code: "REFINEMENT_STATUS_LOCKED",
    },
    { status: 409 }
  );
}

/**
 * 403 for chat tokens; null for agent-session tokens.
 *
 * The story scopes these tools to non-chat session tokens, and the split
 * matters: a chat turn is an unattended conversational context with no
 * durable session row, so letting one reshape the execution queue would put
 * board writes behind an unaudited channel. Mirrors the agent-only boundary
 * on submit_findings / submit_grading.
 */
export function requireAgentSessionToken(
  auth: McpTokenRecord,
  toolName: string
): NextResponse | null {
  if (auth.agentType !== "chat") return null;
  return NextResponse.json(
    {
      error: `${toolName} is only available to agent sessions.`,
      code: "AGENT_ONLY",
    },
    { status: 403 }
  );
}

/**
 * 403 for any session that is not a board-refinement pass; null otherwise.
 *
 * A STRICTER boundary than `requireAgentSessionToken`, for the three tools
 * that destroy or create board rows (`merge_tickets`, `discard_ticket`,
 * `create_planning_ticket`). The other refinement tools reshape a ticket a
 * build or review session could also legitimately be asked about — a
 * priority, an edge, a column inside the planning half. These do not: a
 * build session that deletes a Backlog ticket, or invents new ones while it
 * is meant to be writing code, is a runaway, not a re-pass.
 *
 * `allowedToolNamesForAgentType` withholds these tools from every other
 * agent type's allowlist, but an allowlist only shapes what a model reaches
 * for — and only claude-code consumes it at all. This is the guard.
 */
export function requireRefinementSessionToken(
  auth: McpTokenRecord,
  toolName: string
): NextResponse | null {
  if (auth.agentType === REFINEMENT_AGENT_TYPE) return null;
  return NextResponse.json(
    {
      error: `${toolName} is only available to a board refinement pass.`,
      code: "REFINEMENT_ONLY",
    },
    { status: 403 }
  );
}

/**
 * Resolve a ticket a refinement tool targets: project-scoped, and in one of
 * the columns refinement owns. Returns the epic, or the response to return.
 */
export function resolveRefinementTicket(
  projectId: string,
  ticketId: string
): { epic: Epic } | NextResponse {
  const epic = getProjectTicket(projectId, ticketId);
  if (!epic) {
    return NextResponse.json(
      {
        error: "Ticket not found in this session's project",
        code: "TICKET_NOT_FOUND",
      },
      { status: 404 }
    );
  }
  const guard = refinementStatusGuard(epic);
  if (guard) return guard;
  return { epic };
}

/** Human-facing ticket label for activity-log reasons and reports. */
export function ticketLabel(epic: Epic): string {
  return epic.readableId ?? epic.id;
}
