import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  ticketComments,
} from "@/lib/db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { buildBuildPrompt } from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import type { ProviderType } from "@/lib/providers";
import { resolveAgent } from "@/lib/agent-config/providers";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import fs from "fs";
import path from "path";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import {
  MentionResolutionError,
  enrichPromptWithDocumentMentions,
  validateMentionsExist,
} from "@/lib/documents/mentions";
import { listProjectTextDocuments } from "@/lib/documents/query";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json().catch(() => ({}));
  const provider: ProviderType = body.provider || "claude-code";

  try {
    validateMentionsExist({
      projectId,
      textSources: [body.comment],
    });
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

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
  const docs = listProjectTextDocuments(projectId);

  const us = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  // Load epic comments
  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.epicId, epicId))
    .orderBy(ticketComments.createdAt)
    .all();

  const promptComments = comments.map((c) => ({
    author: c.author as "user" | "agent",
    content: c.content,
    createdAt: c.createdAt ?? "",
  }));

  const buildSystemPrompt = await resolveAgentPrompt("build", projectId);

  // Create worktree
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  // Build prompt
  const prompt = buildBuildPrompt(project, docs, epic, us, buildSystemPrompt, promptComments);

  let enrichedPrompt = prompt;
  try {
    enrichedPrompt = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: [body.comment, ...promptComments.map((c) => c.content)],
    }).prompt;
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const resolvedAgent = await resolveAgent("build", projectId, provider);

  // Create session
  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");

  // Check concurrency guard
  const conflict = getRunningSessionForTarget({
    scope: "epic",
    projectId,
    epicId,
  });
  if (conflict) {
    return NextResponse.json(
      createAgentAlreadyRunningPayload(
        { scope: "epic", projectId, epicId },
        conflict,
        "Another agent is already running for this epic."
      ),
      { status: 409 }
    );
  }

  createQueuedSession({
    id: sessionId,
    projectId,
    epicId,
    mode: "code",
    provider: resolvedAgent.provider,
    prompt: enrichedPrompt,
    logsPath,
    branchName,
    worktreePath,
    createdAt: now,
  });

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

  // Spawn agent
  markSessionRunning(sessionId, now);
  processManager.start(sessionId, {
    mode: "code",
    prompt: enrichedPrompt,
    cwd: worktreePath,
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
    model: resolvedAgent.model,
  }, resolvedAgent.provider);

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

    try {
      markSessionTerminal(
        sessionId,
        {
          success: !!result?.success,
          error: result?.error || null,
        },
        completedAt
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error("[epic build] Failed to finalize session", error);
      }
    }

    // On success: all non-done US -> review, epic -> review
    // The ticket should go through review before being moved to done/merged.
    if (result?.success) {
      db.update(userStories)
        .set({ status: "review" })
        .where(
          and(
            eq(userStories.epicId, epicId),
            notInArray(userStories.status, ["done"])
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
