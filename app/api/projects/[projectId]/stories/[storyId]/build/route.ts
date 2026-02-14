import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  ticketComments,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { buildTicketBuildPrompt } from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import { resolveAgentByNamedId } from "@/lib/agent-config/providers";
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
import { agentSessions } from "@/lib/db/schema";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;
  const body = await request.json().catch(() => ({}));
  const namedAgentId: string | null = body.namedAgentId || null;

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
  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.userStoryId, storyId))
    .orderBy(ticketComments.createdAt)
    .all();

  const ticketBuildSystemPrompt = await resolveAgentPrompt(
    "ticket_build",
    projectId
  );

  // Create worktree (reuses existing)
  const { worktreePath, branchName } = await createWorktree(
    gitRepoPath,
    epic.id,
    epic.title
  );

  // Build prompt
  const prompt = buildTicketBuildPrompt(
    project,
    [],
    epic,
    story,
    comments.map((c) => ({
      author: c.author as "user" | "agent",
      content: c.content,
      createdAt: c.createdAt ?? "",
    })),
    ticketBuildSystemPrompt
  );

  let enrichedPrompt = prompt;
  try {
    enrichedPrompt = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: [body.comment, ...comments.map((c) => c.content)],
    }).prompt;
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const resolvedAgent = resolveAgentByNamedId("ticket_build", projectId, namedAgentId);

  const providerSupportsResume =
    resolvedAgent.provider === "claude-code" || resolvedAgent.provider === "gemini-cli";

  // Resume support
  let cliSessionId: string | undefined;
  let resumeSession = false;
  if (providerSupportsResume && body.resumeSessionId) {
    const prevSession = db
      .select({
        cliSessionId: agentSessions.cliSessionId,
        claudeSessionId: agentSessions.claudeSessionId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, body.resumeSessionId))
      .get();
    const previousCliSessionId =
      prevSession?.cliSessionId ?? prevSession?.claudeSessionId ?? null;
    if (previousCliSessionId) {
      cliSessionId = previousCliSessionId;
      resumeSession = true;
    }
  }
  if (!cliSessionId && providerSupportsResume) {
    cliSessionId = crypto.randomUUID();
  }

  // Create session
  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");

  // Check concurrency guard
  const conflict = getRunningSessionForTarget({
    scope: "story",
    projectId,
    storyId,
    epicId: epic.id,
  });
  if (conflict) {
    return NextResponse.json(
      createAgentAlreadyRunningPayload(
        { scope: "story", projectId, storyId, epicId: epic.id },
        conflict,
        "Another agent is already running for this story."
      ),
      { status: 409 }
    );
  }

  createQueuedSession({
    id: sessionId,
    projectId,
    epicId: epic.id,
    userStoryId: storyId,
    mode: "code",
    provider: resolvedAgent.provider,
    prompt: enrichedPrompt,
    logsPath,
    branchName,
    worktreePath,
    claudeSessionId: cliSessionId,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType: "ticket_build",
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
    createdAt: now,
  });

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

  // Spawn agent
  markSessionRunning(sessionId, now);
  processManager.start(sessionId, {
    mode: "code",
    prompt: enrichedPrompt,
    cwd: worktreePath,
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
    model: resolvedAgent.model,
    cliSessionId,
    resumeSession,
  }, resolvedAgent.provider);

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
        console.error("[story build] Failed to finalize session", error);
      }
    }

    // On success: move story to review (not done — requires review/approval first)
    if (result?.success) {
      db.update(userStories)
        .set({ status: "review" })
        .where(
          and(
            eq(userStories.id, storyId),
            eq(userStories.status, "in_progress")
          )
        )
        .run();

      // Check if all stories in the epic are now done or in review
      const allStories = db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epic.id))
        .all();

      const allReviewOrDone = allStories.every(
        (s) => s.id === storyId || s.status === "done" || s.status === "review"
      );

      if (allReviewOrDone) {
        db.update(epics)
          .set({ status: "review", updatedAt: completedAt })
          .where(eq(epics.id, epic.id))
          .run();
      }
    }

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
