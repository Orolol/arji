import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatMessages, chatAttachments, chatConversations, settings, epics } from "@/lib/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import {
  spawnClaudeStream,
  spawnClaude,
  type StreamChunk,
} from "@/lib/claude/spawn";
import { buildChatPrompt, buildEpicRefinementPrompt, buildEpicFinalizationPrompt } from "@/lib/claude/prompt-builder";
import { getProvider, type ProviderType } from "@/lib/providers";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import {
  isEpicCreationConversationAgentType,
  isToolIneligibleConversationAgentType,
} from "@/lib/chat/conversation-agent";
import {
  getOpenAiConfigFromSettings,
  streamOpenAiChatEvents,
  type OpenAiChatMessage,
  type OpenAiToolCall,
} from "@/lib/openai/client";
import {
  buildBoardToolsSystemSection,
  CHAT_BOARD_TOOL_DEFINITIONS,
  executeChatBoardTool,
  type ChatBoardToolContext,
} from "@/lib/chat/board-tools";
import { mintMcpToken, revokeMcpTokensForSession } from "@/lib/mcp/token-store";
import { createChatCliToolChannel } from "@/lib/chat/cli-tool-channel";
import { isMcpToolsEnabled } from "@/lib/claude/mcp-injection";
import { getAppBaseUrl } from "@/lib/webhooks/send";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import { activityRegistry } from "@/lib/activity-registry";
import {
  enrichPromptWithDocumentMentions,
  MentionResolutionError,
  validateMentionsExist,
} from "@/lib/documents/mentions";
import {
  isPersistentChatProvider,
  isChatProvider,
  OPENAI_COMPATIBLE_PROVIDER,
  persistentChatBaseProvider,
  PROVIDER_LABELS,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { chatMessageSchema } from "@/lib/validation/chat-schemas";
import { generateConversationTitle } from "@/lib/chat/title-generation";
import {
  DEFAULT_MAX_WARM_CHAT_CONVERSATIONS,
  DEFAULT_PERSISTENT_CHAT_IDLE_TIMEOUT_MS,
  DEFAULT_PERSISTENT_CHAT_TURN_STALL_MS,
  runPersistentChatTurn,
  restartPersistentChatSession,
} from "@/lib/chat/persistent-runner";
import {
  parsePersistentChatCapSetting,
  parsePersistentChatDurationSetting,
  PERSISTENT_CHAT_IDLE_TIMEOUT_SETTING,
  PERSISTENT_CHAT_MAX_CONVERSATIONS_SETTING,
  PERSISTENT_CHAT_TURN_STALL_SETTING,
} from "@/lib/chat/persistent-chat-constants";
import { isResumeSessionExpiredError } from "@/lib/chat/resume-expiry";

/**
 * The stored conversation provider, honoured for any provider the app
 * knows — including the OpenAI-compatible fast mode, which is not a CLI
 * provider (the fast-mode branch below handles it before any CLI spawn).
 * A short allowlist here silently discards the user's choice: the
 * conversation create/update routes accept every `isChatProvider()` value,
 * so a Pi conversation would normalize to null and fall back to the
 * configured chat default — running a different CLI than the one shown.
 */
function normalizeProvider(value: string | null | undefined): ChatModeProvider | null {
  return value && isChatProvider(value) ? value : null;
}


/**
 * Upper bound on fast-mode tool rounds per turn (each round is one upstream
 * completion request). Keeps a confused model from looping forever and the
 * messages array from growing without bound.
 */
const MAX_TOOL_ROUNDS = 8;

/**
 * Upper bound on tool calls executed within one round. The overflow still
 * gets a `role:"tool"` reply (the protocol requires one per call id), but
 * an error payload instead of an execution.
 */
const MAX_TOOL_CALLS_PER_ROUND = 8;

function settingValue(key: string): unknown {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

/**
 * Whether a first-round upstream failure looks like the endpoint rejecting
 * the `tools` field itself (older OpenAI-compatible servers): client errors
 * only — a generic 500 is usually a transient upstream hiccup, and retrying
 * it without tools would silently strip the board tools for the turn.
 */
function isLikelyToolsRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!error.message.startsWith("OpenAI-compatible API error:")) return false;
  return /\b(400|404|422|501)\b/.test(error.message) || /tool/i.test(error.message);
}

