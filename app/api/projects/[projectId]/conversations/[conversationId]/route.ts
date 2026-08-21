import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatConversations, namedAgents } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveAgent } from "@/lib/agent-config/agent-resolution";
import { isChatProvider } from "@/lib/agent-config/constants";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { updateConversationSchema } from "@/lib/validation/chat-schemas";

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

  return NextResponse.json({ data: result });
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

  if (Object.prototype.hasOwnProperty.call(body, "namedAgentId")) {
    const namedAgentIdInput =
      typeof body.namedAgentId === "string" ? body.namedAgentId.trim() : "";

    if (namedAgentIdInput) {
      const namedAgent = db
        .select({
          id: namedAgents.id,
          provider: namedAgents.provider,
        })
        .from(namedAgents)
        .where(eq(namedAgents.id, namedAgentIdInput))
        .get();

      if (!namedAgent) {
        return NextResponse.json({ error: "namedAgentId not found" }, { status: 400 });
      }

      updates.namedAgentId = namedAgent.id;
      updates.provider = namedAgent.provider;
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
      // Clearing a conversation-specific named agent falls back to configured chat default.
      const resolved = resolveAgent("chat", projectId);
      updates.namedAgentId = null;
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
        }
      : updated,
  });
}
