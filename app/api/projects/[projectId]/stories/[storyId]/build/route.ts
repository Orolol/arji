import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  epics,
  ticketComments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getEpicOr404,
  getProjectOr404,
  getStoryOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import { buildTicketBuildPrompt } from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import { agentScheduler } from "@/lib/agents/scheduler";
import fs from "fs";
import path from "path";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import {
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import {
  buildEpicTargetUrl,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import {
  resolvePipelineEnabled,
  startPipelineRun,
  type PipelineStageResult,
} from "@/lib/pipeline";
import {
  finalizeBuildTerminalOutcome,
  resolveBuildSessionResult,
  transitionBuildStarted,
  WorkflowTransitionError,
} from "@/lib/workflow/automatic-transitions";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;
  const body = await request.json().catch(() => ({}));
  const namedAgentId: string | null = body.namedAgentId || null;
  // Autonomous pipeline flag: an explicit boolean forces on/off; absent, the
  // pipeline_enabled setting chain decides (default OFF).
  const pipelineParam: boolean | undefined =
    typeof body.pipeline === "boolean" ? body.pipeline : undefined;

  // Validate story exists (project-scoped)
  const foundStory = getStoryOr404(projectId, storyId);
  if (isErrorResponse(foundStory)) return foundStory;
  const { story } = foundStory;

  // Validate status
  if (!["todo", "in_progress", "review"].includes(story.status ?? "")) {
    return NextResponse.json(
      { error: "Story must be in todo, in_progress, or review status to send to dev" },
      { status: 400 }
    );
  }

  // Get epic (project-scoped)
  const foundEpic = getEpicOr404(projectId, story.epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  // Get project
  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

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
    epic.title,
    { defaultBranch: project.defaultBranch }
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

  // Only user-written text can reference an Arij document; an agent comment
  // mentioning a codebase file must neither resolve nor block the build.
  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [body.comment, ...userAuthoredTexts(comments)],
  });
  const enrichedPrompt = mentionEnrichment.prompt;
  createUnresolvedMentionsNotification({
    projectId,
    missing: mentionEnrichment.missing,
    agentType: "ticket_build",
    targetUrl: buildEpicTargetUrl(projectId, epic.id),
  });

  const resolvedAgent = resolveAgentByNamedId("ticket_build", projectId, namedAgentId);

  // Resume support — scope-guarded
  let cliSessionId: string | undefined;
  let resumeSession = false;
  if (isResumableProvider(resolvedAgent.provider) && body.resumeSessionId) {
    const validated = validateResumeSession({
      resumeSessionId: body.resumeSessionId,
      epicId: epic.id,
      userStoryId: storyId,
      expectedProvider: resolvedAgent.provider,
    });
    if (validated) {
      cliSessionId = validated.cliSessionId;
      resumeSession = true;
    }
  }
  if (!cliSessionId && providerAcceptsAssignedSessionId(resolvedAgent.provider)) {
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

  try {
    transitionBuildStarted({
      projectId,
      epicId: epic.id,
      scope: "story",
      userStoryId: storyId,
      sessionId,
    });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  // Branch metadata is separate from the guarded status transition.
  db.update(epics)
    .set({ branchName, updatedAt: now })
    .where(eq(epics.id, epic.id))
    .run();

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
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType: "ticket_build",
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
    createdAt: now,
  });

  // Batch-style launch via the per-project scheduler: the session stays
  // 'queued' until a slot frees, then the closure spawns the agent, waits
  // for completion, updates the DB, and posts the agent comment. It returns
  // the {success, outcome, error} triple so the pipeline's settle wrapper
  // can observe the terminal result.
  const runBuildSession = async () => {
    markSessionRunning(sessionId);
    processManager.start(sessionId, {
      mode: "code",
      prompt: enrichedPrompt,
      cwd: worktreePath,
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
      model: resolvedAgent.model,
      cliSessionId,
      resumeSession,
    }, resolvedAgent.provider);

    const info = await waitForProcessCompletion(sessionId);

    const completedAt = new Date().toISOString();
    const result = info?.result;

    // Write logs
    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // ignore
    }

    // Update session
    const outcome = classifySessionOutcome(result, sessionId);

    try {
      markSessionTerminal(
        sessionId,
        {
          success: !!result?.success,
          error: result?.error || null,
          outcome,
          usage: extractSessionUsage(result),
        },
        completedAt
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error("[story build] Failed to finalize session", error);
      }
    }

    const terminal = finalizeBuildTerminalOutcome({
      projectId,
      epicId: epic.id,
      scope: "story",
      userStoryId: storyId,
      sessionId,
      success: !!result?.success,
      outcome,
      error: result?.error,
    });

    // Post agent output as comment
    const output = resolveSessionOutput(result, sessionId);

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

    return resolveBuildSessionResult(terminal, {
      success: !!result?.success,
      outcome,
      error: result?.error ?? null,
    });
  };

  // Autonomous pipeline: when active, wrap the launch closure with the
  // settle pattern (copied from the batch route's launchEpic) so the run's
  // engine can await this build's terminal state, then start the run.
  const pipelineActive = pipelineParam ?? resolvePipelineEnabled(projectId);

  let pipeline: { runId: string } | null = null;
  if (pipelineActive) {
    let settleLaunch!: (result: PipelineStageResult) => void;
    const settled = new Promise<PipelineStageResult>((resolve) => {
      settleLaunch = resolve;
    });

    agentScheduler.submit(projectId, sessionId, async () => {
      try {
        settleLaunch({ sessionId, ...(await runBuildSession()) });
      } catch (error) {
        // The scheduler's safety net finalizes the session row; the
        // pipeline only needs to know this stage settled as failed.
        settleLaunch({
          sessionId,
          success: false,
          outcome: "error",
          error:
            error instanceof Error ? error.message : "Agent launch failed",
        });
        throw error;
      }
    });

    pipeline = startPipelineRun({
      projectId,
      scope: "story",
      epicId: epic.id,
      userStoryId: storyId,
      buildSessionId: sessionId,
      buildProvider: resolvedAgent.provider,
      buildNamedAgentId: namedAgentId,
      buildSettled: settled,
    });
  } else {
    agentScheduler.submit(projectId, sessionId, async () => {
      await runBuildSession();
    });
  }

  return NextResponse.json({
    data: { sessionId, branchName, worktreePath, pipeline },
  });
}
