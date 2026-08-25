import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  agentSessions,
  chatConversations,
  namedAgents,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getSessionStatusForApi } from "@/lib/agent-sessions/lifecycle";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { runBackfillRecentSessionLastNonEmptyTextOnce } from "@/lib/agent-sessions/backfill";
import { latestActivityTimestamp } from "@/lib/agent-sessions/last-activity";
import { getSessionLastActivityAt } from "@/lib/agents/watchdog";

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

  const normalizedSessions = sessions.map((session) => ({
    ...session,
    kind: "agent_session" as const,
    status: getSessionStatusForApi(session.status),
    lastActivityAt: getSessionLastActivityAt(session),
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
