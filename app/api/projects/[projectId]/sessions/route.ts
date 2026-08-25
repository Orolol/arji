import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  agentSessionChunks,
  agentSessions,
  chatConversations,
  namedAgents,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getSessionStatusForApi } from "@/lib/agent-sessions/lifecycle";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { runBackfillRecentSessionLastNonEmptyTextOnce } from "@/lib/agent-sessions/backfill";
import { latestActivityTimestamp } from "@/lib/agent-sessions/last-activity";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  runBackfillRecentSessionLastNonEmptyTextOnce(projectId);

  // Fetch agent sessions
  const sessions = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all();

  // One grouped query keeps the sessions list free of a per-row chunk lookup.
  // Chunk writes are the durable signal for agent output/message activity.
  const latestChunks = db
    .select({
      sessionId: agentSessionChunks.sessionId,
      lastChunkAt: sql<string | null>`max(${agentSessionChunks.createdAt})`,
    })
    .from(agentSessionChunks)
    .innerJoin(agentSessions, eq(agentSessionChunks.sessionId, agentSessions.id))
    .where(eq(agentSessions.projectId, projectId))
    .groupBy(agentSessionChunks.sessionId)
    .all();
  const lastChunkBySession = new Map(
    latestChunks.map((chunk) => [chunk.sessionId, chunk.lastChunkAt])
  );

  const normalizedSessions = sessions.map((session) => ({
    ...session,
    kind: "agent_session" as const,
    status: getSessionStatusForApi(session.status),
    // Lifecycle timestamps cover queued/running/terminal status changes;
    // chunks cover streamed messages and output between those transitions.
    lastActivityAt: latestActivityTimestamp(
      session.createdAt,
      session.startedAt,
      session.endedAt,
      session.completedAt,
      lastChunkBySession.get(session.id)
    ),
    // Legacy-row fallback handled inside resolveCliSessionId().
    cliSessionId: resolveCliSessionId(session),
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
    .where(eq(chatConversations.projectId, projectId))
    .all();

  const normalizedConversations = conversations.map(
    ({ lastMessageAt, ...conv }) => ({
      ...conv,
      kind: "chat_session" as const,
      lastActivityAt: latestActivityTimestamp(conv.createdAt, lastMessageAt),
    })
  );

  // Merge and sort by createdAt desc, with id as tiebreaker
  const unified = [
    ...normalizedSessions,
    ...normalizedConversations,
  ].sort((a, b) => {
    const dateA = a.createdAt ?? "";
    const dateB = b.createdAt ?? "";
    if (dateB > dateA) return 1;
    if (dateB < dateA) return -1;
    return a.id.localeCompare(b.id);
  });

  return NextResponse.json({ data: unified });
}
