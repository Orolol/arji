/**
 * "Arij actions" — the compact, session-scoped list of structured effects an
 * agent run had on the Arij board, surfaced on the session detail page.
 *
 * Two sources feed the list:
 *
 *   1. Durable DB artifacts keyed by the session id — the authoritative
 *      source, provider-independent (the /api/mcp/* routes and the dispatch
 *      wrappers both write these):
 *        - ticket_activity_log rows (actor "agent")  -> status changes
 *        - ticket_comments rows (author "agent")     -> comments / questions /
 *                                                       review-findings summaries
 *   2. Arij MCP tool-call records parsed out of the session's raw chunk
 *      stream — the supplement. The Claude Code provider returns a single
 *      final envelope (no per-turn stream), so for it this list is usually
 *      empty; streaming providers surface read-only calls (get_ticket) and
 *      calls that left no durable artifact (e.g. a rejected status
 *      transition) through this channel. Each provider spells the call its
 *      own way: claude `tool_use` records named mcp__arij__*, codex records
 *      carrying `{ server: "arij", tool }`, and omp `write`s to
 *      `xd://mcp__arij_*` device paths (single-underscore spelling) whose
 *      results embed `{ serverName: "arij", mcpToolName }`.
 *
 * Merging dedupes by kind-count: a tool call whose kind already has a durable
 * artifact is considered "covered" and dropped, so a post_comment call and
 * its comment row never show up twice.
 */

import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { ticketActivityLog, ticketComments } from "@/lib/db/schema";
import { listSessionChunks } from "./chunks";

export const ARIJ_MCP_TOOL_PREFIX = "mcp__arij__";

/**
 * omp mounts MCP tools as xd:// devices and invokes them by `write`ing to
 * the device path — with its single-underscore tool spelling. Both the
 * invocation (`tool_execution_start` args) and the assistant's toolCall
 * echo carry the path; the execution result additionally embeds
 * `{ serverName: "arij", mcpToolName }` (see arijMcpToolName in
 * lib/claude/mcp-injection.ts for the spelling contract).
 */
const OMP_XD_ARIJ_PREFIX = "xd://mcp__arij_";

export type ArijActionKind =
  | "status_change"
  | "comment"
  | "question"
  | "findings"
  | "tool_call";

export interface ArijAction {
  kind: ArijActionKind;
  /** One-line human label ("Ticket moved in_progress → review"). */
  summary: string;
  /** Optional muted context (comment excerpt, transition reason, …). */
  detail?: string;
  /** ISO timestamp, or null when the source row carries none. */
  at: string | null;
}

export interface ArijToolCall {
  /** Bare tool name, whatever the provider's prefix (e.g. "get_ticket"). */
  tool: string;
  at: string | null;
}

/** Effectful tools mapped to the durable-artifact kind they produce. */
const TOOL_ARTIFACT_KIND: Record<string, ArijActionKind> = {
  update_ticket_status: "status_change",
  post_comment: "comment",
  ask_question: "question",
  submit_findings: "findings",
};

const QUESTION_HEADER = "**Question**";
const FINDINGS_HEADER_RE = /^\*\*Review findings(?: \(([^)]*)\))?\*\*/;
const EXCERPT_MAX = 160;

function excerpt(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > EXCERPT_MAX
    ? `${collapsed.slice(0, EXCERPT_MAX)}…`
    : collapsed;
}

function classifyAgentComment(content: string): ArijAction["kind"] {
  if (content.startsWith(QUESTION_HEADER)) return "question";
  if (FINDINGS_HEADER_RE.test(content)) return "findings";
  return "comment";
}

function commentToAction(content: string, at: string | null): ArijAction {
  const kind = classifyAgentComment(content);
  if (kind === "question") {
    return {
      kind,
      summary: "Asked the user a question",
      detail: excerpt(content.slice(QUESTION_HEADER.length)),
      at,
    };
  }
  if (kind === "findings") {
    const match = content.match(FINDINGS_HEADER_RE);
    const verdict = match?.[1]?.trim();
    return {
      kind,
      summary: verdict
        ? `Submitted review findings (${verdict})`
        : "Submitted review findings",
      detail: excerpt(content.slice(match?.[0].length ?? 0)),
      at,
    };
  }
  return { kind: "comment", summary: "Posted a comment", detail: excerpt(content), at };
}

