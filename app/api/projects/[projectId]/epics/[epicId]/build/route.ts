import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  epics,
  userStories,
  ticketComments,
  reviewComments,
  agentSessions,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { createId } from "@/lib/utils/nanoid";
import { isBuildableStatus } from "@/lib/types/kanban";
import {
  attachWorktree,
  createWorktree,
  isGitRepo,
  resolveWorktreeHead,
} from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import {
  buildBuildPrompt,
  buildCiFixPrompt,
} from "@/lib/claude/prompt-builder";
import { isVisualProofEnabled } from "@/lib/claude/visual-proof";
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
  createCiAutofixReadyNotification,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  emitSessionStarted,
  emitSessionCompleted,
  emitSessionFailed,
} from "@/lib/events/emit";
import {
  finalizeBuildTerminalOutcome,
  resolveBuildSessionResult,
  transitionBuildStarted,
  WorkflowTransitionError,
} from "@/lib/workflow/automatic-transitions";
import {
  resolvePipelineEnabled,
  startPipelineRun,
  type PipelineStageResult,
} from "@/lib/pipeline";
import {
  ciAutofixAttemptId,
  parseCiAutofixPayload,
} from "@/lib/routines/ci-autofix-shared";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json().catch(() => ({}));
  const ciAutofix =
    body.ciAutofix === undefined ? null : parseCiAutofixPayload(body.ciAutofix);
  if (body.ciAutofix !== undefined && !ciAutofix) {
    return NextResponse.json(
      { error: "Invalid ciAutofix payload" },
      { status: 400 },
    );
  }
  const namedAgentId: string | null = body.namedAgentId || null;
  // Autonomous pipeline flag: an explicit boolean forces on/off; absent, the
  // pipeline_enabled setting chain decides (default OFF).
  const pipelineParam: boolean | undefined =
    typeof body.pipeline === "boolean" ? body.pipeline : undefined;

  // Validate epic exists (project-scoped)
  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;
  const { epic } = foundEpic;

  const ciAutofixRunId = ciAutofix
    ? ciAutofixAttemptId({
        epicId,
        prNumber: ciAutofix.prNumber,
        headSha: ciAutofix.headSha,
      })
    : null;
  const findExistingCiAutofixAttempt = () =>
    ciAutofixRunId
      ? db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.projectId, projectId),
              eq(agentSessions.epicId, epicId),
              eq(agentSessions.batchRunId, ciAutofixRunId),
            ),
          )
          .get()
      : null;
  const existingAttempt = findExistingCiAutofixAttempt();
  if (existingAttempt) {
    return NextResponse.json({
      data: {
        sessionId: existingAttempt.id,
        ciAutofix: { launched: false, reason: "already_attempted" },
      },
    });
  }

  // Validate status — same source of truth as the batch build's guard.
  if (!isBuildableStatus(epic.status)) {
    return NextResponse.json(
      {
        error:
          "Epic must be in backlog, todo, in_progress, or review status to build",
      },
      { status: 400 },
    );
  }

  let ciAutofixBranchName: string | null = null;
  if (ciAutofix) {
    if (!epic.branchName) {
      return NextResponse.json(
        {
          error: "CI autofix requires the epic's persisted pull request branch",
        },
        { status: 400 },
      );
    }
    ciAutofixBranchName = epic.branchName;
  }

  // Get project
  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;

  const gitRepoPath = project.gitRepoPath;
  const isRepo = await isGitRepo(gitRepoPath);
  if (!isRepo) {
    return NextResponse.json(
      { error: `Path is not a git repository: ${gitRepoPath}` },
      { status: 400 },
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

  // Load open review comments (code review feedback)
  const openReviewComments = db
    .select()
    .from(reviewComments)
    .where(
      and(eq(reviewComments.epicId, epicId), eq(reviewComments.status, "open")),
    )
    .orderBy(reviewComments.createdAt)
    .all();

  // Format review comments as additional prompt context
  let reviewContext = "";
  if (openReviewComments.length > 0) {
    const byFile = new Map<string, typeof openReviewComments>();
    for (const rc of openReviewComments) {
      const existing = byFile.get(rc.filePath) || [];
      existing.push(rc);
      byFile.set(rc.filePath, existing);
    }
    const parts = [
      "## Code Review Feedback\n\nThe following review comments were left on your previous changes. Address each one:\n",
    ];
    for (const [filePath, fileComments] of byFile) {
      parts.push(`### ${filePath}`);
      for (const rc of fileComments) {
        parts.push(`- **Line ${rc.lineNumber}**: ${rc.body}`);
      }
      parts.push("");
    }
    reviewContext = parts.join("\n");
  }

  const buildSystemPrompt = await resolveAgentPrompt("build", projectId);

  // A CI autofix must modify the exact branch behind the PR. Deriving a
  // branch from the current epic title could silently cut a new branch from
  // the base branch after the title has been edited.
  const { worktreePath, branchName } = ciAutofixBranchName
    ? await attachWorktree(gitRepoPath, ciAutofixBranchName)
    : await createWorktree(gitRepoPath, epic.id, epic.title, {
        defaultBranch: project.defaultBranch,
      });

  // Build prompt — append review context if present
  let prompt = ciAutofix
    ? buildCiFixPrompt(project, epic, ciAutofix, buildSystemPrompt)
    : buildBuildPrompt(
        project,
        [],
        epic,
        us,
        buildSystemPrompt,
        promptComments,
        { visualProofEnabled: isVisualProofEnabled() },
      );

  // Arij never auto-pushes, so the local branch is routinely ahead of the
  // PR head whose CI logs the agent received. Say so explicitly instead of
  // letting the agent discover — or revert — unseen commits mid-fix.
  if (ciAutofix && ciAutofixBranchName) {
    const worktreeHead = await resolveWorktreeHead(worktreePath);
    if (worktreeHead && worktreeHead !== ciAutofix.headSha) {
      prompt +=
        "\n\n## Important: this branch is ahead of the PR head\n\n" +
        `The worktree tip (${worktreeHead.slice(0, 12)}) differs from the ` +
        `CI-failing PR head (${ciAutofix.headSha.slice(0, 12)}). The extra ` +
        "local commits are intentional; fix the CI failure on top of them " +
        "and do not revert or rewrite them.\n";
    }
  }

  if (reviewContext) {
    prompt = prompt + "\n\n" + reviewContext;
  }

  // Only user-written text can reference an Arij document; an agent comment
  // mentioning a codebase file must neither resolve nor block the build.
  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: [body.comment, ...userAuthoredTexts(promptComments)],
  });
  const enrichedPrompt = mentionEnrichment.prompt;
  createUnresolvedMentionsNotification({
    projectId,
    missing: mentionEnrichment.missing,
    agentType: "build",
    targetUrl: buildEpicTargetUrl(projectId, epicId),
  });

  const resolvedAgent = resolveAgentByNamedId("build", projectId, namedAgentId);

  // Resume support — scope-guarded
  let cliSessionId: string | undefined;
  let resumeSession = false;
  if (
    !ciAutofix &&
    isResumableProvider(resolvedAgent.provider) &&
    body.resumeSessionId
  ) {
    const validated = validateResumeSession({
      resumeSessionId: body.resumeSessionId,
      epicId: epicId,
      expectedProvider: resolvedAgent.provider,
    });
    if (validated) {
      cliSessionId = validated.cliSessionId;
      resumeSession = true;
    }
  }
  if (
    !cliSessionId &&
    providerAcceptsAssignedSessionId(resolvedAgent.provider)
  ) {
    cliSessionId = crypto.randomUUID();
  }

  // Create session
  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");

  // The first lookup happened before repository/worktree preparation. Repeat
  // it immediately before the no-await conflict/transition/insert section so
  // two CI-watch routines that prepared concurrently cannot both persist a
  // session for the same PR head.
  const concurrentAttempt = findExistingCiAutofixAttempt();
  if (concurrentAttempt) {
    return NextResponse.json({
      data: {
        sessionId: concurrentAttempt.id,
        ciAutofix: { launched: false, reason: "already_attempted" },
      },
    });
  }

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
        "Another agent is already running for this epic.",
      ),
      { status: 409 },
    );
  }

  try {
    transitionBuildStarted({
      projectId,
      epicId,
      scope: "epic",
      sessionId,
      reason: ciAutofix
        ? `CI autofix started for PR #${ciAutofix.prNumber} at ${ciAutofix.headSha.slice(0, 12)}`
        : undefined,
    });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  // Branch metadata is not a status transition and stays a plain update.
  // Autofix deliberately preserves the PR branch recorded on the epic.
  if (!ciAutofix) {
    db.update(epics)
      .set({ branchName, updatedAt: now })
      .where(eq(epics.id, epicId))
      .run();
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
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType: "build",
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
    batchRunId: ciAutofixRunId,
    createdAt: now,
  });

  emitSessionStarted(projectId, epicId, sessionId, "build");

  // Batch-style launch: goes through the per-project scheduler. The session
  // stays 'queued' until a slot frees; the closure spawns, waits for
  // completion, syncs statuses, and posts the agent comment. It returns the
  // {success, outcome, error} triple so the pipeline's settle wrapper can
  // observe the terminal result.
  const runBuildSession = async () => {
    markSessionRunning(sessionId);
    processManager.start(
      sessionId,
      {
        mode: "code",
        prompt: enrichedPrompt,
        cwd: worktreePath,
        allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
        model: resolvedAgent.model,
        cliSessionId,
        resumeSession,
      },
      resolvedAgent.provider,
    );

    const info = await waitForProcessCompletion(sessionId);

    const completedAt = new Date().toISOString();
    const result = info?.result;

    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // ignore
    }

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
        completedAt,
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error("[epic build] Failed to finalize session", error);
      }
    }

    const terminal = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId,
      success: !!result?.success,
      outcome,
      error: result?.error,
      reason: ciAutofix
        ? `CI autofix completed locally for PR #${ciAutofix.prNumber}; ` +
          `branch ${branchName} carries an unpushed fix for head ${ciAutofix.headSha.slice(0, 12)} and requires a manual push`
        : undefined,
    });
    if (terminal.kind !== "failed" && terminal.kind !== "refused") {
      emitSessionCompleted(projectId, epicId, sessionId);
    } else {
      emitSessionFailed(
        projectId,
        epicId,
        sessionId,
        terminal.kind === "refused"
          ? terminal.error
          : result?.error || "Build failed",
      );
    }
    if (ciAutofix && terminal.kind === "promoted") {
      try {
        createCiAutofixReadyNotification({
          projectId,
          epicId,
          sessionId,
          branchName,
          prNumber: ciAutofix.prNumber,
          headSha: ciAutofix.headSha,
        });
      } catch (error) {
        console.warn(
          `[epic build] Failed to notify that CI autofix ${sessionId} is ready to push`,
          error,
        );
      }
    }

    // Post output as epic comment
    const output = resolveSessionOutput(result, sessionId);

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

    return resolveBuildSessionResult(terminal, {
      success: !!result?.success,
      outcome,
      error: result?.error ?? null,
    });
  };

  // Autonomous pipeline: when active, wrap the launch closure with the
  // settle pattern (copied from the batch route's launchEpic) so the run's
  // engine can await this build's terminal state, then start the run.
  const pipelineActive = ciAutofix
    ? false
    : (pipelineParam ?? resolvePipelineEnabled(projectId));

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
          error: error instanceof Error ? error.message : "Agent launch failed",
        });
        throw error;
      }
    });

    pipeline = startPipelineRun({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
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
    data: {
      sessionId,
      branchName,
      worktreePath,
      pipeline,
      ...(ciAutofix ? { ciAutofix: { launched: true } } : {}),
    },
  });
}