function sseResponse(stream: ReadableStream) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(chatMessageSchema, request);
  if (isValidationError(validated)) return validated;
  const body = validated.data;

  const encoder = new TextEncoder();

  if (!body.content && (!body.attachmentIds || body.attachmentIds.length === 0)) {
    return NextResponse.json(
      { error: "content or attachments required" },
      { status: 400 }
    );
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

  const conversationId: string | null = body.conversationId || null;
  const attachmentIds: string[] = body.attachmentIds || [];
  const finalize: boolean = body.finalize === true;

  // Load context
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;
  const { project } = found;

  const conversation = conversationId
    ? db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, conversationId))
        .get()
    : null;
  const conversationType = conversation?.type ?? null;

  const resolvedByNamedAgent = resolveAgentByNamedId(
    "chat",
    projectId,
    conversation?.namedAgentId ?? null
  );
  const conversationProvider = normalizeProvider(conversation?.provider);
  const persistentProvider = isPersistentChatProvider(conversationProvider)
    ? conversationProvider
    : null;
  const conversationExecutionProvider = persistentProvider
    ? persistentChatBaseProvider(persistentProvider)
    : conversationProvider;
  const overridesProvider =
    Boolean(conversationProvider) && !conversation?.namedAgentId;
  const resolvedAgent =
    overridesProvider && conversationExecutionProvider
      ? {
          ...resolvedByNamedAgent,
          provider: conversationExecutionProvider,
          // A raw provider choice carries no model. Keeping the resolved
          // agent's model would hand e.g. `claude-opus-*` to `codex -m`,
          // which rejects it — drop it and let the CLI pick its default
          // unless both sides agree on the provider.
          model:
            conversationExecutionProvider === resolvedByNamedAgent.provider
              ? resolvedByNamedAgent.model
              : undefined,
        }
      : resolvedByNamedAgent;

  let openAiConfig: ReturnType<typeof getOpenAiConfigFromSettings> | null = null;
  if (resolvedAgent.provider === OPENAI_COMPATIBLE_PROVIDER) {

    if (attachmentIds.length > 0) {
      return NextResponse.json(
        { error: "Image attachments are not supported in OpenAI-compatible mode." },
        { status: 400 }
      );
    }

    openAiConfig = getOpenAiConfigFromSettings();
    if (!openAiConfig.baseUrl || !openAiConfig.model) {
      return NextResponse.json(
        {
          error:
            "OpenAI-compatible mode is not configured. Set the Base URL and Model in Settings.",
        },
        { status: 400 }
      );
    }
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

  const messageHistory = recentMessages.map((m) => ({
    role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
    content: m.content,
  }));

  function setConversationStatus(status: "active" | "generating" | "error") {
    if (!conversationId) return;
    db.update(chatConversations)
      .set({ status })
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  // Save user message (after fast-mode and parameter validation checks have passed)
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

  /**
   * Helper: save assistant message and generate title after stream completes.
   */
  /**
   * Enqueue that tolerates an already-closed controller.
   *
   * When the browser aborts the SSE fetch, the stream's `cancel()` runs and
   * closes the controller before the in-flight turn settles. A raw
   * `enqueue()` then throws `TypeError: Invalid state`, which on the
   * persistent path aborted the handler before it could persist whatever the
   * CLI had already streamed. Losing the frame is expected once the client is
   * gone; losing the durable write is not.
   */
  function enqueueIfOpen(
    controller: ReadableStreamDefaultController,
    payload: string,
  ) {
    try {
      controller.enqueue(encoder.encode(payload));
    } catch {
      // Client disconnected; nothing left to deliver this frame to.
    }
  }

  function closeIfOpen(controller: ReadableStreamDefaultController) {
    try {
      controller.close();
    } catch {
      // Already closed by the client's cancel().
    }
  }

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
        const conv = db
          .select()
          .from(chatConversations)
          .where(eq(chatConversations.id, conversationId))
          .get();
        if (conv && (conv.label === "Brainstorm" || conv.label === "New Epic" || conv.label === "Chat")) {
          void generateConversationTitle({
            projectId,
            userContent,
            assistantContent: fullContent,
          })
            .then((title) => {
              if (title) {
                db.update(chatConversations)
                  .set({ label: title })
                  .where(eq(chatConversations.id, conversationId))
                  .run();
              }
            })
            .catch(() => { /* ignore title gen errors */ });
        }
      }
    }

    setConversationStatus(finalStatus);

    enqueueIfOpen(
      controller,
      `data: ${JSON.stringify({ done: true, messageId: assistantMsgId })}\n\n`,
    );
    closeIfOpen(controller);
  }

  // Full history including the user message just saved above, required by
  // prompt builders so the agent answers the current question.
  const fullHistory = [
    ...messageHistory,
    { role: "user" as const, content: userContent },
  ];

  let prompt = "";
  let chatSystemPrompt = "";
  const isEpicCreation = isEpicCreationConversationAgentType(conversationType);
  const isFastMode =
    resolvedAgent.provider === OPENAI_COMPATIBLE_PROVIDER && openAiConfig !== null;

  if (isEpicCreation) {
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

    // The CLI path ships one self-contained prompt, so the transcript it
    // embeds must include the message just saved. Fast mode sends that
    // message as its own `user` turn, so its prompt stops one turn earlier
    // — otherwise the current question travels twice.
    const historyForPrompt = isFastMode ? messageHistory : fullHistory;

    prompt = finalize
      ? buildEpicFinalizationPrompt(
          project,
          [],
          historyForPrompt,
          globalPrompt,
          existingEpics,
        )
      : buildEpicRefinementPrompt(
          project,
          [],
          historyForPrompt,
          globalPrompt,
          existingEpics,
        );
  } else {
    chatSystemPrompt = await resolveAgentPrompt("chat", projectId);
  }

  // ---------------------------------------------------------------------
  // OpenAI-compatible fast mode: dedicated HTTP path ahead of the CLI
  // branches. History travels in the messages array (no session resume),
  // and upstream SSE chunks are re-emitted as token-by-token delta events.
  // ---------------------------------------------------------------------
  if (isFastMode && openAiConfig) {
    // Parity with the CLI branch below: the direct API must see the project
    // context (spec, memory, documents) too, not just the configured chat
    // system prompt — which is empty by default, leaving the model with no
    // idea which project it is talking about. History is left out here; it
    // travels as real chat messages.
    let fastModeSystemPrompt = isEpicCreation
      ? prompt
      : buildChatPrompt(project, [], [], chatSystemPrompt);

    try {
      if (fastModeSystemPrompt.trim()) {
        fastModeSystemPrompt = enrichPromptWithDocumentMentions({
          projectId,
          prompt: fastModeSystemPrompt,
          textSources: [body.content, ...messageHistory.map((m) => m.content)],
        }).prompt;
      }
    } catch (error) {
      if (error instanceof MentionResolutionError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    // Same global toggle as the CLI agents' MCP injection: off means the
    // model gets neither the tools nor a system prompt promising them.
    // Prompt-contract conversations (epic creation, brainstorm) keep their
    // structured prompts pure — no board tools there (gate parity with the
    // CLI chat tool channel).
    const chatToolsEnabled =
      !isToolIneligibleConversationAgentType(conversationType) &&
      isMcpToolsEnabled();
    const systemSections = [
      fastModeSystemPrompt.trim(),
      chatToolsEnabled ? buildBoardToolsSystemSection(project) : "",
    ].filter(Boolean);
    const openAiMessages: OpenAiChatMessage[] = [];
    if (systemSections.length > 0) {
      openAiMessages.push({
        role: "system",
        content: systemSections.join("\n\n"),
      });
    }
    // The epic builders embed the transcript in the system prompt already;
    // only the chat prompt needs it replayed as messages.
    if (!isEpicCreation) {
      for (const message of messageHistory) {
        openAiMessages.push({
          role: message.role,
          content: message.content,
        });
      }
    }
    openAiMessages.push({
      role: "user",
      content: userContent,
    });
    const activityLabel = conversation?.label
      ? `Chat: ${conversation.label}`
      : "Chat";
    const activityId = `chat-${createId()}`;

    setConversationStatus("generating");

    const abortController = new AbortController();
    activityRegistry.register({
      id: activityId,
      projectId,
      type: "chat",
      label: activityLabel,
      provider: OPENAI_COMPATIBLE_PROVIDER,
      namedAgentName: resolvedAgent.name ?? null,
      startedAt: new Date().toISOString(),
      kill: () => abortController.abort(),
    });

    // Per-turn agent identity for the MCP-backed board tools: status
    // changes land attributed to `agent`, scoped to this project. The
    // fetch base is the app's own constant base URL (never the request's
    // Host header, which a DNS-rebound origin could control and would then
    // receive the bearer token).
    const toolSessionId = `chat-tools-${activityId}`;
    const toolContext: ChatBoardToolContext | null = chatToolsEnabled
      ? {
          projectId,
          baseUrl: getAppBaseUrl(),
          mcpToken: mintMcpToken({
            sessionId: toolSessionId,
            projectId,
            epicId: null,
            userStoryId: null,
            agentType: "chat",
          }),
          signal: abortController.signal,
        }
      : null;
    let toolChannelReleased = false;
    const releaseToolChannel = () => {
      if (toolChannelReleased) return;
      toolChannelReleased = true;
      if (toolContext) revokeMcpTokensForSession(toolSessionId);
    };

    let clientCancelled = false;
    let fullContent = "";
    const sseStream = new ReadableStream({
      async start(controller) {
        try {
          const messages = [...openAiMessages];
          let toolsEnabled = chatToolsEnabled;
          let round = 0;
          while (round < MAX_TOOL_ROUNDS) {
            round += 1;
            let roundText = "";
            let toolCalls: OpenAiToolCall[] = [];
            try {
              for await (const event of streamOpenAiChatEvents(
                openAiConfig,
                messages,
                {
                  tools: toolsEnabled ? CHAT_BOARD_TOOL_DEFINITIONS : undefined,
                  signal: abortController.signal,
                },
              )) {
                if (event.type === "text") {
                  // Separate this round's text from the previous round's.
                  const delta =
                    roundText === "" && fullContent.length > 0
                      ? `\n\n${event.text}`
                      : event.text;
                  roundText += event.text;
                  fullContent += delta;
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)
                  );
                } else {
                  toolCalls = event.toolCalls;
                }
              }
            } catch (error) {
              if (
                toolsEnabled &&
                round === 1 &&
                fullContent === "" &&
                isLikelyToolsRejection(error)
              ) {
                // Retry the turn without tools — and without the system
                // section promising them, so the model does not answer
                // board questions from imagination.
                toolsEnabled = false;
                round = 0;
                if (messages[0]?.role === "system") {
                  const noToolsSystemContent = fastModeSystemPrompt.trim();
                  if (noToolsSystemContent) {
                    messages[0] = { role: "system", content: noToolsSystemContent };
                  } else {
                    messages.shift();
                  }
                }
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      status:
                        "Board tools unavailable on this endpoint — continuing without them.",
                    })}\n\n`
                  )
                );
                continue;
              }
              throw error;
            }

            if (abortController.signal.aborted) break;
            if (toolCalls.length === 0) break;

            messages.push({
              role: "assistant",
              content: roundText,
              tool_calls: toolCalls,
            });
            if (round === MAX_TOOL_ROUNDS) {
              const note = `${fullContent ? "\n\n" : ""}[Stopped: tool budget of ${MAX_TOOL_ROUNDS} rounds exhausted.]`;
              fullContent += note;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ delta: note })}\n\n`)
              );
              break;
            }
            if (!toolContext) {
              // A server emitted tool_calls although none were advertised —
              // treat the round as final rather than execute anything.
              break;
            }
            for (const [callIndex, call] of toolCalls.entries()) {
              // The protocol wants one tool reply per call id; overflow
              // calls get an error payload instead of an execution.
              if (callIndex >= MAX_TOOL_CALLS_PER_ROUND) {
                messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    error: `Skipped: more than ${MAX_TOOL_CALLS_PER_ROUND} tool calls in one round.`,
                  }),
                });
                continue;
              }
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ status: `Using ${call.function.name}...` })}\n\n`
                )
              );
              const resultJson = await executeChatBoardTool(call, toolContext);
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: resultJson,
              });
            }
          }
          releaseToolChannel();
          activityRegistry.unregister(activityId);
          if (abortController.signal.aborted) {
            if (!clientCancelled) {
              if (fullContent.length > 0) {
                saveAssistantAndTitle(controller, fullContent, "active");
              } else {
                setConversationStatus("active");
                controller.close();
              }
            } else {
              setConversationStatus("active");
            }
            return;
          }
          saveAssistantAndTitle(controller, fullContent, "active");
        } catch (error) {
          releaseToolChannel();
          if (abortController.signal.aborted) {
            // Client disconnected or the activity was killed.
            activityRegistry.unregister(activityId);
            if (!clientCancelled) {
              if (fullContent.length > 0) {
                saveAssistantAndTitle(controller, fullContent, "active");
              } else {
                setConversationStatus("active");
                controller.close();
              }
            } else {
              setConversationStatus("active");
            }
            return;
          }
          const failureMessage =
            error instanceof Error &&
            error.message.startsWith("OpenAI-compatible API error:")
              ? error.message
              : `OpenAI-compatible API error: ${
                  error instanceof Error ? error.message : "request failed"
                }`;
          const isMidStream = fullContent.length > 0;
          fullContent = isMidStream
            ? `${fullContent}\n\n${failureMessage}`
            : failureMessage;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                delta: isMidStream ? `\n\n${failureMessage}` : failureMessage,
              })}\n\n`
            )
          );
          activityRegistry.unregister(activityId);
          saveAssistantAndTitle(controller, fullContent, "error");
        }
      },
      cancel() {
        clientCancelled = true;
        releaseToolChannel();
        activityRegistry.unregister(activityId);
        abortController.abort();
        setConversationStatus("active");
      },
    });

    return sseResponse(sseStream);
  }

  if (!isEpicCreation) {
    prompt = buildChatPrompt(project, [], fullHistory, chatSystemPrompt);
  }

  try {
    prompt = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: [body.content, ...fullHistory.map((m) => m.content)],
    }).prompt;
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  const providerSupportsResume = isResumableProvider(resolvedAgent.provider);
  // Legacy-row fallback handled inside resolveCliSessionId().
  let cliSessionId = conversation
    ? resolveCliSessionId(conversation) ?? undefined
    : undefined;
  const resumeSession = Boolean(conversationId && cliSessionId && providerSupportsResume);
  // Only mint for providers that take a caller-chosen id — pi reports its own.
  if (!cliSessionId && providerAcceptsAssignedSessionId(resolvedAgent.provider)) {
    cliSessionId = crypto.randomUUID();
  }
  // A resumed session already carries the conversation, so the new user text is
  // normally enough. Finalization is the exception: the strict JSON output
  // contract lives in the built prompt, and sending only "Generate the final
  // epic…" makes the CLI answer in prose (or with an `epics` array), which the
  // client parser then rejects. Always send the full prompt for that turn.
  const isEpicFinalization =
    finalize && isEpicCreationConversationAgentType(conversationType);
  const effectivePrompt = resumeSession && !isEpicFinalization ? userContent : prompt;

  function persistConversationSessionId(nextCliSessionId?: string) {
    if (!conversationId || !nextCliSessionId) return;
    db.update(chatConversations)
      .set({ cliSessionId: nextCliSessionId })
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  /**
   * Forgets a CLI session the provider no longer has. Without this the next
   * turn re-reads the same dead id and resumes into the same failure.
   */
  function clearConversationSessionId() {
    if (!conversationId) return;
    db.update(chatConversations)
      .set({ cliSessionId: null })
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  setConversationStatus("generating");

  // Determine conversation label for activity registry
  const activityLabel =
    conversation?.label ? `Chat: ${conversation.label}` : "Chat";
  const activityId = `chat-${createId()}`;

  // Claude chat turns run in "chat" mode (permission mode "default" with a
  // read-only repo allowlist). Prompt-contract conversations remain in plan.
  const claudeChatMode = isEpicCreationConversationAgentType(conversationType)
    ? ("plan" as const)
    : ("chat" as const);

  if (persistentProvider && conversationId) {
    let currentKill = () => {};
    let fullContent = "";
    let persistentChunkSink: ((chunk: StreamChunk) => void) | null = null;

    const launchPersistentTurn = (
      turnPrompt: string,
      turnCliSessionId: string | undefined,
      turnResumeSession: boolean,
    ) =>
      runPersistentChatTurn({
      conversationId,
      projectId,
      provider: persistentProvider,
      prompt: turnPrompt,
      cwd: project.gitRepoPath || process.cwd(),
      mode: claudeChatMode,
      model: resolvedAgent.model,
      cliSessionId: turnCliSessionId,
      resumeSession: turnResumeSession,
      conversationType,
      idleTimeoutMs: parsePersistentChatDurationSetting(
        settingValue(PERSISTENT_CHAT_IDLE_TIMEOUT_SETTING),
        DEFAULT_PERSISTENT_CHAT_IDLE_TIMEOUT_MS,
      ),
      maxWarmConversations: parsePersistentChatCapSetting(
        settingValue(PERSISTENT_CHAT_MAX_CONVERSATIONS_SETTING),
        DEFAULT_MAX_WARM_CHAT_CONVERSATIONS,
      ),
      turnStallTimeoutMs: parsePersistentChatDurationSetting(
        settingValue(PERSISTENT_CHAT_TURN_STALL_SETTING),
        DEFAULT_PERSISTENT_CHAT_TURN_STALL_MS,
      ),
      onChunk(chunk) {
        // Assigned by the stream start below before the process can emit a
        // model event (runPersistentChatTurn begins on the next microtask).
        persistentChunkSink?.(chunk);
      },
      onCliSessionId(nextCliSessionId) {
        cliSessionId = nextCliSessionId;
        persistConversationSessionId(nextCliSessionId);
      },
    });

    const turn = launchPersistentTurn(effectivePrompt, cliSessionId, resumeSession);
    currentKill = turn.kill;

    activityRegistry.register({
      id: activityId,
      projectId,
      type: "chat",
      label: activityLabel,
      provider: resolvedAgent.provider,
      namedAgentName: resolvedAgent.name ?? null,
      startedAt: new Date().toISOString(),
      kill: () => currentKill(),
    });

    const sseStream = new ReadableStream({
      async start(controller) {
        persistentChunkSink = (chunk) => {
          if (chunk.type === "text") {
            fullContent += chunk.text;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ delta: chunk.text })}\n\n`),
            );
          } else if (chunk.type === "questions") {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ questions: chunk.questions })}\n\n`,
              ),
            );
          } else {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ status: chunk.status })}\n\n`,
              ),
            );
          }
        };
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              status: turn.wasWarm
                ? `${PROVIDER_LABELS[persistentProvider]} session is warm`
                : resumeSession
                  ? `Restarting and resuming ${PROVIDER_LABELS[persistentProvider]} session...`
                  : `Starting ${PROVIDER_LABELS[persistentProvider]} session...`,
            })}\n\n`,
          ),
        );

        try {
          await turn.promise;
          activityRegistry.unregister(activityId);
          saveAssistantAndTitle(controller, fullContent, "active");
        } catch (error) {
          // Resume-first, same as the one-shot paths below: the CLI prunes its
          // own session files (Claude Code after `cleanupPeriodDays`), and a
          // stored id that has gone away would otherwise fail every future
          // turn in this conversation with no in-app way out — "Restart
          // session" only kills the process, it does not forget the dead id.
          // Guarded on empty output so a mid-answer failure cannot splice two
          // replies together.
          const resumeExpired =
            resumeSession &&
            !fullContent &&
            error instanceof Error &&
            isResumeSessionExpiredError(error.message);
          if (resumeExpired) {
            restartPersistentChatSession(conversationId);
            clearConversationSessionId();
            // A fresh session has no history, so it needs the full prompt
            // rather than the resume path's bare user message.
            cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
              ? crypto.randomUUID()
              : undefined;
            enqueueIfOpen(
              controller,
              `data: ${JSON.stringify({
                status: `Stored ${PROVIDER_LABELS[persistentProvider]} session expired; starting a fresh one...`,
              })}\n\n`,
            );
            const retry = launchPersistentTurn(prompt, cliSessionId, false);
            currentKill = retry.kill;
            try {
              await retry.promise;
              activityRegistry.unregister(activityId);
              saveAssistantAndTitle(controller, fullContent, "active");
              return;
            } catch (retryError) {
              error = retryError;
            }
          }
          const failureMessage =
            error instanceof Error ? `Error: ${error.message}` : "Error: Provider request failed";
          const delta = fullContent ? `\n\n${failureMessage}` : failureMessage;
          fullContent += delta;
          enqueueIfOpen(controller, `data: ${JSON.stringify({ delta })}\n\n`);
          activityRegistry.unregister(activityId);
          saveAssistantAndTitle(controller, fullContent, "error");
        } finally {
          persistentChunkSink = null;
        }
      },
      cancel() {
        persistentChunkSink = null;
        activityRegistry.unregister(activityId);
        currentKill();
        setConversationStatus("active");
      },
    });

    return sseResponse(sseStream);
  }

  // Per-turn Arij MCP tool channel for CLI chat providers (claude-code,
  // codex, oh-my-pi): the spawned CLI gets the chat toolset of arij board
  // tools, spelled per provider (mcp__arij__* on claude/codex, mcp__arij_*
  // on omp) — parity with the fast-mode board tools above. Null when the
  // provider has no MCP surface, the toggle is off, or the conversation is
  // an epic-creation/brainstorm prompt contract. The token must be revoked
  // on every completion path below (success, error, client cancel).
  const cliToolChannel = createChatCliToolChannel({
    projectId,
    provider: resolvedAgent.provider,
    conversationType,
  });

  // Every non-Claude provider: non-streaming, spawned through its own provider
  if (resolvedAgent.provider !== "claude-code") {
    // "openai-compatible" is not a CLI provider: that branch returned above.
    const dynamicProvider = getProvider(resolvedAgent.provider as ProviderType);
    let activeProviderSession = dynamicProvider.spawn({
      sessionId: `chat-${createId()}`,
      prompt: effectivePrompt,
      cwd: project.gitRepoPath || process.cwd(),
      mode: "plan",
      model: resolvedAgent.model,
      logIdentifier: conversationId || `chat-${projectId}`,
      cliSessionId,
      resumeSession,
      mcp: cliToolChannel?.mcp,
      // A chat turn has no agent_sessions row, so it never reaches
      // processManager.start() — the agent's CLI options are carried here,
      // the same way cliToolChannel carries the MCP channel.
      cliOptions: resolvedAgent.cliOptions,
    });

    activityRegistry.register({
      id: activityId,
      projectId,
      type: "chat",
      label: activityLabel,
      provider: resolvedAgent.provider,
      namedAgentName: resolvedAgent.name ?? null,
      startedAt: new Date().toISOString(),
      kill: () => activeProviderSession.kill(),
    });

    const sseStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              status: `${
                PROVIDER_LABELS[resolvedAgent.provider]
              } processing...`,
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
            cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
              ? crypto.randomUUID()
              : undefined;
            activeProviderSession = dynamicProvider.spawn({
              sessionId: `chat-${createId()}`,
              prompt,
              cwd: project.gitRepoPath || process.cwd(),
              mode: "plan",
              model: resolvedAgent.model,
              logIdentifier: conversationId || `chat-${projectId}`,
              cliSessionId,
              resumeSession: false,
              mcp: cliToolChannel?.mcp,
            });
            result = await activeProviderSession.promise;
          }

          cliToolChannel?.release();

          const fullContent = result.success
            ? parseClaudeOutput(result.result || "").content || "(empty response)"
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
          cliToolChannel?.release();
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
        cliToolChannel?.release();
        activityRegistry.unregister(activityId);
        activeProviderSession.kill();
        setConversationStatus("active");
      },
    });

    return sseResponse(sseStream);
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
      namedAgentName: resolvedAgent.name ?? null,
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
            mode: claudeChatMode,
            prompt: effectivePrompt,
            model: resolvedAgent.model,
            cwd: project.gitRepoPath || undefined,
            logIdentifier: conversationId || `chat-${projectId}`,
            cliSessionId: resultSessionId,
            resumeSession: true,
            mcp: cliToolChannel?.mcp,
            cliOptions: resolvedAgent.cliOptions,
          });
          currentKill = attempt.kill;
          let result = await attempt.promise;

          if (!result.success && isResumeSessionExpiredError(result.error)) {
            resultSessionId = crypto.randomUUID();
            attempt = spawnClaude({
              mode: claudeChatMode,
              prompt,
              model: resolvedAgent.model,
              cwd: project.gitRepoPath || undefined,
              logIdentifier: conversationId || `chat-${projectId}`,
              cliSessionId: resultSessionId,
              mcp: cliToolChannel?.mcp,
              cliOptions: resolvedAgent.cliOptions,
            });
            currentKill = attempt.kill;
            result = await attempt.promise;
          }

          cliToolChannel?.release();

          const fullContent = result.success
            ? parseClaudeOutput(result.result || "").content || "(empty response)"
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
          cliToolChannel?.release();
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
        cliToolChannel?.release();
        activityRegistry.unregister(activityId);
        currentKill();
        setConversationStatus("active");
      },
    });

    return sseResponse(sseStream);
  }

  // Claude Code fresh-session path: preserve stream-json UX.
  const { stream: claudeStream, kill } = spawnClaudeStream({
    mode: claudeChatMode,
    prompt: effectivePrompt,
    model: resolvedAgent.model,
    cwd: project.gitRepoPath || undefined,
    logIdentifier: conversationId || `chat-${projectId}`,
    cliSessionId,
    mcp: cliToolChannel?.mcp,
    cliOptions: resolvedAgent.cliOptions,
  });

  activityRegistry.register({
    id: activityId,
    projectId,
    type: "chat",
    label: activityLabel,
    provider: "claude-code",
    namedAgentName: resolvedAgent.name ?? null,
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

      cliToolChannel?.release();
      activityRegistry.unregister(activityId);
      if (!hasStreamError) {
        persistConversationSessionId(cliSessionId);
      }

      saveAssistantAndTitle(controller, fullContent, hasStreamError ? "error" : "active");
    },
    cancel() {
      cliToolChannel?.release();
      activityRegistry.unregister(activityId);
      kill();
      setConversationStatus("active");
    },
  });

    return sseResponse(sseStream);
}