// ---------------------------------------------------------------------------
// Chunk parsing
// ---------------------------------------------------------------------------

interface RawChunkLike {
  content: string;
  createdAt: string | null;
}

function collectToolNames(
  value: unknown,
  out: ArijToolCall[],
  seenIds: Set<string>,
  at: string | null,
  nearestId: string | null = null
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, out, seenIds, at, nearestId);
    return;
  }
  if (!value || typeof value !== "object") return;

  const obj = value as Record<string, unknown>;

  // The call id in scope for omp dedupe: an omp call surfaces as several
  // records (execution start, execution end, assistant toolCall echo) that
  // all share one id — carried as `toolCallId` on execution records and as
  // `id` on the toolCall object — while the arij evidence (xd:// path,
  // xdev inner) sits in NESTED objects. Threading the nearest ancestor id
  // down lets those nested matches collapse to a single entry.
  const ownId =
    typeof obj.toolCallId === "string"
      ? obj.toolCallId
      : typeof obj.id === "string"
        ? obj.id
        : null;
  const contextId = ownId ?? nearestId;

  // Claude stream-json shape: { type: "tool_use", id, name, input }
  if (
    obj.type === "tool_use" &&
    typeof obj.name === "string" &&
    obj.name.startsWith(ARIJ_MCP_TOOL_PREFIX)
  ) {
    const id = typeof obj.id === "string" ? obj.id : null;
    if (!id || !seenIds.has(id)) {
      if (id) seenIds.add(id);
      out.push({ tool: obj.name.slice(ARIJ_MCP_TOOL_PREFIX.length), at });
    }
  }

  // Codex-style shape: { ..., server: "arij", tool: "post_comment" }
  if (obj.server === "arij" && typeof obj.tool === "string") {
    out.push({ tool: obj.tool, at });
  }

  // omp shapes — one per record kind describing the same call:
  //   { ..., path: "xd://mcp__arij_<tool>", ... }         (invocation args)
  //   { serverName: "arij", mcpToolName: "<tool>", ... }  (execution result)
  const pushOmpCall = (tool: string) => {
    const key = contextId ? `omp:${contextId}` : null;
    if (key && seenIds.has(key)) return;
    if (key) seenIds.add(key);
    out.push({ tool, at });
  };
  if (
    typeof obj.path === "string" &&
    obj.path.startsWith(OMP_XD_ARIJ_PREFIX)
  ) {
    pushOmpCall(obj.path.slice(OMP_XD_ARIJ_PREFIX.length));
  }
  if (obj.serverName === "arij" && typeof obj.mcpToolName === "string") {
    pushOmpCall(obj.mcpToolName);
  }

  for (const child of Object.values(obj)) {
    collectToolNames(child, out, seenIds, at, contextId);
  }
}

/**
 * Parse Arij MCP tool calls (any provider's spelling) out of an ordered raw
 * chunk stream.
 *
 * Chunks are NDJSON-ish but chunk boundaries can fall mid-line, so lines are
 * reassembled across chunks; a line's timestamp is the timestamp of the chunk
 * that completed it. Non-JSON lines are skipped (codex human-readable output
 * never produces false positives — only parsed JSON is scanned). Duplicate
 * records of the same tool_use id (content_block_start + assistant message
 * echo) are deduped.
 */
export function extractArijToolCalls(chunks: RawChunkLike[]): ArijToolCall[] {
  const out: ArijToolCall[] = [];
  const seenIds = new Set<string>();
  let buffer = "";
  let at: string | null = null;

  const parseLine = (line: string, lineAt: string | null) => {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return;
    }
    try {
      collectToolNames(JSON.parse(trimmed), out, seenIds, lineAt);
    } catch {
      // partial or non-JSON line — skip
    }
  };

  for (const chunk of chunks) {
    buffer += chunk.content;
    at = chunk.createdAt;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) parseLine(line, at);
  }
  parseLine(buffer, at);

  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function compareAt(a: ArijAction, b: ArijAction): number {
  if (a.at === b.at) return 0;
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return a.at < b.at ? -1 : 1;
}

