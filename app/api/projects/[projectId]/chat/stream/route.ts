import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { chatMessages, chatAttachments, chatConversations, projects, settings, epics } from "@/lib/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaudeStream, spawnClaude } from "@/lib/claude/spawn";
import { buildChatPrompt, buildEpicRefinementPrompt, buildEpicFinalizationPrompt, buildTitleGenerationPrompt } from "@/lib/claude/prompt-builder";
import { getProvider, type ProviderType } from "@/lib/providers";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/providers";
import { isEpicCreationConversationAgentType } from "@/lib/chat/conversation-agent";
import { activityRegistry } from "@/lib/activity-registry";
import {
  enrichPromptWithDocumentMentions,
  MentionResolutionError,
  validateMentionsExist,
} from "@/lib/documents/mentions";

const RESUME_CAPABLE_PROVIDERS = new Set<ProviderType>([
  "claude-code",
  "gemini-cli",
]);

function normalizeProvider(value: string | null | undefined): ProviderType | null {
  if (value === "claude-code" || value === "gemini-cli" || value === "codex") {
    return value;
  }
  return null;
}

function isResumeSessionExpiredError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /(session|resume).*(expired|not found|invalid|unknown|does not exist)|invalid.*(session|resume)/i.test(
    error
  );
}

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

  const conversation = conversationId
    ? db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, conversationId))
        .get()
    : null;
  const conversationType = conversation?.type ?? null;

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
          [],
          messageHistory,
          globalPrompt,
          existingEpics,
        )
      : buildEpicRefinementPrompt(
          project,
          [],
          messageHistory,
          globalPrompt,
          existingEpics,
        );
  } else {
    const chatSystemPrompt = await resolveAgentPrompt("chat", projectId);
    prompt = buildChatPrompt(project, [], messageHistory, chatSystemPrompt);
  }

  const resolvedByNamedAgent = resolveAgentByNamedId(
    "chat",
    projectId,
    conversation?.namedAgentId ?? null
  );
  const conversationProvider = normalizeProvider(conversation?.provider);
  const resolvedAgent =
    conversationProvider && !conversation?.namedAgentId
      ? { ...resolvedByNamedAgent, provider: conversationProvider }
      : resolvedByNamedAgent;

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

  const providerSupportsResume = RESUME_CAPABLE_PROVIDERS.has(
    resolvedAgent.provider as ProviderType
  );
  let cliSessionId =
    conversation?.cliSessionId ?? conversation?.claudeSessionId ?? undefined;
  const resumeSession = Boolean(conversationId && cliSessionId && providerSupportsResume);
  if (!cliSessionId && providerSupportsResume) {
    cliSessionId = crypto.randomUUID();
  }
  let effectivePrompt = resumeSession ? userContent : prompt;

  function persistConversationSessionId(nextCliSessionId?: string) {
    if (!conversationId || !nextCliSessionId) return;
    db.update(chatConversations)
      .set({
        cliSessionId: nextCliSessionId,
        // Keep legacy column populated while callers migrate.
        claudeSessionId: nextCliSessionId,
      })
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  setConversationStatus("generating");

  // Determine conversation label for activity registry
  const activityLabel =
    conversation?.label ? `Chat: ${conversation.label}` : "Chat";
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

  // Gemini/Codex: non-streaming providers
  if (resolvedAgent.provider !== "claude-code") {
    const dynamicProvider = getProvider(resolvedAgent.provider);
    let activeProviderSession = dynamicProvider.spawn({
      sessionId: `chat-${createId()}`,
      prompt: effectivePrompt,
      cwd: project.gitRepoPath || process.cwd(),
      mode: "plan",
      model: resolvedAgent.model,
      logIdentifier: conversationId || `chat-${projectId}`,
      cliSessionId,
      resumeSession,
    });

    activityRegistry.register({
      id: activityId,
      projectId,
      type: "chat",
      label: activityLabel,
      provider: resolvedAgent.provider,
      startedAt: new Date().toISOString(),
      kill: () => activeProviderSession.kill(),
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
          let result = await activeProviderSession.promise;

          // Resume-first: if the remote session expired, retry once with a fresh session.
          if (
            resumeSession &&
            !result.success &&
            isResumeSessionExpiredError(result.error)
          ) {
            cliSessionId = providerSupportsResume ? crypto.randomUUID() : undefined;
            activeProviderSession = dynamicProvider.spawn({
              sessionId: `chat-${createId()}`,
              prompt,
              cwd: project.gitRepoPath || process.cwd(),
              mode: "plan",
              model: resolvedAgent.model,
              logIdentifier: conversationId || `chat-${projectId}`,
              cliSessionId,
              resumeSession: false,
            });
            result = await activeProviderSession.promise;
          }

          const fullContent = result.success
            ? result.result || "(empty response)"
            : `Error: ${result.error || "Provider request failed"}`;
          const resolvedCliSessionId = result.cliSessionId ?? cliSessionId;

          if (result.success) {
            persistConversationSessionId(resolvedCliSessionId);
          }

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
        activeProviderSession.kill();
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

  // Claude resume-first path: attempt resume non-streaming, fallback to fresh prompt.
  if (resumeSession) {
    let currentKill = () => {};

    activityRegistry.register({
      id: activityId,
      projectId,
      type: "chat",
      label: activityLabel,
      provider: "claude-code",
      startedAt: new Date().toISOString(),
      kill: () => currentKill(),
    });

    const sseStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ status: "Resuming conversation..." })}\n\n`)
        );

        try {
          let resultSessionId = cliSessionId;
          let attempt = spawnClaude({
            mode: "plan",
            prompt: effectivePrompt,
            model: resolvedAgent.model,
            cwd: project.gitRepoPath || undefined,
            logIdentifier: conversationId || `chat-${projectId}`,
            cliSessionId: resultSessionId,
            resumeSession: true,
          });
          currentKill = attempt.kill;
          let result = await attempt.promise;

          if (!result.success && isResumeSessionExpiredError(result.error)) {
            resultSessionId = crypto.randomUUID();
            attempt = spawnClaude({
              mode: "plan",
              prompt,
              model: resolvedAgent.model,
              cwd: project.gitRepoPath || undefined,
              logIdentifier: conversationId || `chat-${projectId}`,
              cliSessionId: resultSessionId,
            });
            currentKill = attempt.kill;
            result = await attempt.promise;
          }

          const fullContent = result.success
            ? result.result || "(empty response)"
            : `Error: ${result.error || "Provider request failed"}`;
          const resolvedCliSessionId = result.cliSessionId ?? resultSessionId;

          if (result.success) {
            persistConversationSessionId(resolvedCliSessionId);
          }

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
        currentKill();
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

  // Claude Code fresh-session path: preserve stream-json UX.
  const { stream: claudeStream, kill } = spawnClaudeStream({
    mode: "plan",
    prompt: effectivePrompt,
    model: resolvedAgent.model,
    cwd: project.gitRepoPath || undefined,
    logIdentifier: conversationId || `chat-${projectId}`,
    cliSessionId,
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
      if (!hasStreamError) {
        persistConversationSessionId(cliSessionId);
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
