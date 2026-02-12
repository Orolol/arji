import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  documents,
  agentSessions,
  ticketComments,
  settings,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { buildTicketBuildPrompt } from "@/lib/claude/prompt-builder";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import type { ProviderType } from "@/lib/providers";
import fs from "fs";
import path from "path";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

/**
 * Concurrency guard: checks if there is already a running code-mode session
 * for the same epic. Prevents parallel code-mode builds on the same worktree.
 */
function hasRunningBuildForEpic(epicId: string): boolean {
  const running = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.epicId, epicId),
        eq(agentSessions.mode, "code"),
        eq(agentSessions.status, "running")
      )
    )
    .all();
  return running.length > 0;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;
  const body = await request.json().catch(() => ({}));
  const provider: ProviderType = body.provider || "claude-code";

  // Validate story exists
  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  // Validate status
  if (!["todo", "in_progress", "review"].includes(story.status ?? "")) {
    return NextResponse.json(
      { error: "Story must be in todo, in_progress, or review status to send to dev" },
      { status: 400 }
    );
  }

  // Get epic
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  if (!epic) {
    return NextResponse.json({ error: "Parent epic not found" }, { status: 404 });
  }

  // Concurrency guard
  if (hasRunningBuildForEpic(epic.id)) {
    return NextResponse.json(
      { error: "Another build is already running for this epic. Wait for it to complete." },
      { status: 409 }
    );
  }

  // Get project
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project has no git repository configured" },
      { status: 400 }
    );
  }

  const gitRepoPath = project.gitRepoPath;
  const isRepo = await isGitRepo(gitRepoPath);
  if (!isRepo) {
    return NextResponse.json(
      { error: `Path is not a git repository: ${gitRepoPath}` },
      { status: 400 }
    );
  }

  // Post optional comment before dispatch
  if (body.comment && body.comment.trim()) {
    const commentId = createId();
    db.insert(ticketComments)
      .values({
        id: commentId,
        userStoryId: storyId,
        author: "user",
        content: body.comment.trim(),
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  // Load context
  const docs = db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .all();

  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.userStoryId, storyId))
    .orderBy(ticketComments.createdAt)
    .all();

  const settingsRow = db
    .select()
    .from(settings)
    .where(eq(settings.key, "global_prompt"))
    .get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  // Create worktree (reuses existing)
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  // Build prompt
  const prompt = buildTicketBuildPrompt(
    project,
    docs,
    epic,
    story,
    comments.map((c) => ({
      author: c.author as "user" | "agent",
      content: c.content,
      createdAt: c.createdAt ?? "",
    })),
    globalPrompt
  );

  // Create session
  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");

  db.insert(agentSessions)
    .values({
      id: sessionId,
      projectId,
      epicId: epic.id,
      userStoryId: storyId,
      status: "running",
      mode: "code",
      provider,
      prompt,
      logsPath,
      branchName,
      worktreePath,
      startedAt: now,
      createdAt: now,
    })
    .run();

  // Move ticket to in_progress
  db.update(userStories)
    .set({ status: "in_progress" })
    .where(eq(userStories.id, storyId))
    .run();

  // Update epic branch info
  db.update(epics)
    .set({ branchName, updatedAt: now })
    .where(eq(epics.id, epic.id))
    .run();

  // Spawn Claude Code
  processManager.start(sessionId, {
    mode: "code",
    prompt,
    cwd: worktreePath,
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
  });

  // Background: wait for completion, update DB, post agent comment
  (async () => {
    let info = processManager.getStatus(sessionId);
    while (info && info.status === "running") {
      await new Promise((r) => setTimeout(r, 2000));
      info = processManager.getStatus(sessionId);
    }

    const completedAt = new Date().toISOString();
    const result = info?.result;

    // Write logs
    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // ignore
    }

    // Update session
    db.update(agentSessions)
      .set({
        status: result?.success ? "completed" : "failed",
        completedAt,
        error: result?.error || null,
      })
      .where(eq(agentSessions.id, sessionId))
      .run();

    // Post agent output as comment
    const output = result?.result
      ? parseClaudeOutput(result.result).content
      : result?.error || "Agent session completed without output.";

    db.insert(ticketComments)
      .values({
        id: createId(),
        userStoryId: storyId,
        author: "agent",
        content: output,
        agentSessionId: sessionId,
        createdAt: completedAt,
      })
      .run();
  })();

  return NextResponse.json({
    data: { sessionId, branchName, worktreePath },
  });
}