/**
 * Merge durable DB-derived actions with chunk-parsed tool calls into one
 * chronological list.
 *
 *   - get_ticket calls are read-only (no artifact) — always included.
 *   - Effectful calls already covered by an artifact of the same kind are
 *     dropped (count-based dedupe); the excess surfaces as "no recorded
 *     effect" entries, which is how rejected transitions become visible.
 *     Note the dispatch wrappers also log agent status changes, so a failed
 *     MCP move on a session that was auto-moved can be masked — acceptable
 *     for a v1 activity list.
 */
export function mergeArijActions(
  dbActions: ArijAction[],
  toolCalls: ArijToolCall[]
): ArijAction[] {
  const coverage = new Map<ArijActionKind, number>();
  for (const action of dbActions) {
    coverage.set(action.kind, (coverage.get(action.kind) ?? 0) + 1);
  }

  const actions: ArijAction[] = [...dbActions];
  for (const call of toolCalls) {
    if (call.tool === "get_ticket") {
      actions.push({
        kind: "tool_call",
        summary: "Read ticket state (get_ticket)",
        at: call.at,
      });
      continue;
    }
    const kind = TOOL_ARTIFACT_KIND[call.tool];
    if (!kind) {
      actions.push({
        kind: "tool_call",
        summary: `Called ${ARIJ_MCP_TOOL_PREFIX}${call.tool}`,
        at: call.at,
      });
      continue;
    }
    const covered = coverage.get(kind) ?? 0;
    if (covered > 0) {
      coverage.set(kind, covered - 1);
      continue;
    }
    actions.push({
      kind: "tool_call",
      summary: `Called ${call.tool} (no recorded effect)`,
      at: call.at,
    });
  }

  return actions.sort(compareAt);
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface CollectArijActionsOptions {
  sessionId: string;
  /**
   * Optional database handle. Defaults to the shared application database;
   * tests inject an isolated in-memory database via `createTestDb()`.
   */
  database?: ArijDatabase;
  /**
   * Raw chunk stream override for tests. Defaults to the session's persisted
   * "raw" chunks from the shared chunk store.
   */
  chunks?: RawChunkLike[];
}

/**
 * Build the session's Arij-actions list from DB artifacts + raw chunks.
 * Read-only and best-effort friendly: callers wrap it in try/catch (the
 * session detail route must not 500 because of an activity list).
 */
export function collectArijActions(
  opts: CollectArijActionsOptions
): ArijAction[] {
  const db = opts.database ?? defaultDb;
  const { sessionId } = opts;

  const dbActions: ArijAction[] = [];

  const transitions = db
    .select({
      fromStatus: ticketActivityLog.fromStatus,
      toStatus: ticketActivityLog.toStatus,
      reason: ticketActivityLog.reason,
      createdAt: ticketActivityLog.createdAt,
    })
    .from(ticketActivityLog)
    .where(
      and(
        eq(ticketActivityLog.sessionId, sessionId),
        eq(ticketActivityLog.actor, "agent")
      )
    )
    .orderBy(asc(ticketActivityLog.createdAt))
    .all();

  for (const row of transitions) {
    // from == to rows are "held" log entries, not moves.
    if (row.fromStatus === row.toStatus) continue;
    dbActions.push({
      kind: "status_change",
      summary: `Ticket moved ${row.fromStatus} → ${row.toStatus}`,
      detail: row.reason ?? undefined,
      at: row.createdAt ?? null,
    });
  }

  const comments = db
    .select({
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(
      and(
        eq(ticketComments.agentSessionId, sessionId),
        eq(ticketComments.author, "agent")
      )
    )
    .orderBy(asc(ticketComments.createdAt))
    .all();

  for (const row of comments) {
    dbActions.push(commentToAction(row.content, row.createdAt ?? null));
  }

  let chunks = opts.chunks;
  if (!chunks) {
    try {
      chunks = listSessionChunks(sessionId, "raw");
    } catch {
      chunks = [];
    }
  }

  return mergeArijActions(dbActions, extractArijToolCalls(chunks));
}
