import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { chatMessages, chatAttachments, chatConversations, projects, documents, settings } from "@/lib/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaudeStream, spawnClaude } from "@/lib/claude/spawn";
import { buildChatPrompt, buildTitleGenerationPrompt } from "@/lib/claude/prompt-builder";
import { getProvider } from "@/lib/providers";
import type { ProviderType } from "@/lib/providers";

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

  const conversationId: string | null = body.conversationId || null;
  const attachmentIds: string[] = body.attachmentIds || [];

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

  const docs = db.select().from(documents).where(eq(documents.projectId, projectId)).all();

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

  const settingsRow = db.select().from(settings).where(eq(settings.key, "global_prompt")).get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  const prompt = buildChatPrompt(
    project,
    docs,
    recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    globalPrompt
  );

  // Determine provider from conversation
  let provider: ProviderType = "claude-code";
  if (conversationId) {
    const conv = db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)).get();
    if (conv?.provider === "codex") {
      provider = "codex";
    }
  }

  const encoder = new TextEncoder();

  /**
   * Helper: save assistant message and generate title after stream completes.
   */
  function saveAssistantAndTitle(
    controller: ReadableStreamDefaultController,
    fullContent: string
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

    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ done: true, messageId: assistantMsgId })}\n\n`
      )
    );
    controller.close();
  }

  // Branch on provider
  if (provider === "codex") {
    // Codex: non-streaming — run the full prompt, return result as single SSE event
    const codexProvider = getProvider("codex");
    const session = codexProvider.spawn({
      sessionId: `chat-${createId()}`,
      prompt,
      cwd: project.gitRepoPath || process.cwd(),
      mode: "plan",
    });

    const sseStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ status: "Codex processing..." })}\n\n`)
        );

        const result = await session.promise;
        const fullContent = result.success
          ? result.result || "(empty response)"
          : `Error: ${result.error || "Codex request failed"}`;

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ delta: fullContent })}\n\n`)
        );

        saveAssistantAndTitle(controller, fullContent);
      },
      cancel() {
        session.kill();
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
    prompt,
    cwd: project.gitRepoPath || undefined,
    logIdentifier: conversationId || `chat-${projectId}`,
  });

  let fullContent = "";

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
      }

      saveAssistantAndTitle(controller, fullContent);
    },
    cancel() {
      kill();
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
