/**
 * Shared request helpers for the /api/mcp/* routes.
 *
 * Two invariants every MCP route relies on:
 *
 * 1. `requireMcpToken` — the ONLY way a request authenticates. The bearer
 *    token resolves to the spawning session's identity; there is no cookie,
 *    header, or body fallback.
 * 2. `resolveTicketForToken` — the ONLY way a request picks a ticket. An
 *    explicit `ticket_id` must live in the token's project (cross-project ids
 *    404, same as the getEpicOr404 scoping rule in lib/api/route-helpers.ts);
 *    otherwise the token's own epic is used. The body never widens scope.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, epics } from "@/lib/db/schema";
import { resolveMcpToken, type McpTokenRecord } from "./token-store";

import { parseRefinementActions, refinementToolAllowed } from "@/lib/refinement/options";

type Epic = typeof epics.$inferSelect;

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Resolve an MCP bearer when one is present, without turning absence into an
 * HTTP error. Canonical UI routes use this only for optional, authenticated
 * provenance metadata; /api/mcp routes must keep using requireMcpToken.
 */
export function resolveOptionalMcpToken(
  request: Request
): McpTokenRecord | null {
  const header = request.headers.get("authorization") ?? "";
  const token = BEARER_PATTERN.exec(header)?.[1]?.trim();
  return token ? resolveMcpToken(token) : null;
}

/**
 * Authenticate an MCP request from its `Authorization: Bearer` header.
 * Returns the token record, or a ready-to-return 401 response for missing,
 * unknown, and revoked tokens alike (indistinguishable on purpose).
 */
export function requireMcpToken(
  request: Request
): McpTokenRecord | NextResponse {
  const record = resolveOptionalMcpToken(request);
  if (!record) {
    return NextResponse.json(
      { error: "Invalid or expired MCP token", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }
  if (record.agentType === "refinement") {
    const session = db.select({ actions: agentSessions.refinementActions })
      .from(agentSessions).where(eq(agentSessions.id, record.sessionId)).get();
    const tool = new URL(request.url).pathname.split("/").filter(Boolean).pop()?.replaceAll("-", "_") ?? "";
    if (session?.actions != null && !refinementToolAllowed(parseRefinementActions(session.actions), tool)) {
      return NextResponse.json({
        error: `${tool} is not enabled for this refinement pass.`,
        code: "REFINEMENT_ACTION_DISABLED",
      }, { status: 403 });
    }
  }
  return record;
}

/**
 * Resolve the ticket an MCP call targets.
 *
 * - With `ticketId`: the epic must exist in the token's project — otherwise
 *   404 TICKET_NOT_FOUND (also covers ids from other projects; they must not
 *   resolve).
 * - Without: defaults to the token's own epic; sessions launched without a
 *   ticket get 400 MISSING_TICKET.
 */
export function resolveTicketForToken(
  record: McpTokenRecord,
  ticketId?: string
): { epic: Epic } | NextResponse {
  const targetId = ticketId ?? record.epicId;
  if (!targetId) {
    return NextResponse.json(
      {
        error:
          "This session is not attached to a ticket. Pass ticket_id to target a ticket in the project.",
        code: "MISSING_TICKET",
      },
      { status: 400 }
    );
  }

  const epic = db
    .select()
    .from(epics)
    .where(and(eq(epics.id, targetId), eq(epics.projectId, record.projectId)))
    .get();

  if (!epic) {
    return NextResponse.json(
      { error: "Ticket not found in this session's project", code: "TICKET_NOT_FOUND" },
      { status: 404 }
    );
  }

  return { epic };
}
