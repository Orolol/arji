import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  agentSessions,
  chatConversations,
  namedAgents,
} from "@/lib/db/schema";
import { and, asc, desc, eq, or, sql, type Column, type SQL } from "drizzle-orm";
import { getSessionStatusForApi } from "@/lib/agent-sessions/lifecycle";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { runBackfillRecentSessionLastNonEmptyTextOnce } from "@/lib/agent-sessions/backfill";
import { latestActivityTimestamp } from "@/lib/agent-sessions/last-activity";
import { getSessionLastActivityAt } from "@/lib/agents/watchdog";
import {
  SESSION_LIST_DEFAULT_PAGE_SIZE,
  SESSION_LIST_MAX_PAGE_SIZE,
} from "@/lib/agent-sessions/session-list";

/**
 * Columns the unified sessions list actually needs. `agent_sessions.prompt`
 * is the reason this is an explicit projection and not `select()`: on the
 * live database it is ~99% of the payload (39.9 MB of 40.4 MB for one
 * project) and nothing downstream reads it — the Sessions page, the board's
 * failure badges (lib/agent-sessions/latest-failure.ts) and "What the agent
 * did" all ignore it. better-sqlite3 is synchronous on one shared
 * connection, so materialising that column blocked the whole event loop —
 * every other request, every SSE heartbeat — on a route the board polls
 * every 3 seconds. `logs_path`, `worktree_path`, `cli_command`,
 * `cli_options` and the estimated-prompt breakdown are left out for the
 * same reason; the session DETAIL route still serves them.
 */
const sessionListColumns = {
  id: agentSessions.id,
  epicId: agentSessions.epicId,
  userStoryId: agentSessions.userStoryId,
  status: agentSessions.status,
  mode: agentSessions.mode,
  provider: agentSessions.provider,
  agentType: agentSessions.agentType,
  branchName: agentSessions.branchName,
  startedAt: agentSessions.startedAt,
  endedAt: agentSessions.endedAt,
  completedAt: agentSessions.completedAt,
  createdAt: agentSessions.createdAt,
  lastNonEmptyText: agentSessions.lastNonEmptyText,
  error: agentSessions.error,
  outcome: agentSessions.outcome,
  inputTokens: agentSessions.inputTokens,
  outputTokens: agentSessions.outputTokens,
  totalCostUsd: agentSessions.totalCostUsd,
  batchRunId: agentSessions.batchRunId,
  namedAgentId: agentSessions.namedAgentId,
  namedAgentName: agentSessions.namedAgentName,
  model: agentSessions.model,
  cliSessionId: agentSessions.cliSessionId,
  // Read only through resolveCliSessionId() — legacy rows populate it instead
  // of cli_session_id, and it is dropped from the response below.
  claudeSessionId: agentSessions.claudeSessionId,
};

/**
 * The list's sort key, as SQL. `created_at` is nullable on both tables, so
 * NULL collapses to the empty string on both sides of every comparison —
 * matching the JS comparator and keeping timestamp-less legacy rows
 * reachable on the last page instead of silently dropping out of the keyset.
 */
function sortKey(createdAt: Column): SQL {
  return sql`coalesce(${createdAt}, '')`;
}

/** Keyset predicate: strictly after `cursor` in (createdAt desc, id asc). */
function afterCursor(
  createdAt: Column,
  id: Column,
  cursor: { createdAt: string; id: string }
): SQL {
  const key = sortKey(createdAt);
  return or(
    sql`${key} < ${cursor.createdAt}`,
    and(sql`${key} = ${cursor.createdAt}`, sql`${id} > ${cursor.id}`)
  )!;
}

/**
 * Opaque page cursor: the sort key of the last row already delivered,
 * `"<createdAt>|<id>"`. Clients only ever echo `nextCursor` back.
 */
function encodeCursor(row: { createdAt: string | null; id: string }): string {
  return `${row.createdAt ?? ""}|${row.id}`;
}

function decodeCursor(
  raw: string | null
): { createdAt: string; id: string } | null {
  if (!raw) return null;
  // Split on the LAST separator: ids never contain "|", timestamps must not
  // be assumed not to.
  const separator = raw.lastIndexOf("|");
  if (separator < 0) return null;
  const id = raw.slice(separator + 1);
  if (!id) return null;
  return { createdAt: raw.slice(0, separator), id };
}

