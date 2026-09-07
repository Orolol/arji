import { withAgentResolutionErrors } from "@/lib/api/agent-resolution-response";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatMessages, chatAttachments } from "@/lib/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaude } from "@/lib/claude/spawn";
import { buildChatPrompt } from "@/lib/claude/prompt-builder";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  enrichPromptWithDocumentMentions,
  MentionResolutionError,
  userAuthoredTexts,
  validateMentionsExist,
} from "@/lib/documents/mentions";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { getProvider } from "@/lib/providers";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { chatMessageSchema } from "@/lib/validation/chat-schemas";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const conversationId = request.nextUrl.searchParams.get("conversationId");

  const conditions = [eq(chatMessages.projectId, projectId)];
  if (conversationId) {
    conditions.push(eq(chatMessages.conversationId, conversationId));
  }

  const messages = db
    .select()
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(chatMessages.createdAt)
    .all();

  // Fetch attachments for all messages in a single query
  const messageIds = messages.map((m) => m.id);
  const allAttachments = messageIds.length > 0
    ? db
        .select()
        .from(chatAttachments)
        .where(inArray(chatAttachments.chatMessageId, messageIds))
        .all()
    : [];

  // Group attachments by message ID
  const attachmentsByMessage = new Map<string, typeof allAttachments>();
  for (const att of allAttachments) {
    const msgId = att.chatMessageId!;
    const existing = attachmentsByMessage.get(msgId) || [];
    existing.push(att);
    attachmentsByMessage.set(msgId, existing);
  }

  const messagesWithAttachments = messages.map((msg) => ({
    ...msg,
    attachments: (attachmentsByMessage.get(msg.id) || []).map((att) => ({
      id: att.id,
      fileName: att.fileName,
      mimeType: att.mimeType,
      url: `/api/projects/${projectId}/chat/uploads/${att.id}`,
    })),
  }));

  return NextResponse.json({ data: messagesWithAttachments });
}

export const POST = withAgentResolutionErrors(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(chatMessageSchema, request);
  if (isValidationError(validated)) return validated;
  const body = validated.data;

  const namedAgentId: string | null = body.namedAgentId || null;

  if (!body.content && (!body.attachmentIds || body.attachmentIds.length === 0)) {
    return NextResponse.json({ error: "content or attachments required" }, { status: 400 });
  }

  try {
    validateMentionsExist({
      projectId,
      textSources: [body.content],
    });
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const conversationId = body.conversationId || null;
  const attachmentIds: string[] = body.attachmentIds || [];

  // Refuse an unusable agent before storing the message or linking uploads.
  const resolvedAgent = resolveAgentByNamedId("chat", projectId, namedAgentId);

  // Save user message
  const userMsgId = createId();
  const userContent = body.content || (attachmentIds.length > 0 ? "[image]" : "");
  db.insert(chatMessages)
    .values({
      id: userMsgId,
      projectId,
      conversationId,
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString(),
    })
    .run();

  // Link pending attachments to this message
  if (attachmentIds.length > 0) {
    db.update(chatAttachments)
      .set({ chatMessageId: userMsgId })
      .where(inArray(chatAttachments.id, attachmentIds))
      .run();
  }

  // Load context
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;
  const { project } = found;

  const recentMessages = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.projectId, projectId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(20)
    .all()
    .reverse();

  const chatSystemPrompt = await resolveAgentPrompt("chat", projectId);

  const prompt = buildChatPrompt(
    project,
    [],
    recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    chatSystemPrompt
  );

  // The new user message plus earlier user messages only: an assistant reply
  // naming a codebase file is not an Arij document reference. Unknown mentions
  // in the new message already returned 400 above (validateMentionsExist).
  const enrichedPrompt = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [body.content, ...userAuthoredTexts(recentMessages)],
  }).prompt;

  try {
    let result;
    // Same rule as generate-spec: anything that is not Claude Code is spawned
    // through its own provider, not silently through spawnClaude().
    if (resolvedAgent.provider !== "claude-code") {
      const dynamicProvider = getProvider(resolvedAgent.provider);
      const session = dynamicProvider.spawn({
        sessionId: `chat-${createId()}`,
        prompt: enrichedPrompt,
        cwd: project.gitRepoPath || process.cwd(),
        mode: "plan",
        model: resolvedAgent.model,
        // A chat turn has no agent_sessions row, so it never reaches
        // processManager.start() — the agent's CLI options have to be carried
        // explicitly here. See lib/chat/cli-tool-channel.ts for the same
        // reasoning applied to the MCP channel.
        cliOptions: resolvedAgent.cliOptions,
      });
      result = await session.promise;
    } else {
      console.log("[chat] Spawning Claude CLI, cwd:", project.gitRepoPath || "(none)");
      const { promise } = spawnClaude({
        mode: "plan",
        prompt: enrichedPrompt,
        model: resolvedAgent.model,
        cwd: project.gitRepoPath || undefined,
        cliOptions: resolvedAgent.cliOptions,
      });
      result = await promise;
    }

    console.log("[chat] Claude CLI result:", {
      success: result.success,
      duration: result.duration,
      error: result.error,
      resultLength: result.result?.length ?? 0,
      resultPreview: result.result?.slice(0, 300),
    });

    if (!result.success) {
      // Save error as assistant message
      const errorMsgId = createId();
      db.insert(chatMessages)
        .values({
          id: errorMsgId,
          projectId,
          conversationId,
          role: "assistant",
          content: `Error: ${result.error || "Claude Code failed"}`,
          createdAt: new Date().toISOString(),
        })
        .run();

      return NextResponse.json({ data: { userMessage: userMsgId, assistantMessage: errorMsgId } });
    }

    const parsed = parseClaudeOutput(result.result || "");

    const assistantMsgId = createId();
    db.insert(chatMessages)
      .values({
        id: assistantMsgId,
        projectId,
        conversationId,
        role: "assistant",
        content: parsed.content,
        metadata: JSON.stringify(parsed.metadata || {}),
        createdAt: new Date().toISOString(),
      })
      .run();

    return NextResponse.json({ data: { userMessage: userMsgId, assistantMessage: assistantMsgId } });
  } catch (e) {
    const errorMsgId = createId();
    db.insert(chatMessages)
      .values({
        id: errorMsgId,
        projectId,
        conversationId,
        role: "assistant",
        content: `Error: ${e instanceof Error ? e.message : "Unknown error"}`,
        createdAt: new Date().toISOString(),
      })
      .run();

    return NextResponse.json({ data: { userMessage: userMsgId, assistantMessage: errorMsgId } });
  }
});
