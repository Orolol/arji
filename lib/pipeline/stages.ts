import fs from "fs";
import path from "path";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  reviewComments,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { agentScheduler } from "@/lib/agents/scheduler";
import { getRunningSessionForTarget } from "@/lib/agents/concurrency";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import { createWorktree } from "@/lib/git/manager";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { validateResumeSession } from "@/lib/agent-sessions/validate-resume";
import {
  isResumableProvider,
  providerReportsOwnSessionId,
} from "@/lib/agent-sessions/resume-capability";
import {
  resolveAgentByNamedId,
  resolveAgentForDispatch,
  type ResolvedAgent,
} from "@/lib/agent-config/agent-resolution";
import { pickAlternativeReviewProvider } from "@/lib/agent-config/review-segregation";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  REVIEW_TYPE_TO_AGENT_TYPE,
  type AgentProvider,
  type AgentType,
} from "@/lib/agent-config/constants";
import {
  buildBuildPrompt,
  buildEpicReviewPrompt,
  buildReviewPrompt,
  buildTicketBuildPrompt,
  type PromptComment,
} from "@/lib/claude/prompt-builder";
import {
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import type { ClaudeResult } from "@/lib/claude/spawn";
import {
  emitSessionCompleted,
  emitSessionFailed,
  emitSessionStarted,
  emitTicketMoved,
} from "@/lib/events/emit";
import { logTransition } from "@/lib/workflow/log";
import { handleAskedQuestionOutcome } from "@/lib/workflow/agent-question";
import {
  buildEpicTargetUrl,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { PIPELINE_REVIEW_TYPE } from "./constants";
import { assessReviewOutcome } from "./findings";
import type {
  PipelineGuardCheck,
  PipelineReviewAssessment,
  PipelineStageHandle,
  PipelineStageRequest,
  PipelineStageResult,
} from "./runner";

/**
 * Real stage launchers for the pipeline runner: review, fix, and build-retry
 * sessions dispatched from this library (not the HTTP routes), replicating
 * the corresponding route closures byte-for-byte in behavior so the board
 * cannot tell a pipeline stage from a human dispatch.
 *
 * Retry ladder per stage (deterministic by attempt index):
 *   attempt 1  — as-configured resolution: build/fix via resolveAgentByNamedId
 *                with the run's ORIGINAL namedAgentId; review via
 *                resolveAgentForDispatch purpose 'review' with the run's
 *                reviewNamedAgentId — null for every caller but Full Auto
 *                Mode, so reviewer segregation can act as before; an explicit
 *                review agent, when set, wins over segregation.
 *   attempt 2  — RESUME the failed attempt's session when the machinery
 *                allows (validateResumeSession — failed sessions keep their
 *                cliSessionId; status is not checked), same provider/agent;
 *                fresh otherwise.
 *   attempt 3+ — ESCALATE: fresh session on the first available alternative
 *                provider (pickAlternativeReviewProvider — despite its name
 *                it is the generic alternate picker); same provider when no
 *                alternative CLI is installed. namedAgentId null, model
 *                undefined (provider default).
 *
 * Fix stages additionally resume the run's previous code-writing session on
 * attempt 1 and append the open review feedback + pipeline fix instructions
 * to the standard build prompt.
 *
 * `isResumableProvider` (lib/agent-sessions/resume-capability.ts) is the
 * single truth for resume support. The build routes' local lists — which
 * wrongly included codex — now defer to it too.
 */

export const PIPELINE_REVIEW_LABEL = "Code Review";

export const PIPELINE_FIX_INSTRUCTIONS_SECTION = `## Pipeline fix instructions

A code review found blocking findings (listed above). Fix every [critical] and [major] item, keep the existing implementation approach unless a finding demands otherwise, run the tests, and commit.`;

const CODE_ALLOWED_TOOLS = ["Edit", "Write", "Bash", "Read", "Glob", "Grep"];

export interface PipelineStageDriverInit {
  projectId: string;
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
  /** The run's original request-level namedAgentId (attempt-1 code stages). */
  buildNamedAgentId: string | null;
  /**
   * Named agent for attempt-1 review stages. NULL — the default, and what
   * every pre-existing caller gets — keeps the historical behaviour: the
   * review stage resolves through `resolveAgentForDispatch(..., null, {purpose:
   * 'review'})` so reviewer segregation can pick a provider different from the
   * builder's. Full Auto Mode sets it because the user picked a review agent
   * explicitly, and an explicit choice always beats segregation
   * (lib/agent-config/agent-resolution.ts:428).
   */
  reviewNamedAgentId?: string | null;
  /**
   * Batch/night run that owns this pipeline; stamped on every stage session
   * row (agent_sessions.batch_run_id). Null for standalone runs.
   */
  batchRunId?: string | null;
}

export interface PipelineStageDriver {
  launchStage(request: PipelineStageRequest): Promise<PipelineStageHandle>;
  assessReview(input: {
    sessionId: string;
    stageStartedAt: string;
  }): Promise<PipelineReviewAssessment>;
  readSessionStatus(sessionId: string): string | null;
  checkGuards(ownSessionIds: string[]): PipelineGuardCheck;
}

/**
 * Builds the driver the runner is wired with. One driver per run — it
 * carries the per-run review-output cache used by the prose fallback.
 */
export function createPipelineStageDriver(
  init: PipelineStageDriverInit
): PipelineStageDriver {
  /** sessionId → review output, captured by the review closure. */
  const reviewOutputs = new Map<string, string>();

  return {
    launchStage: async (request) => {
      try {
        return await dispatchPipelineStage(init, request, reviewOutputs);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Stage dispatch failed";
        console.warn(
          `[pipeline] ${request.stage} dispatch failed (attempt ${request.attempt}):`,
          message
        );
        return {
          sessionId: null,
          settled: Promise.resolve({
            sessionId: "",
            success: false,
            outcome: null,
            error: message,
          }),
          escalatedToProvider: null,
        };
      }
    },

    assessReview: async ({ sessionId, stageStartedAt }) => {
      const output =
        reviewOutputs.get(sessionId) ?? readLastNonEmptyText(sessionId) ?? "";
      const assessment = assessReviewOutcome({
        epicId: init.epicId,
        sinceIso: stageStartedAt,
        sessionOutput: output,
      });
      return {
        blocking: assessment.blocking,
        blockingCount: assessment.blockingFindings.length,
        agentCommentCount: assessment.agentCommentCount,
        usedProseFallback: assessment.usedProseFallback,
      };
    },

    readSessionStatus: (sessionId) =>
      db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get()?.status ?? null,

    checkGuards: (ownSessionIds) => checkPipelineGuards(init, ownSessionIds),
  };
}

/**
 * Guard probe run before every stage dispatch:
 *   (b) an active session on the run's target that this run did not create
 *       means another agent took the ticket;
 *   (c) the review-target status (epic for epic runs, story for story runs —
 *       mirroring the respective review routes' guards) must still be
 *       review|done for a review stage.
 */
function checkPipelineGuards(
  init: PipelineStageDriverInit,
  ownSessionIds: string[]
): PipelineGuardCheck {
  const conflict = getRunningSessionForTarget(
    init.scope === "epic"
      ? { scope: "epic", projectId: init.projectId, epicId: init.epicId }
      : {
          scope: "story",
          projectId: init.projectId,
          storyId: init.userStoryId ?? "",
          epicId: init.epicId,
        }
  );
  const own = new Set(ownSessionIds);
  const conflictSessionId =
    conflict && !own.has(conflict.id) ? conflict.id : null;

  const reviewTargetStatus =
    init.scope === "story" && init.userStoryId
      ? db
          .select({ status: userStories.status })
          .from(userStories)
          .where(eq(userStories.id, init.userStoryId))
          .get()?.status ?? null
      : db
          .select({ status: epics.status })
          .from(epics)
          .where(eq(epics.id, init.epicId))
          .get()?.status ?? null;

  return { conflictSessionId, reviewTargetStatus };
}

function readLastNonEmptyText(sessionId: string): string | null {
  return (
    db
      .select({ lastNonEmptyText: agentSessions.lastNonEmptyText })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get()?.lastNonEmptyText ?? null
  );
}

interface PreviousSessionRow {
  id: string;
  provider: string | null;
}

function readSessionProvider(sessionId: string): PreviousSessionRow | null {
  return (
    db
      .select({ id: agentSessions.id, provider: agentSessions.provider })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get() ?? null
  );
}

/**
 * Byte-pattern of the epic build route's "Code Review Feedback" block over
 * the currently-open review comments (blocking findings appear verbatim with
 * their [severity] prefixes).
 */
function buildReviewFeedbackSection(
  openComments: Array<{ filePath: string; lineNumber: number; body: string }>
): string {
  if (openComments.length === 0) return "";
  const byFile = new Map<string, typeof openComments>();
  for (const rc of openComments) {
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
  return parts.join("\n");
}

/**
 * The reviewer's own memory of the run: findings still open from earlier
 * cycles, plus the scope rules that make a multi-cycle review converge.
 *
 * Without this the review prompt is cycle-blind — it asks the agent to "read
 * the relevant source files" with no record of what previous cycles already
 * examined or reported. On epic E-arij-096 that produced four reviews with
 * four almost disjoint sets of Major findings: each cycle re-audited the whole
 * epic surface and reported whatever it noticed that time, so the ticket could
 * never reach a green review no matter how much the builders fixed.
 *
 * Two rules do the work. Re-verify what is already filed, so a fixed finding
 * gets retired instead of silently replaced by a new one. And bound fresh
 * findings to the branch diff, so ground a previous cycle passed over stays
 * passed — an issue that could have been filed in cycle 1 and was not is not a
 * reason to block cycle 4.
 */
function buildPriorFindingsSection(
  openComments: Array<{ filePath: string; lineNumber: number; body: string }>,
  cycle: number
): string {
  if (openComments.length === 0) return "";

  const parts = [
    "## Findings Still Open From Previous Reviews\n",
    `This is review cycle ${cycle} on this ticket. ${openComments.length} finding(s) ` +
      "filed by earlier cycles are still open:\n",
  ];

  const byFile = new Map<string, typeof openComments>();
  for (const rc of openComments) {
    const existing = byFile.get(rc.filePath) || [];
    existing.push(rc);
    byFile.set(rc.filePath, existing);
  }
  for (const [filePath, fileComments] of byFile) {
    parts.push(`### ${filePath}`);
    for (const rc of fileComments) {
      parts.push(`- **Line ${rc.lineNumber}**: ${rc.body}`);
    }
    parts.push("");
  }

  parts.push(
    `**Work through that list before looking for anything new.** For each open
finding, state plainly whether it is FIXED or STILL OPEN at the current HEAD,
and name the evidence you checked. A finding you do not mention is treated as
unverified, not as resolved.

**Then bound new findings to what this branch changed** — the diff against the
base branch. Do not re-audit code earlier cycles already passed over: an issue
that could have been filed in cycle 1 and was not is out of scope now. Raising
fresh Majors in untouched adjacent code every cycle is what keeps a ticket
looping forever instead of shipping.`
  );

  return parts.join("\n");
}

interface ResolvedStageAgent {
  resolved: ResolvedAgent;
  escalatedToProvider: AgentProvider | null;
}

/** Applies the D5b ladder to pick the stage's agent. */
async function resolveStageAgent(
  init: PipelineStageDriverInit,
  request: PipelineStageRequest,
  codeAgentType: AgentType,
  reviewAgentType: AgentType
): Promise<ResolvedStageAgent> {
  const resolveConfigured = async (): Promise<ResolvedAgent> => {
    if (request.stage === "review") {
      return resolveAgentForDispatch(
        reviewAgentType,
        init.projectId,
        init.reviewNamedAgentId ?? null,
        {
          purpose: "review",
          projectId: init.projectId,
          epicId: init.epicId,
          ...(init.scope === "story" && init.userStoryId
            ? { storyId: init.userStoryId }
            : {}),
        }
      );
    }
    return resolveAgentByNamedId(
      codeAgentType,
      init.projectId,
      init.buildNamedAgentId
    );
  };

  if (request.attempt < 3) {
    return { resolved: await resolveConfigured(), escalatedToProvider: null };
  }

  // Escalation: fresh session on the first available alternative to the
  // failed attempt's provider; same provider when none is installed. Named
  // agent dropped, model left undefined (provider default).
  const previous = request.previousAttemptSessionId
    ? readSessionProvider(request.previousAttemptSessionId)
    : null;
  const baseProvider = (previous?.provider ??
    (await resolveConfigured()).provider) as AgentProvider;
  const alternative = await pickAlternativeReviewProvider(baseProvider);
  if (alternative) {
    return {
      resolved: { provider: alternative, namedAgentId: null },
      escalatedToProvider: alternative,
    };
  }
  return {
    resolved: { provider: baseProvider, namedAgentId: null },
    escalatedToProvider: null,
  };
}

/**
 * Dispatches one pipeline stage session: resolves the agent per the ladder,
 * builds the prompt, creates the queued session, applies the same
 * dispatch-side status sync as the route counterpart, and submits a launch
 * closure that settles a PipelineStageResult (never rejects) while
 * rethrowing into the scheduler's safety net.
 */
async function dispatchPipelineStage(
  init: PipelineStageDriverInit,
  request: PipelineStageRequest,
  reviewOutputs: Map<string, string>
): Promise<PipelineStageHandle> {
  const { projectId, epicId, userStoryId, scope } = init;

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) throw new Error("Project not found");
  if (!project.gitRepoPath) {
    throw new Error("Project has no git repository configured");
  }

  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) throw new Error("Epic not found");

  const story =
    scope === "story" && userStoryId
      ? db
          .select()
          .from(userStories)
          .where(eq(userStories.id, userStoryId))
          .get()
      : null;
  if (scope === "story" && !story) throw new Error("Story not found");

  const codeAgentType: AgentType = scope === "epic" ? "build" : "ticket_build";
  const reviewAgentType: AgentType =
    REVIEW_TYPE_TO_AGENT_TYPE[PIPELINE_REVIEW_TYPE];
  const isReview = request.stage === "review";
  const agentType = isReview ? reviewAgentType : codeAgentType;

  const { resolved, escalatedToProvider } = await resolveStageAgent(
    init,
    request,
    codeAgentType,
    reviewAgentType
  );

  // ---------------------------------------------------------------------
  // Resume decision. Targets: attempt 2 resumes the failed attempt of THIS
  // stage; a fix's attempt 1 resumes the run's previous code-writing
  // session. Escalated attempts always start fresh.
  // ---------------------------------------------------------------------
  let resumeTarget: string | null = null;
  if (request.attempt === 2) {
    resumeTarget = request.previousAttemptSessionId;
  } else if (request.attempt === 1 && request.stage === "fix") {
    resumeTarget = request.lastCodeSessionId;
  }

  let cliSessionId: string | undefined;
  let resumeSession = false;
  if (resumeTarget && isResumableProvider(resolved.provider)) {
    // validateResumeSession enforces the cross-provider guard itself: the
    // stored cliSessionId only means something to the CLI that created it.
    const validated = validateResumeSession({
      resumeSessionId: resumeTarget,
      epicId,
      ...(scope === "story" && userStoryId ? { userStoryId } : {}),
      expectedProvider: resolved.provider,
    });
    if (validated) {
      cliSessionId = validated.cliSessionId;
      resumeSession = true;
    }
  }
  // pi announces the session id it created, so minting one here would store
  // an id the CLI never used.
  if (
    !cliSessionId &&
    isResumableProvider(resolved.provider) &&
    !providerReportsOwnSessionId(resolved.provider)
  ) {
    cliSessionId = crypto.randomUUID();
  }

  // ---------------------------------------------------------------------
  // Context + prompt (mirror of the route counterparts).
  // ---------------------------------------------------------------------
  const usList = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .orderBy(userStories.position)
    .all();

  const comments = db
    .select()
    .from(ticketComments)
    .where(
      scope === "story" && userStoryId
        ? eq(ticketComments.userStoryId, userStoryId)
        : eq(ticketComments.epicId, epicId)
    )
    .orderBy(ticketComments.createdAt)
    .all();

  const promptComments: PromptComment[] = comments.map((c) => ({
    author: c.author as "user" | "agent",
    content: c.content,
    createdAt: c.createdAt ?? "",
  }));

  const { worktreePath, branchName } = await createWorktree(
    project.gitRepoPath,
    epic.id,
    epic.title,
    { defaultBranch: project.defaultBranch }
  );

  let prompt: string;
  if (isReview) {
    const reviewSystemPrompt = await resolveAgentPrompt(
      reviewAgentType,
      projectId
    );
    prompt =
      scope === "epic"
        ? buildEpicReviewPrompt(
            project,
            [],
            epic,
            usList,
            PIPELINE_REVIEW_TYPE,
            reviewSystemPrompt,
            promptComments
          )
        : buildReviewPrompt(
            project,
            [],
            epic,
            story!,
            PIPELINE_REVIEW_TYPE,
            reviewSystemPrompt
          );

    // Give the reviewer the run's own history. Same open-findings query the
    // build branch uses below — reviewComments is epic-keyed, so story-scoped
    // review stages see the epic's open findings too, which is what makes a
    // sibling story's unfixed finding stay visible instead of being rediscovered.
    const priorFindings = buildPriorFindingsSection(
      db
        .select()
        .from(reviewComments)
        .where(
          and(
            eq(reviewComments.epicId, epicId),
            eq(reviewComments.status, "open")
          )
        )
        .orderBy(reviewComments.createdAt)
        .all(),
      request.fixCycle + 1
    );
    if (priorFindings) {
      prompt = prompt + "\n\n" + priorFindings;
    }
  } else {
    const buildSystemPrompt = await resolveAgentPrompt(
      codeAgentType,
      projectId
    );
    prompt =
      scope === "epic"
        ? buildBuildPrompt(
            project,
            [],
            epic,
            usList,
            buildSystemPrompt,
            promptComments
          )
        : buildTicketBuildPrompt(
            project,
            [],
            epic,
            story!,
            promptComments,
            buildSystemPrompt
          );

    // Open review feedback (includes the blocking findings verbatim with
    // their [severity] prefixes), then the fix instructions.
    const openReviewComments = db
      .select()
      .from(reviewComments)
      .where(
        and(eq(reviewComments.epicId, epicId), eq(reviewComments.status, "open"))
      )
      .orderBy(reviewComments.createdAt)
      .all();
    const reviewContext = buildReviewFeedbackSection(openReviewComments);
    if (reviewContext) {
      prompt = prompt + "\n\n" + reviewContext;
    }
    if (request.stage === "fix") {
      prompt = prompt + "\n\n" + PIPELINE_FIX_INSTRUCTIONS_SECTION;
    }
  }

  // Document mentions: user-written comments only. An agent comment naming a
  // codebase file is not an Arij document reference, and an unresolved mention
  // never stops a background stage — it is reported, not raised.
  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: userAuthoredTexts(comments),
  });
  prompt = mentionEnrichment.prompt;
  createUnresolvedMentionsNotification({
    projectId,
    missing: mentionEnrichment.missing,
    agentType: request.stage,
    targetUrl: buildEpicTargetUrl(projectId, epicId),
  });

  // ---------------------------------------------------------------------
  // Session row + dispatch-side status sync (mirror of the routes).
  // ---------------------------------------------------------------------
  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");
  const agentMode = isReview ? "plan" : "code";

  createQueuedSession({
    id: sessionId,
    projectId,
    epicId,
    ...(scope === "story" && userStoryId ? { userStoryId } : {}),
    mode: agentMode,
    provider: resolved.provider,
    prompt,
    logsPath,
    branchName,
    worktreePath,
    cliSessionId,
    namedAgentId: resolved.namedAgentId ?? null,
    agentType,
    namedAgentName: resolved.name || null,
    model: resolved.model || null,
    batchRunId: init.batchRunId ?? null,
    createdAt: now,
  });

  if (isReview) {
    if (scope === "epic") {
      emitSessionStarted(projectId, epicId, sessionId, agentType);
    }
  } else if (scope === "epic") {
    const fromStatus = epic.status ?? "backlog";
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
    emitSessionStarted(projectId, epicId, sessionId, agentType);
    emitTicketMoved(projectId, epicId, fromStatus, "in_progress");
    logTransition({
      projectId,
      epicId,
      fromStatus,
      toStatus: "in_progress",
      actor: "agent",
      reason: "Build agent started",
      sessionId,
    });
  } else {
    db.update(userStories)
      .set({ status: "in_progress" })
      .where(eq(userStories.id, userStoryId!))
      .run();
    db.update(epics)
      .set({ branchName, updatedAt: now })
      .where(eq(epics.id, epicId))
      .run();
  }

  // ---------------------------------------------------------------------
  // Launch closure — replica of the route closure for the stage kind.
  // Returns the {success, outcome, error} triple for the settle wrapper.
  // ---------------------------------------------------------------------
  const runStageSession = async (): Promise<{
    success: boolean;
    outcome: string | null;
    error: string | null;
  }> => {
    markSessionRunning(sessionId);
    processManager.start(
      sessionId,
      {
        mode: agentMode,
        prompt,
        cwd: worktreePath,
        ...(isReview ? {} : { allowedTools: CODE_ALLOWED_TOOLS }),
        model: resolved.model,
        cliSessionId,
        resumeSession,
      },
      resolved.provider
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
        completedAt
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error(
          `[pipeline ${request.stage}] Failed to finalize session`,
          error
        );
      }
    }

    if (isReview) {
      finalizeReviewSession({
        init,
        sessionId,
        result,
        outcome,
        completedAt,
        reviewOutputs,
      });
    } else {
      finalizeCodeSession({
        init,
        sessionId,
        result,
        outcome,
        completedAt,
      });
    }

    return {
      success: !!result?.success,
      outcome,
      error: result?.error ?? null,
    };
  };

  let settleLaunch!: (result: PipelineStageResult) => void;
  const settled = new Promise<PipelineStageResult>((resolve) => {
    settleLaunch = resolve;
  });

  agentScheduler.submit(projectId, sessionId, async () => {
    try {
      settleLaunch({ sessionId, ...(await runStageSession()) });
    } catch (error) {
      // The scheduler's safety net finalizes the session row; the runner
      // only needs to know this stage settled as failed.
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

  return { sessionId, settled, escalatedToProvider };
}

type StageResultPayload = ClaudeResult | undefined;

/** Post-completion effects of a code (build/fix) stage — build-route replica. */
function finalizeCodeSession(input: {
  init: PipelineStageDriverInit;
  sessionId: string;
  result: StageResultPayload;
  outcome: string | null;
  completedAt: string;
}): void {
  const { init, sessionId, result, outcome, completedAt } = input;
  const { projectId, epicId, userStoryId, scope } = init;

  if (result?.success && outcome !== "asked_question") {
    if (scope === "epic") {
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
      emitSessionCompleted(projectId, epicId, sessionId);
      emitTicketMoved(projectId, epicId, "in_progress", "review");
      logTransition({
        projectId,
        epicId,
        fromStatus: "in_progress",
        toStatus: "review",
        actor: "agent",
        reason: "Build completed successfully",
        sessionId,
      });
    } else {
      db.update(userStories)
        .set({ status: "review" })
        .where(
          and(
            eq(userStories.id, userStoryId!),
            eq(userStories.status, "in_progress")
          )
        )
        .run();
      const allStories = db
        .select()
        .from(userStories)
        .where(eq(userStories.epicId, epicId))
        .all();
      const allReviewOrDone = allStories.every(
        (s) =>
          s.id === userStoryId || s.status === "done" || s.status === "review"
      );
      if (allReviewOrDone) {
        db.update(epics)
          .set({ status: "review", updatedAt: completedAt })
          .where(eq(epics.id, epicId))
          .run();
      }
    }
  } else if (result?.success) {
    handleAskedQuestionOutcome({
      projectId,
      epicIds: [epicId],
      sessionId,
      ticketStatus: "in_progress",
    });
    if (scope === "epic") {
      emitSessionCompleted(projectId, epicId, sessionId);
    }
  } else if (scope === "epic") {
    emitSessionFailed(
      projectId,
      epicId,
      sessionId,
      result?.error || "Build failed"
    );
  }

  const output = resolveSessionOutput(result, sessionId);
  db.insert(ticketComments)
    .values({
      id: createId(),
      ...(scope === "story" && userStoryId
        ? { userStoryId }
        : { epicId }),
      author: "agent",
      content: output,
      agentSessionId: sessionId,
      createdAt: completedAt,
    })
    .run();
}

/** Post-completion effects of a review stage — review-route replica. */
function finalizeReviewSession(input: {
  init: PipelineStageDriverInit;
  sessionId: string;
  result: StageResultPayload;
  outcome: string | null;
  completedAt: string;
  reviewOutputs: Map<string, string>;
}): void {
  const { init, sessionId, result, outcome, completedAt } = input;
  const { projectId, epicId, userStoryId, scope } = init;

  const output = resolveSessionOutput(
    result,
    sessionId,
    "Review agent completed without output."
  );
  input.reviewOutputs.set(sessionId, output);

  db.insert(ticketComments)
    .values({
      id: createId(),
      ...(scope === "story" && userStoryId
        ? { userStoryId }
        : { epicId }),
      author: "agent",
      content: `**${PIPELINE_REVIEW_LABEL}**\n\n${output}`,
      agentSessionId: sessionId,
      createdAt: completedAt,
    })
    .run();

  const askedQuestion = outcome === "asked_question";
  if (askedQuestion) {
    const heldStatus =
      scope === "story" && userStoryId
        ? db
            .select({ status: userStories.status })
            .from(userStories)
            .where(eq(userStories.id, userStoryId))
            .get()?.status ?? "review"
        : db
            .select({ status: epics.status })
            .from(epics)
            .where(eq(epics.id, epicId))
            .get()?.status ?? "review";
    handleAskedQuestionOutcome({
      projectId,
      epicIds: [epicId],
      sessionId,
      ticketStatus: heldStatus,
    });
  }

  const lowerOutput = output.toLowerCase();
  const isNegativeVerdict =
    !askedQuestion &&
    (lowerOutput.includes("changes requested") ||
      lowerOutput.includes("not complete") ||
      lowerOutput.includes("partially complete"));

  if (scope === "epic") {
    if (result?.success) {
      emitSessionCompleted(projectId, epicId, sessionId);
    } else {
      emitSessionFailed(
        projectId,
        epicId,
        sessionId,
        result?.error || "Review failed"
      );
    }
  }

  if (!isNegativeVerdict) return;

  if (scope === "epic") {
    const currentEpic = db
      .select()
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    if (
      currentEpic &&
      (currentEpic.status === "done" || currentEpic.status === "review")
    ) {
      const prevStatus = currentEpic.status;
      db.update(epics)
        .set({ status: "in_progress", updatedAt: completedAt })
        .where(eq(epics.id, epicId))
        .run();
      db.update(userStories)
        .set({ status: "in_progress" })
        .where(
          and(
            eq(userStories.epicId, epicId),
            notInArray(userStories.status, ["in_progress"])
          )
        )
        .run();
      emitTicketMoved(projectId, epicId, prevStatus, "in_progress");
      logTransition({
        projectId,
        epicId,
        fromStatus: prevStatus,
        toStatus: "in_progress",
        actor: "agent",
        reason: `Review verdict: changes requested (${PIPELINE_REVIEW_LABEL})`,
        sessionId,
      });
    }
  } else if (userStoryId) {
    const currentStory = db
      .select()
      .from(userStories)
      .where(eq(userStories.id, userStoryId))
      .get();
    if (
      currentStory &&
      (currentStory.status === "done" || currentStory.status === "review")
    ) {
      db.update(userStories)
        .set({ status: "in_progress" })
        .where(eq(userStories.id, userStoryId))
        .run();
      const parentEpic = db
        .select()
        .from(epics)
        .where(eq(epics.id, currentStory.epicId))
        .get();
      if (
        parentEpic &&
        (parentEpic.status === "done" || parentEpic.status === "review")
      ) {
        db.update(epics)
          .set({ status: "in_progress", updatedAt: completedAt })
          .where(eq(epics.id, currentStory.epicId))
          .run();
      }
    }
  }
}
