import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatConversations, chatMessages } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { resolveAgentProvider } from "@/lib/agent-config/providers";
import { normalizeConversationAgentType } from "@/lib/chat/conversation-agent";
import {
  normalizeLegacyConversationStatus,
  sortConversationsForLegacyParity,
} from "@/lib/chat/parity-contract";
import { runUnifiedChatCutoverMigrationOnce } from "@/lib/chat/unified-cutover-migration";

function normalizeConversationsForParity<T extends {
  id: string;
  type: string;
  status: string | null;
  createdAt: string | null;
}>(conversations: T[]): T[] {
  return sortConversationsForLegacyParity(
    conversations.map((conversation) => ({
      ...conversation,
      type: normalizeConversationAgentType(conversation.type),
      status: normalizeLegacyConversationStatus(conversation.status),
    })),
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  runUnifiedChatCutoverMigrationOnce(projectId);

  let conversations = db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.projectId, projectId))
    .orderBy(chatConversations.createdAt)
    .all();

  // Auto-create a default "Brainstorm" conversation if none exist
  if (conversations.length === 0) {
    const id = createId();
    const now = new Date().toISOString();
    const defaultProvider = await resolveAgentProvider("chat", projectId);

    db.insert(chatConversations)
      .values({
        id,
        projectId,
        type: "brainstorm",
        label: "Brainstorm",
        provider: defaultProvider,
        createdAt: now,
      })
      .run();

    // Backfill existing orphan messages
    db.update(chatMessages)
      .set({ conversationId: id })
      .where(
        and(
          eq(chatMessages.projectId, projectId),
          isNull(chatMessages.conversationId)
        )
      )
      .run();

    conversations = db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.projectId, projectId))
      .orderBy(chatConversations.createdAt)
      .all();
  }

  return NextResponse.json({ data: normalizeConversationsForParity(conversations) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();

  const id = createId();
  const now = new Date().toISOString();

  // Resolve default provider from agent-config if not explicitly provided
  let provider = body.provider;
  if (!provider) {
    provider = await resolveAgentProvider("chat", projectId);
  }

  db.insert(chatConversations)
    .values({
      id,
      projectId,
      type: body.type || "brainstorm",
      label: body.label || "Brainstorm",
      epicId: body.epicId || null,
      provider,
      createdAt: now,
    })
    .run();

  const conversation = db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.id, id))
    .get();

  return NextResponse.json({ data: conversation });
}
