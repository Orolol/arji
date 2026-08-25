/**
 * Agent-scoped bug creation.
 *
 * The MCP route delegates here so the handler stays an auth/validation
 * boundary. The actual ticket is created by the canonical epics HTTP route,
 * exactly like board/chat creation: readable-id allocation, ticket-created
 * SSE and arji.json export therefore remain owned by that route.
 */

import { and, eq, like, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, ticketActivityLog } from "@/lib/db/schema";
import type { McpTokenRecord } from "@/lib/mcp/token-store";
import { logTransition } from "@/lib/workflow/log";
import {
  MAX_MCP_BUGS_PER_SESSION,
  MCP_CREATE_BUG_ACTIVITY_PREFIX,
  type McpBugSeverity,
} from "./create-bug-contract";

const SEVERITY_PRIORITY: Record<McpBugSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

interface CreateBugInput {
  title: string;
  description: string;
  severity?: McpBugSeverity;
  sourceTicketId?: string;
}

interface CreateBugOptions {
  auth: McpTokenRecord;
  input: CreateBugInput;
  origin: string;
  signal?: AbortSignal;
}

interface CreatedBug {
  id: string;
  readableId: string | null;
  title: string;
  status: string;
  type: "bug";
  priority: number;
}

export type CreateBugFromMcpResult =
  | {
      ok: true;
      bug: CreatedBug;
      source: {
        sessionId: string;
        ticketId: string | null;
        storyId: string | null;
      };
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      existingBug?: Pick<CreatedBug, "id" | "readableId" | "title" | "status">;
    };

/**
 * Case-, accent-, punctuation- and whitespace-insensitive title key. This is
 * intentionally conservative: only equal normalized titles are duplicates;
 * fuzzy edit-distance matching would create surprising false positives.
 */
export function normalizeBugTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function findOpenDuplicate(projectId: string, title: string) {
  const titleKey = normalizeBugTitle(title);
  const candidates = db
    .select({
      id: epics.id,
      readableId: epics.readableId,
      title: epics.title,
      status: epics.status,
    })
    .from(epics)
    .where(
      and(
        eq(epics.projectId, projectId),
        eq(epics.type, "bug"),
        notInArray(epics.status, ["done", "released"]),
      ),
    )
    .all();

  const candidate =
    candidates.find((row) => normalizeBugTitle(row.title) === titleKey) ?? null;
  return candidate ? { ...candidate, status: candidate.status ?? "backlog" } : null;
}

function countSessionCreatedBugs(sessionId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(ticketActivityLog)
    .where(
      and(
        eq(ticketActivityLog.sessionId, sessionId),
        eq(ticketActivityLog.actor, "agent"),
        like(ticketActivityLog.reason, `${MCP_CREATE_BUG_ACTIVITY_PREFIX}%`),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

function resolveSourceTicket(auth: McpTokenRecord, explicitRef?: string) {
  const ref = explicitRef?.trim() || auth.epicId;
  if (!ref) return null;

  return (
    db
      .select({ id: epics.id, readableId: epics.readableId })
      .from(epics)
      .where(
        and(
          eq(epics.projectId, auth.projectId),
          or(eq(epics.id, ref), sql`lower(${epics.readableId}) = lower(${ref})`),
        ),
      )
      .get() ?? null
  );
}

function upstreamErrorBody(value: unknown): { error?: string; code?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  return {
    error: typeof body.error === "string" ? body.error : undefined,
    code: typeof body.code === "string" ? body.code : undefined,
  };
}

/** Create one standalone, non-blocking bug ticket in the token's project. */
export async function createBugFromMcp({
  auth,
  input,
  origin,
  signal,
}: CreateBugOptions): Promise<CreateBugFromMcpResult> {
  const sourceTicket = resolveSourceTicket(auth, input.sourceTicketId);
  if (input.sourceTicketId && !sourceTicket) {
    return {
      ok: false,
      status: 404,
      code: "SOURCE_TICKET_NOT_FOUND",
      error: "Source ticket not found in this session's project.",
    };
  }

  const duplicate = findOpenDuplicate(auth.projectId, input.title);
  if (duplicate) {
    return {
      ok: false,
      status: 409,
      code: "DUPLICATE_BUG",
      error: `An open bug with the same normalized title already exists: ${duplicate.readableId ?? duplicate.id}.`,
      existingBug: duplicate,
    };
  }

  if (countSessionCreatedBugs(auth.sessionId) >= MAX_MCP_BUGS_PER_SESSION) {
    return {
      ok: false,
      status: 429,
      code: "BUG_CREATION_LIMIT_REACHED",
      error: `This session has reached the limit of ${MAX_MCP_BUGS_PER_SESSION} created bugs.`,
    };
  }

  const priority = input.severity ? SEVERITY_PRIORITY[input.severity] : 2;
  let response: Response;
  try {
    response = await fetch(
      `${origin}/api/projects/${encodeURIComponent(auth.projectId)}/epics`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          type: "bug",
          priority,
          status: "backlog",
        }),
        signal,
      },
    );
  } catch (error) {
    return {
      ok: false,
      status: 502,
      code: "CANONICAL_CREATE_UNAVAILABLE",
      error:
        error instanceof Error
          ? `Canonical ticket creation failed: ${error.message}`
          : "Canonical ticket creation failed.",
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // The status-based fallback below remains useful for a non-JSON response.
  }

  if (!response.ok) {
    const upstream = upstreamErrorBody(payload);
    return {
      ok: false,
      status: response.status,
      code: upstream.code ?? "CANONICAL_CREATE_REJECTED",
      error: upstream.error ?? `Canonical ticket creation failed (${response.status}).`,
    };
  }

  const raw =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { data?: unknown }).data
      : null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      status: 502,
      code: "INVALID_CANONICAL_RESPONSE",
      error: "Canonical ticket creation returned an invalid response.",
    };
  }

  const created = raw as Record<string, unknown>;
  if (typeof created.id !== "string" || !created.id) {
    return {
      ok: false,
      status: 502,
      code: "INVALID_CANONICAL_RESPONSE",
      error: "Canonical ticket creation returned no ticket id.",
    };
  }

  const bug: CreatedBug = {
    id: created.id,
    readableId: typeof created.readableId === "string" ? created.readableId : null,
    title: typeof created.title === "string" ? created.title : input.title,
    status: typeof created.status === "string" ? created.status : "backlog",
    type: "bug",
    priority: typeof created.priority === "number" ? created.priority : priority,
  };

  const sourceRef = sourceTicket?.readableId ?? sourceTicket?.id ?? "project-scoped session";
  const storyRef = auth.userStoryId ? `; source story ${auth.userStoryId}` : "";
  logTransition({
    projectId: auth.projectId,
    epicId: bug.id,
    fromStatus: bug.status,
    toStatus: bug.status,
    actor: "agent",
    sessionId: auth.sessionId,
    reason: `${MCP_CREATE_BUG_ACTIVITY_PREFIX} reported from ${sourceRef}${storyRef}; source session ${auth.sessionId}`,
  });

  return {
    ok: true,
    bug,
    source: {
      sessionId: auth.sessionId,
      ticketId: sourceTicket?.id ?? null,
      storyId: auth.userStoryId,
    },
  };
}
