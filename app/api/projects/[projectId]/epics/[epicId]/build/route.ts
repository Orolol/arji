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
import { eq, and, notInArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { buildBuildPrompt } from "@/lib/claude/prompt-builder";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import fs from "fs";
import path from "path";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

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
  const { projectId, epicId } = await params;
  const body = await request.json().catch(() => ({}));

  // Validate epic exists
  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  // Validate status
  if (!["backlog", "todo", "in_progress", "review"].includes(epic.status ?? "")) {
    return NextResponse.json(
      { error: "Epic must be in backlog, todo, in_progress, or review status to build" },
      { status: 400 }
    );
  }

  // Concurrency guard
  if (hasRunningBuildForEpic(epicId)) {
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

  // Post optional comment as epic comment
  if (body.comment && body.comment.trim()) {
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
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

  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const settingsRow = db
    .select()
    .from(settings)
    .where(eq(settings.key, "global_prompt"))
    .get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  // Create worktree
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  // Build prompt
  const prompt = buildBuildPrompt(project, docs, epic, us, globalPrompt);

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
      epicId,
      status: "running",
      mode: "code",
      prompt,
      logsPath,
      branchName,
      worktreePath,
      startedAt: now,
      createdAt: now,
    })
    .run();

  // Status sync: epic -> in_progress, non-done US -> in_progress
  db.update(epics)
    .set({ status: "in_progress", branchName, updatedAt: now })
    .where(eq(epics.id, epicId))
    .run();

  db.update(userStories)
    .set({ status: "in_progress" })
    .where(
      and(
        eq(userStories.epicId, epicId),
        notInArray(userStories.status, ["done"])
      )
    )
    .run();

  // Spawn Claude Code
  processManager.start(sessionId, {
    mode: "code",
    prompt,
    cwd: worktreePath,
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
  });

  // Background: wait for completion, sync statuses, post agent comment
  (async () => {
    let info = processManager.getStatus(sessionId);
    while (info && info.status === "running") {
      await new Promise((r) => setTimeout(r, 2000));
      info = processManager.getStatus(sessionId);
    }

    const completedAt = new Date().toISOString();
    const result = info?.result;

    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // ignore
    }

    db.update(agentSessions)
      .set({
        status: result?.success ? "completed" : "failed",
        completedAt,
        error: result?.error || null,
      })
      .where(eq(agentSessions.id, sessionId))
      .run();

    // On success: in_progress US -> review, epic -> review
    if (result?.success) {
      db.update(userStories)
        .set({ status: "review" })
        .where(
          and(
            eq(userStories.epicId, epicId),
            eq(userStories.status, "in_progress")
          )
        )
        .run();

      db.update(epics)
        .set({ status: "review", updatedAt: completedAt })
        .where(eq(epics.id, epicId))
        .run();
    }

    // Post output as epic comment
    const output = result?.result
      ? parseClaudeOutput(result.result).content
      : result?.error || "Agent session completed without output.";

    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId,
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
