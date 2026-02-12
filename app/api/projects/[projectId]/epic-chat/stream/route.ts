import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { projects, documents, settings, chatMessages, chatConversations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaudeStream, spawnClaude } from "@/lib/claude/spawn";
import { buildEpicRefinementPrompt, buildTitleGenerationPrompt } from "@/lib/claude/prompt-builder";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages array is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const conversationId: string | null = body.conversationId || null;

  function setConversationStatus(status: "active" | "generating" | "error") {
    if (!conversationId) return;
    db.update(chatConversations)
      .set({ status })
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return new Response(JSON.stringify({ error: "Project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const docs = db.select().from(documents).where(eq(documents.projectId, projectId)).all();

  const settingsRow = db.select().from(settings).where(eq(settings.key, "global_prompt")).get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  const prompt = buildEpicRefinementPrompt(
    project,
    docs,
    body.messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    globalPrompt,
  );

  setConversationStatus("generating");

  // Persist user message if conversationId provided
  if (conversationId) {
    const lastUserMsg = body.messages[body.messages.length - 1];
    if (lastUserMsg && lastUserMsg.role === "user") {
      db.insert(chatMessages)
        .values({
          id: createId(),
          projectId,
          conversationId,
          role: "user",
          content: lastUserMsg.content,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
  }

  const { stream: claudeStream, kill } = spawnClaudeStream({
    mode: "plan",
    prompt,
    cwd: project.gitRepoPath || undefined,
    logIdentifier: conversationId || `epic-${projectId}`,
  });

  const encoder = new TextEncoder();
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
        console.error("[epic-chat/stream] Stream error:", err);
        hasStreamError = true;
      }

      // Persist assistant message if conversationId provided
      const assistantMsgId = createId();
      if (conversationId) {
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
        if (fullContent) {
          const msgCount = db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(eq(chatMessages.conversationId, conversationId))
            .all().length;

          if (msgCount === 2) {
            const conv = db.select().from(chatConversations).where(eq(chatConversations.id, conversationId)).get();
            if (conv && (conv.label === "New Epic" || conv.label === "Brainstorm")) {
              const lastUserMsg = body.messages[body.messages.length - 1];
              const userContent = lastUserMsg?.role === "user" ? lastUserMsg.content : body.messages[0]?.content || "";
              const titlePrompt = buildTitleGenerationPrompt(userContent, fullContent);
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
      }

      setConversationStatus(hasStreamError ? "error" : "active");

      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ done: true, messageId: assistantMsgId, content: fullContent })}\n\n`
        )
      );
      controller.close();
    },
    cancel() {
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
