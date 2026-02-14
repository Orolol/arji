import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { chatMessages, chatAttachments, chatConversations, projects, settings, epics } from "@/lib/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaudeStream, spawnClaude } from "@/lib/claude/spawn";
import { buildChatPrompt, buildEpicRefinementPrompt, buildEpicFinalizationPrompt, buildTitleGenerationPrompt } from "@/lib/claude/prompt-builder";
import { getProvider } from "@/lib/providers";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgent } from "@/lib/agent-config/providers";
import { isEpicCreationConversationAgentType } from "@/lib/chat/conversation-agent";
import { activityRegistry } from "@/lib/activity-registry";
import {
  enrichPromptWithDocumentMentions,
  MentionResolutionError,
  validateMentionsExist,
} from "@/lib/documents/mentions";
import { listProjectTextDocuments } from "@/lib/documents/query";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();

  if (!body.content && (!body.attachmentIds || body.attachmentIds.length === 0)) {
    return new Response(JSON.stringify({ error: "content or attachments required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    validateMentionsExist({
      projectId,
      textSources: [body.content],
    });
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  const conversationId: string | null = body.conversationId || null;
  const attachmentIds: string[] = body.attachmentIds || [];
  const finalize: boolean = body.finalize === true;

  function setConversationStatus(status: "active" | "generating" | "error") {
    if (!conversationId) return;
    db.update(chatConversations)
      .set({ status })
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

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
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return new Response(JSON.stringify({ error: "Project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const docs = listProjectTextDocuments(projectId);

  const conditions = [eq(chatMessages.projectId, projectId)];
  if (conversationId) {
    conditions.push(eq(chatMessages.conversationId, conversationId));
  }

  const recentMessages = db
    .select()
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(desc(chatMessages.createdAt))
    .limit(20)
    .all()
    .reverse();

  // Determine conversation type
  let conversationType: string | null = null;
  if (conversationId) {
    const conv = db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)).get();
    conversationType = conv?.type ?? null;
  }

  const messageHistory = recentMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  let prompt: string;
  if (isEpicCreationConversationAgentType(conversationType)) {
    const settingsRow = db.select().from(settings).where(eq(settings.key, "global_prompt")).get();
    const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";
    const existingEpics = db
      .select({
        title: epics.title,
        description: epics.description,
      })
      .from(epics)
      .where(eq(epics.projectId, projectId))
      .orderBy(epics.position)
      .all();

    prompt = finalize
      ? buildEpicFinalizationPrompt(
          project,
          docs,
          messageHistory,
          globalPrompt,
          existingEpics,
        )
      : buildEpicRefinementPrompt(
          project,
          docs,
          messageHistory,
          globalPrompt,
          existingEpics,
        );
  } else {
    const chatSystemPrompt = await resolveAgentPrompt("chat", projectId);
    prompt = buildChatPrompt(project, docs, messageHistory, chatSystemPrompt);
  }

  const resolvedAgent = resolveAgent("chat", projectId);

  try {
    prompt = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: [body.content, ...messageHistory.map((m) => m.content)],
    }).prompt;
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  // Session resume for Claude Code
  let claudeSessionId: string | undefined;
  let resumeSession = false;
  let effectivePrompt = prompt;

  if (resolvedAgent.provider === "claude-code" && conversationId) {
    const conv = db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, conversationId))
      .get();
    if (conv?.claudeSessionId) {
      claudeSessionId = conv.claudeSessionId;
      resumeSession = true;
      effectivePrompt = body.content; // just the new message, not full history
    } else {
      claudeSessionId = crypto.randomUUID();
    }
  }

  setConversationStatus("generating");

  // Determine conversation label for activity registry
  let activityLabel = "Chat";
  if (conversationId) {
    const conv = db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)).get();
    if (conv?.label) activityLabel = `Chat: ${conv.label}`;
  }
  const activityId = `chat-${createId()}`;

  const encoder = new TextEncoder();

  /**
   * Helper: save assistant message and generate title after stream completes.
   */
  function saveAssistantAndTitle(
    controller: ReadableStreamDefaultController,
    fullContent: string,
    finalStatus: "active" | "error" = "active",
  ) {
    const assistantMsgId = createId();
    db.insert(chatMessages)
      .values({
        id: assistantMsgId,
        projectId,
        conversationId,
        role: "assistant",
        content: fullContent || "(empty response)",
        createdAt: new Date().toISOString(),
      })
      .run();

    // Fire-and-forget title generation for first exchange
    if (conversationId && fullContent) {
      const msgCount = db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .all().length;

      if (msgCount === 2) {
        const conv = db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)).get();
        if (conv && (conv.label === "Brainstorm" || conv.label === "New Epic")) {
          const titlePrompt = buildTitleGenerationPrompt(body.content, fullContent);
          spawnClaude({ mode: "plan", prompt: titlePrompt, model: "haiku" }).promise
            .then((titleResult) => {
              if (titleResult.success && titleResult.result) {
                let title = titleResult.result.trim();
                try {
                  const parsed = JSON.parse(title);
                  if (parsed.result) title = parsed.result;
                  else if (typeof parsed === "string") title = parsed;
                } catch { /* use raw */ }
                title = title.replace(/^["']|["']$/g, "").trim();
                if (title && title.length <= 60) {
                  db.update(chatConversations)
                    .set({ label: title })
                    .where(eq(chatConversations.id, conversationId))
                    .run();
                }
              }
            })
            .catch(() => { /* ignore title gen errors */ });
        }
      }
    }

    setConversationStatus(finalStatus);

    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ done: true, messageId: assistantMsgId })}\n\n`
      )
    );
    controller.close();
  }

  // Branch on provider
  if (resolvedAgent.provider === "codex" || resolvedAgent.provider === "gemini-cli") {
    // Non-streaming providers: run full prompt, emit a single SSE delta event.
    const dynamicProvider = getProvider(resolvedAgent.provider);
    const session = dynamicProvider.spawn({
      sessionId: `chat-${createId()}`,
      prompt,
      cwd: project.gitRepoPath || process.cwd(),
      mode: "plan",
      model: resolvedAgent.model,
      logIdentifier: conversationId || `chat-${projectId}`,
    });

    activityRegistry.register({
      id: activityId,
      projectId,
      type: "chat",
      label: activityLabel,
      provider: resolvedAgent.provider,
      startedAt: new Date().toISOString(),
      kill: () => session.kill(),
    });

    const sseStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              status:
                resolvedAgent.provider === "codex"
                  ? "Codex processing..."
                  : "Gemini processing...",
            })}\n\n`
          )
        );

        try {
          const result = await session.promise;
          const fullContent = result.success
            ? result.result || "(empty response)"
            : `Error: ${result.error || "Provider request failed"}`;

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ delta: fullContent })}\n\n`)
          );

          activityRegistry.unregister(activityId);
          saveAssistantAndTitle(controller, fullContent, result.success ? "active" : "error");
        } catch (error) {
          const failureMessage =
            error instanceof Error ? `Error: ${error.message}` : "Error: Provider request failed";

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ delta: failureMessage })}\n\n`)
          );
          activityRegistry.unregister(activityId);
          saveAssistantAndTitle(controller, failureMessage, "error");
        }
      },
      cancel() {
        activityRegistry.unregister(activityId);
        session.kill();
        setConversationStatus("active");
      },
    });

    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Claude Code: streaming via spawnClaudeStream
  const { stream: claudeStream, kill } = spawnClaudeStream({
    mode: "plan",
    prompt: effectivePrompt,
    model: resolvedAgent.model,
    cwd: project.gitRepoPath || undefined,
    logIdentifier: conversationId || `chat-${projectId}`,
    claudeSessionId,
    resumeSession,
  });

  activityRegistry.register({
    id: activityId,
    projectId,
    type: "chat",
    label: activityLabel,
    provider: "claude-code",
    startedAt: new Date().toISOString(),
    kill,
  });

  let fullContent = "";
  let hasStreamError = false;

  const sseStream = new ReadableStream({
    async start(controller) {
      const reader = claudeStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === "text") {
            fullContent += value.text;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ delta: value.text })}\n\n`)
            );
          } else if (value.type === "questions") {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ questions: value.questions })}\n\n`)
            );
          } else if (value.type === "status") {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ status: value.status })}\n\n`)
            );
          }
        }
      } catch (err) {
        console.error("[chat/stream] Stream error:", err);
        hasStreamError = true;
      }

      activityRegistry.unregister(activityId);

      // Persist claudeSessionId for future resume (only on first message)
      if (conversationId && claudeSessionId && !resumeSession && !hasStreamError) {
        db.update(chatConversations)
          .set({ claudeSessionId })
          .where(eq(chatConversations.id, conversationId))
          .run();
      }

      saveAssistantAndTitle(controller, fullContent, hasStreamError ? "error" : "active");
    },
    cancel() {
      activityRegistry.unregister(activityId);
      kill();
      setConversationStatus("active");
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
