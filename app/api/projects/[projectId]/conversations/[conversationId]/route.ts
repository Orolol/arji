import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatConversations, namedAgents } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  isChatProvider,
  isPersistentChatProvider,
} from "@/lib/agent-config/constants";
import { resolveDefaultChatMode } from "@/lib/chat/default-chat-mode";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { updateConversationSchema } from "@/lib/validation/chat-schemas";
import {
  getPersistentChatSessionState,
  restartPersistentChatSession,
} from "@/lib/chat/persistent-runner";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; conversationId: string }> }
) {
  const { projectId, conversationId } = await params;

  const result = db
    .select({
      id: chatConversations.id,
      projectId: chatConversations.projectId,
      type: chatConversations.type,
      label: chatConversations.label,
      status: chatConversations.status,
      epicId: chatConversations.epicId,
      provider: chatConversations.provider,
      namedAgentId: chatConversations.namedAgentId,
      cliSessionId: chatConversations.cliSessionId,
      createdAt: chatConversations.createdAt,
      namedAgentName: namedAgents.readableAgentName,
    })
    .from(chatConversations)
    .leftJoin(namedAgents, eq(chatConversations.namedAgentId, namedAgents.id))
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.projectId, projectId)
      )
    )
    .get();

  if (!result) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      ...result,
      persistentSessionState: isPersistentChatProvider(result.provider)
        ? getPersistentChatSessionState(result.id)
        : null,
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; conversationId: string }> }
) {
  const { projectId, conversationId } = await params;

  // Validate the conversation belongs to the project
  const conversation = db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.projectId, projectId)
      )
    )
    .get();

  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  restartPersistentChatSession(conversationId);

  // Delete conversation (messages cascade via FK)
  db.delete(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .run();

  return NextResponse.json({ data: { deleted: true } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; conversationId: string }> }
) {
  const { projectId, conversationId } = await params;

  const validated = await validateBody(updateConversationSchema, request);
  if (isValidationError(validated)) return validated;
  const body = validated.data;

  const conversation = db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.projectId, projectId)
      )
    )
    .get();

  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const updates: Record<string, string | null> = {};
  const changesExecutionMode =
    Object.prototype.hasOwnProperty.call(body, "namedAgentId") ||
    Object.prototype.hasOwnProperty.call(body, "provider");

  if (Object.prototype.hasOwnProperty.call(body, "namedAgentId")) {
    const namedAgentIdInput =
      typeof body.namedAgentId === "string" ? body.namedAgentId.trim() : "";

    if (namedAgentIdInput) {
      const namedAgent = db
        .select({
          id: namedAgents.id,
          provider: namedAgents.provider,
          kind: namedAgents.kind,
        })
        .from(namedAgents)
        .where(eq(namedAgents.id, namedAgentIdInput))
        .get();

      if (!namedAgent) {
        return NextResponse.json({ error: "namedAgentId not found" }, { status: 400 });
      }

      updates.namedAgentId = namedAgent.id;
      // A composite owns no provider. Preserve the conversation's real
      // fallback provider if the named agent is later removed from the roster.
      if (namedAgent.kind !== "composite") updates.provider = namedAgent.provider;
      updates.cliSessionId = null;
      // Also clear the legacy column so stale legacy-row fallbacks cannot
      // resurrect a session from the previous agent.
      updates.claudeSessionId = null;
    } else if (
      typeof body.provider === "string" &&
      isChatProvider(body.provider.trim())
    ) {
      updates.provider = body.provider.trim();
      updates.namedAgentId = null;
      updates.cliSessionId = null;
      updates.claudeSessionId = null;
    } else {
      // Clearing a conversation-specific named agent without naming a
      // provider lands the conversation on the same default a NEW one opens
      // on. Not `resolveAgent("chat", …)`: its return type is `AgentProvider`,
      // which excludes the `*-persistent` modes and `openai-compatible` by
      // construction, so a conversation created on the warm Claude process
      // silently degraded to one-shot claude-code here. The resolution can
      // also name an agent (the CHAT & SPEC assignment, or the seeded
      // catch-all), and "back to the default" means back to that one — the
      // agent id is written from the resolution rather than hard-coded null.
      // The pill never sends this shape (agentSelectionPatch always pairs a
      // cleared agent with a provider); it is the API contract for clients.
      const resolved = await resolveDefaultChatMode(projectId);
      updates.namedAgentId = resolved.namedAgentId;
      updates.provider = resolved.provider;
      updates.cliSessionId = null;
      updates.claudeSessionId = null;
    }
  } else if (
    typeof body.provider === "string" &&
    isChatProvider(body.provider.trim())
  ) {
    // Provider patching clears named-agent linkage.
    updates.provider = body.provider.trim();
    updates.namedAgentId = null;
    updates.cliSessionId = null;
    updates.claudeSessionId = null;
  }

  if (typeof body.label === "string" && body.label.trim().length > 0) {
    updates.label = body.label.trim();
  }

  if (Object.keys(updates).length > 0) {
    if (changesExecutionMode) restartPersistentChatSession(conversationId);
    db.update(chatConversations)
      .set(updates)
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  const updated = db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .get();

  return NextResponse.json({
    data: updated
      ? {
          ...updated,
          // Legacy-row fallback handled inside resolveCliSessionId().
          cliSessionId: resolveCliSessionId(updated),
          persistentSessionState: isPersistentChatProvider(updated.provider)
            ? getPersistentChatSessionState(updated.id)
            : null,
        }
      : updated,
  });
}
