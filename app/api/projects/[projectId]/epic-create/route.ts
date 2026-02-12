import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, documents, epics, userStories, settings, chatConversations } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaude } from "@/lib/claude/spawn";
import { buildEpicCreationPrompt } from "@/lib/claude/prompt-builder";
import { readArjiJson } from "@/lib/sync/arji-json";
import { exportArjiJson, tryExportArjiJson } from "@/lib/sync/export";
import { getProvider } from "@/lib/providers";
import type { ProviderType } from "@/lib/providers";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = await request.json();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages array is required" }, { status: 400 });
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.gitRepoPath) {
    return NextResponse.json({ error: "Project has no git repo path configured" }, { status: 400 });
  }

  // Update conversation status to "generating" if conversationId provided
  if (body.conversationId) {
    db.update(chatConversations)
      .set({ status: "generating" })
      .where(eq(chatConversations.id, body.conversationId))
      .run();
  }

  const docs = db.select().from(documents).where(eq(documents.projectId, projectId)).all();

  const settingsRow = db.select().from(settings).where(eq(settings.key, "global_prompt")).get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  const prompt = buildEpicCreationPrompt(
    project,
    docs,
    body.messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    globalPrompt,
  );

  try {
    // 1. Snapshot current epic IDs before Claude runs
    const existingEpicIds = new Set(
      db.select({ id: epics.id })
        .from(epics)
        .where(eq(epics.projectId, projectId))
        .all()
        .map((e) => e.id)
    );

    // 2. Export current arji.json so Claude sees up-to-date data
    await exportArjiJson(projectId);

    // Determine provider from conversation
    let provider: ProviderType = "claude-code";
    if (body.conversationId) {
      const conv = db.select().from(chatConversations).where(eq(chatConversations.id, body.conversationId)).get();
      if (conv?.provider === "codex") {
        provider = "codex";
      }
    }

    // 3. Spawn agent in analyze/code mode (can read + write files)
    console.log(`[epic-create] Spawning ${provider} CLI, cwd:`, project.gitRepoPath);

    const agentProvider = getProvider(provider);
    const session = agentProvider.spawn({
      sessionId: `epic-create-${createId()}`,
      prompt,
      cwd: project.gitRepoPath,
      mode: "analyze",
    });

    const result = await session.promise;

    if (!result.success) {
      // Update conversation status to "error"
      if (body.conversationId) {
        db.update(chatConversations)
          .set({ status: "error" })
          .where(eq(chatConversations.id, body.conversationId))
          .run();
      }
      return NextResponse.json(
        { error: result.error || "Claude Code failed" },
        { status: 500 },
      );
    }

    // 4. Read the updated arji.json
    const arjiData = await readArjiJson(project.gitRepoPath);
    if (!arjiData) {
      if (body.conversationId) {
        db.update(chatConversations)
          .set({ status: "error" })
          .where(eq(chatConversations.id, body.conversationId))
          .run();
      }
      return NextResponse.json(
        { error: "arji.json not found after Claude run" },
        { status: 500 },
      );
    }

    // 5. Find new epics: IDs in arji.json that were NOT in the "before" snapshot
    const newEpics = arjiData.epics.filter((e) => !existingEpicIds.has(e.id));

    if (newEpics.length === 0) {
      if (body.conversationId) {
        db.update(chatConversations)
          .set({ status: "error" })
          .where(eq(chatConversations.id, body.conversationId))
          .run();
      }
      return NextResponse.json(
        { error: "Claude did not add any new epics to arji.json" },
        { status: 500 },
      );
    }

    const now = new Date().toISOString();
    let firstEpicId: string | null = null;
    let firstEpicTitle = "";
    let totalStoriesCreated = 0;

    // 6. Insert only the new epic(s) + their user stories into DB
    // Replace Claude-generated IDs with proper nanoid(12) IDs
    for (const epicData of newEpics) {
      const epicId = createId();
      if (!firstEpicId) {
        firstEpicId = epicId;
        firstEpicTitle = epicData.title;
      }

      // Compute max position for backlog epics
      const maxPos = db
        .select({ max: sql<number>`COALESCE(MAX(position), -1)` })
        .from(epics)
        .where(and(eq(epics.projectId, projectId), eq(epics.status, "backlog")))
        .get();

      db.insert(epics)
        .values({
          id: epicId,
          projectId,
          title: epicData.title,
          description: epicData.description || null,
          priority: epicData.priority ?? 1,
          status: "backlog",
          position: (maxPos?.max ?? -1) + 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      if (epicData.user_stories) {
        for (let j = 0; j < epicData.user_stories.length; j++) {
          const usData = epicData.user_stories[j];
          db.insert(userStories)
            .values({
              id: createId(),
              epicId,
              title: usData.title,
              description: usData.description || null,
              acceptanceCriteria: usData.acceptance_criteria || null,
              status: "todo",
              position: j,
              createdAt: now,
            })
            .run();
          totalStoriesCreated++;
        }
      }
    }

    // 7. Update conversation label, epicId, and status
    if (body.conversationId && firstEpicId) {
      db.update(chatConversations)
        .set({
          label: `Epic: ${firstEpicTitle}`,
          epicId: firstEpicId,
          status: "generated",
        })
        .where(eq(chatConversations.id, body.conversationId))
        .run();
    }

    // 8. Re-export arji.json to keep DB and file in sync (IDs were replaced)
    tryExportArjiJson(projectId);

    return NextResponse.json({
      data: {
        epicId: firstEpicId,
        title: firstEpicTitle,
        userStoriesCreated: totalStoriesCreated,
      },
    });
  } catch (e) {
    // Update conversation status to "error"
    if (body.conversationId) {
      db.update(chatConversations)
        .set({ status: "error" })
        .where(eq(chatConversations.id, body.conversationId))
        .run();
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