/**
 * Newest first, id ascending on a tie. BINARY (byte-wise) on purpose: this
 * has to agree exactly with the SQL keyset above, and `localeCompare` orders
 * mixed-case nanoids differently from SQLite, which would let a row at a
 * same-timestamp page boundary be served twice or not at all.
 */
function byRecencyThenId(
  a: { createdAt: string | null; id: string },
  b: { createdAt: string | null; id: string }
): number {
  const dateA = a.createdAt ?? "";
  const dateB = b.createdAt ?? "";
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return SESSION_LIST_DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(parsed, 1), SESSION_LIST_MAX_PAGE_SIZE);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get("limit"));
  const cursor = decodeCursor(searchParams.get("cursor"));

  runBackfillRecentSessionLastNonEmptyTextOnce(projectId);

  // Both streams are paged on the same key, so the merged first `limit` rows
  // are exactly the next page of the merged order. Each fetches one row more
  // than the page so an exhausted stream is distinguishable from a full one.
  const pageSize = limit + 1;

  // Fetch agent sessions
  const sessions = db
    .select(sessionListColumns)
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        cursor
          ? afterCursor(agentSessions.createdAt, agentSessions.id, cursor)
          : undefined
      )
    )
    .orderBy(desc(sortKey(agentSessions.createdAt)), asc(agentSessions.id))
    .limit(pageSize)
    .all();

  const normalizedSessions = sessions.map(({ claudeSessionId, ...session }) => ({
    ...session,
    kind: "agent_session" as const,
    status: getSessionStatusForApi(session.status),
    lastActivityAt: getSessionLastActivityAt(session),
    // Legacy-row fallback handled inside resolveCliSessionId().
    cliSessionId: resolveCliSessionId({
      cliSessionId: session.cliSessionId,
      claudeSessionId,
    }),
  }));

  // Fetch chat conversations with message count, last message preview, and named agent name
  const conversations = db
    .select({
      id: chatConversations.id,
      projectId: chatConversations.projectId,
      type: chatConversations.type,
      label: chatConversations.label,
      status: chatConversations.status,
      epicId: chatConversations.epicId,
      provider: chatConversations.provider,
      namedAgentId: chatConversations.namedAgentId,
      createdAt: chatConversations.createdAt,
      namedAgentName: namedAgents.readableAgentName,
      messageCount: sql<number>`(
        SELECT COUNT(*) FROM chat_messages
        WHERE chat_messages.conversation_id = ${chatConversations.id}
      )`.as("message_count"),
      lastMessagePreview: sql<string | null>`(
        SELECT SUBSTR(content, 1, 120) FROM chat_messages
        WHERE chat_messages.conversation_id = ${chatConversations.id}
        ORDER BY created_at DESC LIMIT 1
      )`.as("last_message_preview"),
      lastMessageAt: sql<string | null>`(
        SELECT MAX(created_at) FROM chat_messages
        WHERE chat_messages.conversation_id = ${chatConversations.id}
      )`.as("last_message_at"),
    })
    .from(chatConversations)
    .leftJoin(namedAgents, eq(chatConversations.namedAgentId, namedAgents.id))
    .where(
      and(
        eq(chatConversations.projectId, projectId),
        cursor
          ? afterCursor(chatConversations.createdAt, chatConversations.id, cursor)
          : undefined
      )
    )
    .orderBy(desc(sortKey(chatConversations.createdAt)), asc(chatConversations.id))
    .limit(pageSize)
    .all();

  const normalizedConversations = conversations.map(
    ({ lastMessageAt, ...conv }) => ({
      ...conv,
      kind: "chat_session" as const,
      lastActivityAt: latestActivityTimestamp(conv.createdAt, lastMessageAt),
    })
  );

  // Merge and sort by createdAt desc, with id as tiebreaker
  const merged = [...normalizedSessions, ...normalizedConversations].sort(
    byRecencyThenId
  );

  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  // More rows exist iff at least one was left over after the slice.
  const nextCursor =
    merged.length > limit && last ? encodeCursor(last) : null;

  return NextResponse.json({ data: page, nextCursor });
}
