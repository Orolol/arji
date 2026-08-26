import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import {
  agentSessions,
  epics,
  gradingReports,
  namedAgents,
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
  buildDeterministicVerificationFixSection,
  buildDeterministicVerificationReviewSection,
  buildEpicReviewPrompt,
  buildReviewPrompt,
  buildTicketBuildPrompt,
  type PromptComment,
} from "@/lib/claude/prompt-builder";
import { resolveVerifyConfigForProject } from "@/lib/verify/config";
import type { VerifyConfig } from "@/lib/verify/verify-constants";
import { withVerificationWorktreeLock } from "@/lib/verify/execution-lock";
import { isVisualProofEnabled } from "@/lib/claude/visual-proof";
import { buildRegressionFixSection } from "@/lib/verify/regression-report";
import { runVerification as executeVerification } from "@/lib/verify/runner";
import { assertManagedEpicWorktreePath } from "@/lib/verify/worktree";
import { readRegressionConfig } from "@/lib/pipeline/verify";
import { emitTicketUpdated } from "@/lib/events/emit";
import { dispatchGradingSession } from "@/lib/grading/dispatch";
import {
  buildGradingFixSection,
  parseGradingEntries,
} from "@/lib/grading/report";
import {
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import type { ClaudeResult } from "@/lib/claude/spawn";
import {
  emitSessionCompleted,
  emitSessionFailed,
  emitSessionStarted,
} from "@/lib/events/emit";
import { handleAskedQuestionOutcome } from "@/lib/workflow/agent-question";
import {
  finalizeBuildTerminalOutcome,
  resolveBuildSessionResult,
  transitionBuildStarted,
  transitionReviewRejected,
  type BuildTerminalOutcome,
} from "@/lib/workflow/automatic-transitions";
import {
  buildEpicTargetUrl,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { PIPELINE_REVIEW_TYPE } from "./constants";
import { assessReviewOutcome, resolveReviewVerdict } from "./findings";
import type {
  PipelineDeterministicVerificationOutcome,
  PipelineGuardCheck,
  PipelineGradingAssessment,
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
 *   attempt 3  — when the failed named agent has escalatesTo configured,
 *                start fresh on that stronger named agent (same provider).
 *                Without that opt-in edge, this is byte-for-byte the legacy
 *                provider-escalation attempt below.
 *   attempt 3+ — ESCALATE to the first available alternative provider when
 *                no model escalation occupied attempt 3; with an escalatesTo
 *                edge, provider escalation starts at attempt 4. The generic
 *                picker is pickAlternativeReviewProvider despite its name.
 *                namedAgentId null, model undefined (provider default).
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
  runDeterministicVerification(
    lastCodeSessionId: string | null
  ): Promise<PipelineDeterministicVerificationOutcome>;
  assessReview(input: {
    sessionId: string;
    stageStartedAt: string;
  }): Promise<PipelineReviewAssessment>;
  assessGrading(input: {
    sessionId: string;
    reportId: string;
  }): Promise<PipelineGradingAssessment>;
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
        if (request.stage === "grading") {
          return await dispatchPipelineGradingStage(init);
        }
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

    runDeterministicVerification: (lastCodeSessionId) =>
      runPipelineVerification(init, lastCodeSessionId),

    assessReview: async ({ sessionId, stageStartedAt }) => {
      const output =
        reviewOutputs.get(sessionId) ?? readLastNonEmptyText(sessionId) ?? "";
      const assessment = assessReviewOutcome({
        epicId: init.epicId,
        sinceIso: stageStartedAt,
        sessionOutput: output,
        reviewSessionId: sessionId || null,
      });
      return {
        blocking: assessment.blocking,
        blockingCount: assessment.blockingFindings.length,
        agentCommentCount: assessment.agentCommentCount,
        usedProseFallback: assessment.usedProseFallback,
        verdictSource: assessment.verdictSource,
        structuredVerdict: assessment.structuredVerdict,
        unverifiable: assessment.unverifiable,
      };
    },

    assessGrading: async ({ sessionId, reportId }) => {
      const report = db
        .select()
        .from(gradingReports)
        .where(
          and(
            eq(gradingReports.id, reportId),
            eq(gradingReports.epicId, init.epicId),
            eq(gradingReports.agentSessionId, sessionId),
          ),
        )
        .get();
      const gradings = parseGradingEntries(report?.gradings);
      if (!report || !gradings) {
        throw new Error("Grading report is missing or malformed");
      }
      return {
        reportId: report.id,
        summary: report.summary,
        gradings,
        missed: gradings.filter((entry) => entry.status === "missed"),
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

/** Adapts the reusable grader dispatcher to the pipeline stage contract. */
async function dispatchPipelineGradingStage(
  init: PipelineStageDriverInit,
): Promise<PipelineStageHandle> {
  const result = await dispatchGradingSession({
    projectId: init.projectId,
    epicId: init.epicId,
    userStoryId: init.scope === "story" ? init.userStoryId : null,
    batchRunId: init.batchRunId ?? null,
  });

  if (result.skipped) {
    return {
      sessionId: null,
      settled: Promise.resolve({
        sessionId: "",
        success: true,
        outcome: "answered",
        error: null,
        gradingReportId: null,
        gradingSkipped: true,
      }),
      escalatedToProvider: null,
    };
  }

  return {
    sessionId: result.sessionId,
    settled: result.settled.then((terminal) => ({
      sessionId: terminal.sessionId,
      success: terminal.success,
      outcome: terminal.outcome,
      error: terminal.error,
      gradingReportId: terminal.reportId,
      gradingSkipped: false,
    })),
    escalatedToProvider: null,
  };
}

/**
 * Resolve the human-owned command list for this invocation and run it only
 * in the successful code session's recorded epic worktree. There is no
 * repository-checkout fallback: a missing/mismatched worktree fails closed.
 */
async function runPipelineVerification(
  init: PipelineStageDriverInit,
  lastCodeSessionId: string | null
): Promise<PipelineDeterministicVerificationOutcome> {
  // Applicability is decided by plain DB reads plus path checks. ONLY those
  // reads sit inside the try: the stage must be TOTAL for faults that say
  // nothing about the branch (mirroring lib/pipeline/verify.ts), while a
  // genuine execution fault still reaches the runner's crash path. Every
  // non-disabled skip carries a reason: the runner traces it into
  // ticket_activity_log, because a silent skip would be indistinguishable
  // from "the configured checks passed".
  const notRun = (): PipelineDeterministicVerificationOutcome => ({
    ran: false,
    result: null,
  });
  const skip = (reason: string): PipelineDeterministicVerificationOutcome => {
    console.warn(`[pipeline verify] Skipping: ${reason}`);
    return { ran: false, result: null, skipReason: reason };
  };

  let plan: {
    worktreePath: string;
    commands: VerifyConfig["commands"];
    timeoutMs: number;
  } | null = null;
  try {
    const config = resolveVerifyConfigForProject(init.projectId);
    if (!config.enabled) return notRun();
    if (!lastCodeSessionId) {
      return skip("deterministic verification requires a code session");
    }

    const codeSession = db
      .select({ worktreePath: agentSessions.worktreePath })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, lastCodeSessionId),
          eq(agentSessions.projectId, init.projectId),
          eq(agentSessions.epicId, init.epicId)
        )
      )
      .get();
    if (!codeSession?.worktreePath) {
      return skip("no epic worktree recorded by the last code session");
    }
    const worktreePath = codeSession.worktreePath;

    const project = db
      .select({ gitRepoPath: projects.gitRepoPath })
      .from(projects)
      .where(eq(projects.id, init.projectId))
      .get();
    if (!project?.gitRepoPath) {
      return skip("deterministic verification requires a Git repository");
    }
    // Hard constraint: never execute in the repository checkout or any
    // unmanaged path, even when durable session state records one.
    assertManagedEpicWorktreePath(worktreePath, project.gitRepoPath);

    // A session row can outlive a worktree pruned after a merge. Spawning
    // into a missing cwd would surface as a spawn error — a phantom
    // "failing command" that burns a real fix cycle.
    if (!fs.existsSync(worktreePath)) {
      return skip(
        "the recorded epic worktree no longer exists on disk (pruned?)"
      );
    }

    plan = {
      worktreePath,
      commands: config.commands,
      timeoutMs: config.timeoutMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return skip(`applicability check failed: ${message}`);
  }

  // Deliberately OUTSIDE the applicability try: from here on a thrown fault
  // is an execution fault, and it belongs to the runner's crash path rather
  // than to a "skipped" trace.
  const result = await withVerificationWorktreeLock(
    plan.worktreePath,
    () =>
      executeVerification({
        projectId: init.projectId,
        epicId: init.epicId,
        agentSessionId: lastCodeSessionId,
        worktreePath: plan.worktreePath,
        commands: plan.commands,
        timeoutMs: plan.timeoutMs,
      })
  );

  // Persistence is tolerant by design (a lost row must not fail a run that
  // actually executed), but every durable reader — the merge gate, the
  // EpicDetail panel, the next sweep — reads the table. Announcing a verdict
  // no reader can see would leave "verification passed" in the feed next to
  // a gate that says it never ran, so an unpersisted report is a skip.
  if (!result.persisted) {
    return skip("the verification report could not be persisted");
  }

  // The manual route emits this too. Without it the board and the open
  // EpicDetail panel never learn that an autonomous run's checks have
  // finished (or failed) until the panel is closed and reopened.
  emitTicketUpdated(init.projectId, init.epicId, {
    verifyReportId: result.id,
    verifyStatus: result.status,
  });
  return { ran: true, result };
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
  namedAgentId: string | null;
}

function readSessionAgent(sessionId: string): PreviousSessionRow | null {
  return (
    db
      .select({
        id: agentSessions.id,
        provider: agentSessions.provider,
        namedAgentId: agentSessions.namedAgentId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get() ?? null
  );
}

function readEffortEscalationTarget(
  namedAgentId: string,
  provider: AgentProvider
): ResolvedAgent | null {
  const source = db
    .select({ escalatesTo: namedAgents.escalatesTo })
    .from(namedAgents)
    .where(eq(namedAgents.id, namedAgentId))
    .get();
  if (!source?.escalatesTo) return null;

  const target = db
    .select({
      id: namedAgents.id,
      name: namedAgents.name,
      provider: namedAgents.provider,
      model: namedAgents.model,
    })
    .from(namedAgents)
    .where(eq(namedAgents.id, source.escalatesTo))
    .get();

  // The write service enforces this invariant. Keep the dispatch-side check
  // so a database edited outside Arij can never turn effort escalation into
  // an unannounced provider switch.
  if (!target || target.provider !== provider) return null;
  return {
    provider,
    namedAgentId: target.id,
    name: target.name,
    model: target.model,
  };
}

/**
 * Ceilings for the open-findings blocks below. A finding body is a filed
 * review comment — normally a few hundred characters; the caps only bite on
 * degenerate rows and on tickets that accumulated findings across many
 * cycles, where an unbounded list was one of the feeders of the 4.9 MB
 * prompt measured on 2026-08-26.
 */
const FINDING_BODY_MAX_CHARS = 1_200;
const FINDINGS_LIST_MAX = 80;

/** The most recent rows within the list cap, original order preserved. */
function capOpenFindings<T>(openComments: T[]): { kept: T[]; dropped: number } {
  if (openComments.length <= FINDINGS_LIST_MAX) {
    return { kept: openComments, dropped: 0 };
  }
  return {
    kept: openComments.slice(-FINDINGS_LIST_MAX),
    dropped: openComments.length - FINDINGS_LIST_MAX,
  };
}

function findingBodyLine(rc: { lineNumber: number; body: string }): string {
  const body =
    rc.body.length > FINDING_BODY_MAX_CHARS
      ? `${rc.body.slice(0, FINDING_BODY_MAX_CHARS)} _[… finding truncated …]_`
      : rc.body;
  return `- **Line ${rc.lineNumber}**: ${body}`;
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
  const { kept, dropped } = capOpenFindings(openComments);
  const byFile = new Map<string, typeof openComments>();
  for (const rc of kept) {
    const existing = byFile.get(rc.filePath) || [];
    existing.push(rc);
    byFile.set(rc.filePath, existing);
  }
  const parts = [
    "## Code Review Feedback\n\nThe following review comments were left on your previous changes. Address each one:\n",
  ];
  if (dropped > 0) {
    parts.push(
      `_[${dropped} older open finding${dropped > 1 ? "s" : ""} omitted — the ${FINDINGS_LIST_MAX} most recent are listed.]_\n`
    );
  }
  for (const [filePath, fileComments] of byFile) {
    parts.push(`### ${filePath}`);
    for (const rc of fileComments) {
      parts.push(findingBodyLine(rc));
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

  const { kept, dropped } = capOpenFindings(openComments);
  const parts = [
    "## Findings Still Open From Previous Reviews\n",
    `This is review cycle ${cycle} on this ticket. ${openComments.length} finding(s) ` +
      "filed by earlier cycles are still open:\n",
  ];
  if (dropped > 0) {
    parts.push(
      `_[${dropped} older open finding${dropped > 1 ? "s" : ""} omitted — the ${FINDINGS_LIST_MAX} most recent are listed.]_\n`
    );
  }

  const byFile = new Map<string, typeof openComments>();
  for (const rc of kept) {
    const existing = byFile.get(rc.filePath) || [];
    existing.push(rc);
    byFile.set(rc.filePath, existing);
  }
  for (const [filePath, fileComments] of byFile) {
    parts.push(`### ${filePath}`);
    for (const rc of fileComments) {
      parts.push(findingBodyLine(rc));
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
  escalatedToNamedAgent: string | null;
  escalatedToProvider: AgentProvider | null;
}

/** Applies the D5b ladder to pick the stage's agent. */
async function resolveStageAgent(
  init: PipelineStageDriverInit,
  request: PipelineStageRequest,
  codeAgentType: AgentType,
  reviewAgentType: AgentType
): Promise<ResolvedStageAgent> {
  let configured: ResolvedAgent | null = null;
  const resolveConfigured = async (): Promise<ResolvedAgent> => {
    if (configured) return configured;
    if (request.stage === "review") {
      configured = await resolveAgentForDispatch(
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
      return configured;
    }
    configured = resolveAgentByNamedId(
      codeAgentType,
      init.projectId,
      init.buildNamedAgentId
    );
    return configured;
  };

  if (request.attempt < 3) {
    return {
      resolved: await resolveConfigured(),
      escalatedToNamedAgent: null,
      escalatedToProvider: null,
    };
  }

  // Escalation always starts fresh. If the failed named agent opted into a
  // stronger same-provider model, that occupies attempt 3. Otherwise attempt
  // 3 retains the exact historical alternative-provider path.
  const previous = request.previousAttemptSessionId
    ? readSessionAgent(request.previousAttemptSessionId)
    : null;
  const baseProvider = (previous?.provider ??
    (await resolveConfigured()).provider) as AgentProvider;
  if (request.attempt === 3) {
    const sourceNamedAgentId =
      previous !== null
        ? previous.namedAgentId
        : (await resolveConfigured()).namedAgentId ?? null;
    if (sourceNamedAgentId) {
      const effortTarget = readEffortEscalationTarget(
        sourceNamedAgentId,
        baseProvider
      );
      if (effortTarget) {
        return {
          resolved: effortTarget,
          escalatedToNamedAgent:
            effortTarget.name ?? effortTarget.namedAgentId ?? "stronger agent",
          escalatedToProvider: null,
        };
      }
    }
  }

  // Provider escalation: first available alternative to the failed attempt's
  // provider; same provider when none is installed. The named agent is
  // dropped and the provider's default model is used.
  const alternative = await pickAlternativeReviewProvider(baseProvider);
  if (alternative) {
    return {
      resolved: { provider: alternative, namedAgentId: null },
      escalatedToNamedAgent: null,
      escalatedToProvider: alternative,
    };
  }
  return {
    resolved: { provider: baseProvider, namedAgentId: null },
    escalatedToNamedAgent: null,
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

  const { resolved, escalatedToNamedAgent, escalatedToProvider } =
    await resolveStageAgent(init, request, codeAgentType, reviewAgentType);

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

  const promptComments: PromptComment[] = loadPromptComments(
    scope === "story" && userStoryId ? { userStoryId } : { epicId }
  );

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
            promptComments,
            { visualProofEnabled: isVisualProofEnabled() }
          )
        : buildTicketBuildPrompt(
            project,
            [],
            epic,
            story!,
            promptComments,
            buildSystemPrompt,
            { visualProofEnabled: isVisualProofEnabled() }
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
      // A grading-only fix must not be described as a code-review rejection.
      // When open review findings also exist, retain both instruction blocks.
      if (!request.gradingFailure || reviewContext) {
        prompt = prompt + "\n\n" + PIPELINE_FIX_INSTRUCTIONS_SECTION;
      }
      if (request.gradingFailure) {
        prompt =
          prompt +
          "\n\n" +
          buildGradingFixSection(request.gradingFailure);
      }
      // A regression-gate rejection carries its exact red→green verdict so
      // the agent repairs the real problem instead of guessing.
      if (request.verifyFailure) {
        // Same patterns the gate filtered the diff with, so the prompt states
        // the rule the agent actually has to satisfy.
        prompt =
          prompt +
          "\n\n" +
          buildRegressionFixSection(
            request.verifyFailure,
            readRegressionConfig(projectId).patterns
          );
      }
      if (request.verificationFailure) {
        prompt =
          prompt +
          "\n\n" +
          buildDeterministicVerificationFixSection(
            request.verificationFailure
          );
      }
    }
  }

  if (isReview && request.verificationReport) {
    prompt =
      prompt +
      "\n\n" +
      buildDeterministicVerificationReviewSection(
        request.verificationReport.commands
      );
  }

  // Document mentions: user-written comments only. An agent comment naming a
  // codebase file is not an Arij document reference, and an unresolved mention
  // never stops a background stage — it is reported, not raised.
  const mentionEnrichment = enrichPromptWithDocumentMentions({
    projectId,
    prompt,
    textSources: userAuthoredTexts(promptComments),
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
  // Reviews run in code mode like builds: plan mode refuses mutating MCP
  // tools (submit_findings, create_bug) regardless of the allowlist, and
  // provider read-only postures cut the tool channel entirely. The
  // no-modification rule for reviewers is a prompt contract
  // (REVIEW_BOUNDARY_SECTION in prompt-builder), not a harness restriction.
  const agentMode = "code";

  if (!isReview) {
    transitionBuildStarted({
      projectId,
      epicId,
      scope,
      userStoryId,
      sessionId,
      reason: "Build agent started",
    });
    db.update(epics)
      .set({ branchName, updatedAt: now })
      .where(eq(epics.id, epicId))
      .run();
  }

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
    emitSessionStarted(projectId, epicId, sessionId, agentType);
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

    let buildTerminal: BuildTerminalOutcome | null = null;
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
      buildTerminal = finalizeCodeSession({
        init,
        sessionId,
        result,
        outcome,
        completedAt,
      });
    }

    const sessionResult = {
      success: !!result?.success,
      outcome,
      error: result?.error ?? null,
    };
    return buildTerminal
      ? resolveBuildSessionResult(buildTerminal, sessionResult)
      : sessionResult;
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

  return {
    sessionId,
    settled,
    escalatedToNamedAgent,
    escalatedToProvider,
  };
}

type StageResultPayload = ClaudeResult | undefined;

/** Post-completion effects of a code (build/fix) stage — build-route replica. */
function finalizeCodeSession(input: {
  init: PipelineStageDriverInit;
  sessionId: string;
  result: StageResultPayload;
  outcome: string | null;
  completedAt: string;
}): BuildTerminalOutcome {
  const { init, sessionId, result, outcome, completedAt } = input;
  const { projectId, epicId, userStoryId, scope } = init;

  const terminal = finalizeBuildTerminalOutcome({
    projectId,
    epicId,
    scope,
    userStoryId,
    sessionId,
    success: !!result?.success,
    outcome,
    error: result?.error,
    reason:
      scope === "epic"
        ? "Build completed successfully"
        : "Story build completed successfully",
  });
  if (scope === "epic") {
    if (terminal.kind === "failed" || terminal.kind === "refused") {
      emitSessionFailed(
        projectId,
        epicId,
        sessionId,
        terminal.kind === "refused"
          ? terminal.error
          : result?.error || "Build failed"
      );
    } else {
      emitSessionCompleted(projectId, epicId, sessionId);
    }
  }

  // The stored comment stays complete — agents can pull it whole through
  // get_ticket; only the PROMPT rendering is budgeted
  // (commentHistorySection). resolveSessionOutput scrubs prompt echoes.
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

  return terminal;
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

  // Verdict channels, in priority order: the reviewer's persisted
  // submit_findings verdict, else the prose scan of its final message (see
  // lib/pipeline/findings.ts). A reviewer that asked a question delivered no
  // verdict at all, so neither channel is consulted.
  const decision = askedQuestion
    ? null
    : resolveReviewVerdict({
        epicId,
        reviewSessionId: sessionId,
        sessionOutput: output,
      });
  const isNegativeVerdict = decision?.negative ?? false;

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
      transitionReviewRejected({
        projectId,
        epicId,
        scope: "epic",
        reason: `Review verdict: changes requested (${PIPELINE_REVIEW_LABEL})`,
        sessionId,
        verdictSource: decision?.source,
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
      transitionReviewRejected({
        projectId,
        epicId,
        scope: "story",
        userStoryId,
        reason: `Review verdict: changes requested (${PIPELINE_REVIEW_LABEL})`,
        sessionId,
        verdictSource: decision?.source,
      });
    }
  }
}
