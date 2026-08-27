import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatConversations, chatMessages, namedAgents, projects } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { resolveAgent } from "@/lib/agent-config/agent-resolution";
import { isChatProvider } from "@/lib/agent-config/constants";
import { normalizeConversationAgentType } from "@/lib/chat/conversation-agent";
import {
  normalizeLegacyConversationStatus,
  sortConversationsForLegacyParity,
} from "@/lib/chat/parity-contract";
import { runUnifiedChatCutoverMigrationOnce } from "@/lib/chat/unified-cutover-migration";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { createConversationSchema } from "@/lib/validation/chat-schemas";
import { isPersistentChatProvider } from "@/lib/agent-config/constants";
import { getPersistentChatSessionState } from "@/lib/chat/persistent-runner";

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

  // Verify project exists before attempting any inserts
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ data: [] });
  }

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
    const resolved = resolveAgent("chat", projectId);

    db.insert(chatConversations)
      .values({
        id,
        projectId,
        type: "brainstorm",
        label: "Brainstorm",
        provider: resolved.provider,
        namedAgentId: resolved.namedAgentId ?? null,
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

  return NextResponse.json({
    data: normalizeConversationsForParity(
      conversations.map((conversation) => ({
        ...conversation,
        // Legacy-row fallback handled inside resolveCliSessionId().
        cliSessionId: resolveCliSessionId(conversation),
        persistentSessionState: isPersistentChatProvider(conversation.provider)
          ? getPersistentChatSessionState(conversation.id)
          : null,
      })),
    ),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(createConversationSchema, request);
  if (isValidationError(validated)) return validated;
  const body = validated.data;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const id = createId();
  const now = new Date().toISOString();

  const namedAgentIdInput =
    typeof body.namedAgentId === "string" ? body.namedAgentId.trim() : "";
  let namedAgentId: string | null = null;
  let provider =
    typeof body.provider === "string" ? body.provider.trim() : "";

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

    namedAgentId = namedAgent.id;
    provider = namedAgent.provider;
  }

  if (!isChatProvider(provider)) {
    const resolved = resolveAgent("chat", projectId);
    provider = resolved.provider;
    if (!namedAgentId) {
      namedAgentId = resolved.namedAgentId ?? null;
    }
  }

  db.insert(chatConversations)
    .values({
      id,
      projectId,
      type: body.type || "brainstorm",
      label: body.label || "Brainstorm",
      epicId: body.epicId || null,
      provider,
      namedAgentId,
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
