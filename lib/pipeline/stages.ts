import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { loadPromptComments } from "@/lib/claude/prompt-comments";
import {
  agentSessions,
  epics,
  gradingReports,
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
  readCompositeMemberCount,
  resolveAgentByNamedId,
  resolveAgentForDispatch,
  resolveCompositeMemberAtRank,
  type ResolvedAgent,
} from "@/lib/agent-config/agent-resolution";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  REVIEW_TYPE_TO_AGENT_TYPE,
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
  buildMentionContextBlock,
  enrichPromptWithDocumentMentions,
  userAuthoredTexts,
} from "@/lib/documents/mentions";
import {
  createPromptSectionCapture,
  finalizeCapturedPrompt,
} from "@/lib/tokens/dispatch-prompt";
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
  SILENT_BUILD_ERROR,
  transitionBuildStarted,
  transitionReviewRejected,
  transitionReviewPassed,
  type BuildTerminalOutcome,
} from "@/lib/workflow/automatic-transitions";
import {
  buildEpicTargetUrl,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";
import { PIPELINE_REVIEW_TYPE } from "./constants";
import {
  assessReviewOutcome,
  resolveReviewVerdict,
  resolvePriorFindingsFromProse,
  collectBlockingFindings,
  readSessionFindingsWindow,
} from "./findings";
import type {
  PipelineDeterministicVerificationOutcome,
  PipelineGuardCheck,
  PipelineGradingAssessment,
  PipelineReviewAssessment,
  PipelineStageHandle,
  PipelineStageKind,
  PipelineStageRequest,
  PipelineStageResult,
} from "./runner";

/**
 * Real stage launchers for the pipeline runner: review, fix, and build-retry
 * sessions dispatched from this library (not the HTTP routes), replicating
 * the corresponding route closures byte-for-byte in behavior so the board
 * cannot tell a pipeline stage from a human dispatch.
 *
 * Retry ladder per stage — BINARY, with no third path:
 *
 *   SIMPLE AGENT — every attempt runs the SAME agent. Attempt 1 is the
 *                as-configured resolution (build/fix via
 *                resolveAgentByNamedId with the run's ORIGINAL namedAgentId;
 *                review via resolveAgentForDispatch purpose 'review' with the
 *                run's reviewNamedAgentId — null for every caller but Full
 *                Auto Mode, so reviewer segregation can act as before; an
 *                explicit review agent, when set, wins over segregation).
 *                Attempt 2 RESUMES the failed attempt's session when the
 *                machinery allows (validateResumeSession — failed sessions
 *                keep their cliSessionId; status is not checked); later
 *                attempts start fresh. No attempt ever switches agent or
 *                provider, and the attempt cap is `pipeline_max_attempts`.
 *
 *   COMPOSITE    — attempt N runs the member at position N-1, and the LENGTH
 *                OF THE LIST is the attempt budget. Nothing is resumed: each
 *                attempt is a different agent, and a stored cliSessionId only
 *                means something to the CLI that created it.
 *
 * What used to sit at attempts 3 and 3+ — the same-provider effort hop and
 * the first-available-alternative-provider hop — is gone. Neither was
 * reachable under the default attempt cap of 2, and the provider hop threw
 * the named agent away to run a CLI's default model.
 * `pickAlternativeReviewProvider()` survives; it is still what reviewer
 * segregation uses to keep a reviewer off the builder's provider.
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
  /**
   * Attempts `stage` may spend: the configured cap for a simple agent, the
   * member count for a composite. The runner asks once per stage entry.
   */
  attemptBudget(
    stage: PipelineStageKind,
    configuredMaxAttempts: number
  ): Promise<number>;
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

  const codeAgentType: AgentType =
    init.scope === "epic" ? "build" : "ticket_build";
  const reviewAgentType: AgentType =
    REVIEW_TYPE_TO_AGENT_TYPE[PIPELINE_REVIEW_TYPE];

  /**
   * The as-configured resolution for the stage entry currently in flight.
   *
   * Populated when the runner sizes the ladder (`attemptBudget`, attempt 1)
   * and read by every attempt of that stage entry, so the budget and the
   * agents it spends come from ONE resolution rather than from independent
   * repeats of an expensive, live-query-backed path.
   */
  const configuredByStage = new Map<PipelineStageKind, ResolvedAgent>();

  const configuredAgent = async (
    stage: PipelineStageKind,
    refresh = false
  ): Promise<ResolvedAgent> => {
    const cached = configuredByStage.get(stage);
    if (cached && !refresh) return cached;
    const resolved = await resolveConfiguredStageAgent(
      init,
      stage,
      codeAgentType,
      reviewAgentType
    );
    configuredByStage.set(stage, resolved);
    return resolved;
  };

  return {
    attemptBudget: async (stage, configuredMaxAttempts) => {
      // A new stage entry: re-resolve rather than reuse the previous entry's
      // answer, since a run can revisit review after a fix cycle.
      let configured: ResolvedAgent | null = null;
      try {
        configured = await configuredAgent(stage, true);
      } catch {
        // An emptied composite. Leave the cache untouched so the dispatch
        // raises the real error rather than this sizing call.
        configuredByStage.delete(stage);
      }
      return resolveStageAttemptBudget(configured, configuredMaxAttempts);
    },

    launchStage: async (request) => {
      try {
        if (request.stage === "grading") {
          return await dispatchPipelineGradingStage(init);
        }
        return await dispatchPipelineStage(
          init,
          request,
          reviewOutputs,
          configuredAgent
        );
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
          compositeDescent: null,
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
      compositeDescent: null,
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
    compositeDescent: null,
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
  openComments: Array<{
    id: string;
    filePath: string;
    lineNumber: number;
    body: string;
  }>,
  cycle: number
): string {
  if (openComments.length === 0) return "";

  const { kept, dropped } = capOpenFindings(openComments);
  const parts = [
    "## Findings Still Open From Previous Reviews\n",
    `This is review cycle ${cycle} on this ticket. ${openComments.length} finding(s) ` +
      "filed by earlier cycles are still open. Each carries its Arij id as an " +
      "`[RC:id]` token:\n",
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
      parts.push(`- \`[RC:${rc.id}]\` ${findingBodyLine(rc).slice(2)}`);
    }
    parts.push("");
  }

  parts.push(
    `**Work through that list before looking for anything new.** For each open
finding, verify at the current HEAD whether it is fixed, then REPORT the
verdict through the structured channel: include it in \`submit_findings\`'s
\`prior_findings\` array as \`{id, status: "fixed" | "still_open"}\` using the
id from its \`[RC:id]\` token — "fixed" is what resolves the finding in Arij,
prose alone changes nothing. Also echo one line per finding in your report,
in the exact form \`[RC:id] FIXED\` or \`[RC:id] STILL OPEN\`, naming the
evidence you checked — that line is the fallback Arij parses when the
structured channel is unavailable. A finding you do not mention is treated as
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
  /**
   * Set when this attempt moved DOWN one rank of a composite. Carries both
   * ends of the move so the runner's activity trace can name the member that
   * was abandoned as well as the one that replaces it.
   */
  compositeDescent: { from: string; to: string } | null;
}

/**
 * Attempt budget for `stage`: how many attempts its configured agent affords.
 *
 * A SIMPLE agent keeps the configured `pipeline_max_attempts` — it is retried
 * as itself, so the cap is the only thing bounding it. A COMPOSITE's budget is
 * its member count, because each attempt descends a rank and there is nothing
 * below the last member; `pipeline_max_attempts` no longer governs an agent
 * switch, which is the setting's whole former purpose here.
 *
 * A resolution that throws (an emptied composite) reports a budget of 1 rather
 * than propagating: the dispatch itself will fail with the real message, and
 * that is a clearer failure than one raised while merely sizing the ladder.
 */
/**
 * The stage's AS-CONFIGURED agent, before the ladder picks a rank.
 *
 * Sizing the budget and picking the agent both need this, and they used to
 * each resolve it for themselves — twice per stage entry. For a review that is
 * not merely duplicated work: the path dynamic-imports ./review-segregation,
 * runs `findLastSuccessfulBuildProvider`, and when the default resolution
 * matches the builder's provider it awaits `getProvider(p).isAvailable()`
 * across PROVIDER_OPTIONS until one answers — real subprocess probes, paid
 * twice.
 *
 * It was also a correctness smell. The two calls were independent, and
 * `findLastSuccessfulBuildProvider` is a live query, so a segregation decision
 * that flipped between them would size the ladder from one resolution and run
 * another. Resolving once and sharing the result removes the window rather
 * than relying on the two agreeing.
 */
async function resolveConfiguredStageAgent(
  init: PipelineStageDriverInit,
  stage: PipelineStageKind,
  codeAgentType: AgentType,
  reviewAgentType: AgentType
): Promise<ResolvedAgent> {
  if (stage === "review" || stage === "grading") {
    return resolveAgentForDispatch(
      reviewAgentType,
      init.projectId,
      init.reviewNamedAgentId ?? null,
      {
        purpose: stage === "grading" ? "grading" : "review",
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
}

async function resolveStageAttemptBudget(
  configured: ResolvedAgent | null,
  configuredMaxAttempts: number
): Promise<number> {
  // A resolution that already failed (an emptied composite) reports 1 rather
  // than propagating: the dispatch itself will fail with the real message,
  // and that is a clearer failure than one raised while merely sizing.
  if (!configured) return 1;
  if (!configured.compositeAgentId) return configuredMaxAttempts;
  const count = readCompositeMemberCount(configured.compositeAgentId);
  return count && count > 0 ? count : 1;
}

/**
 * Picks the stage's agent for `request.attempt`.
 *
 * TWO SHAPES, AND NO THIRD. A simple agent is retried as ITSELF at every
 * attempt — attempt 2 resumes its failed session where the machinery allows
 * (see the resume decision in dispatchPipelineStage), later attempts start
 * fresh, and no attempt ever switches agent or provider. A composite descends
 * one rank per attempt: attempt N runs the member at position N-1.
 *
 * This replaces the retired ladder, whose attempt-3 rungs (the same-provider
 * effort hop, then the first alternative provider) were unreachable under the
 * default attempt cap of 2 and, when reached, threw the named agent away to
 * run a provider's default model.
 */
function resolveStageAgent(
  request: PipelineStageRequest,
  configured: ResolvedAgent
): ResolvedStageAgent {
  // Simple agent — every attempt, including the first, is this agent.
  if (!configured.compositeAgentId) {
    return { resolved: configured, compositeDescent: null };
  }

  const compositeId = configured.compositeAgentId;
  const rank = request.attempt - 1;
  if (rank <= 0) {
    // Attempt 1 already IS rank 0: `configured` is the unfolded first member.
    return { resolved: configured, compositeDescent: null };
  }

  const step = resolveCompositeMemberAtRank(compositeId, rank);
  if (!step.resolved) {
    // The runner sizes the ladder from the same member count, so asking past
    // the end is a bug rather than a normal end of run. Fail loudly instead
    // of re-running the member that just failed.
    throw new Error(
      `Composite agent has no member at rank ${rank} (${step.memberCount} members)`
    );
  }

  const previous = resolveCompositeMemberAtRank(compositeId, rank - 1);
  return {
    resolved: step.resolved,
    compositeDescent: {
      from: previous.resolved?.name ?? `rank ${rank - 1}`,
      to: step.resolved.name ?? `rank ${rank}`,
    },
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
  reviewOutputs: Map<string, string>,
  /** The driver's per-stage-entry resolution — see `resolveConfiguredStageAgent`. */
  configuredAgent: (stage: PipelineStageKind) => Promise<ResolvedAgent>
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

  const { resolved, compositeDescent } = resolveStageAgent(
    request,
    await configuredAgent(request.stage)
  );

  // ---------------------------------------------------------------------
  // Resume decision. Targets: attempt 2 resumes the failed attempt of THIS
  // stage; a fix's attempt 1 resumes the run's previous code-writing
  // session.
  //
  // A COMPOSITE never resumes: attempt 2 is a DIFFERENT agent, and the stored
  // cliSessionId only means something to the CLI that created it. Resuming
  // one agent's session on another is exactly the cross-provider hand-off
  // validateResumeSession refuses — the check below is the explicit half of
  // that, so the intent survives a future edit to the resume machinery.
  // ---------------------------------------------------------------------
  let resumeTarget: string | null = null;
  if (request.attempt === 2 && !resolved.compositeAgentId) {
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

  const promptSections = createPromptSectionCapture();
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
            promptComments,
            promptSections.collect,
          )
        : buildReviewPrompt(
            project,
            [],
            epic,
            story!,
            PIPELINE_REVIEW_TYPE,
            reviewSystemPrompt,
            promptSections.collect,
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
      promptSections.append("findings", priorFindings);
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
            {
              visualProofEnabled: isVisualProofEnabled(),
              sectionCollector: promptSections.collect,
            },
          )
        : buildTicketBuildPrompt(
            project,
            [],
            epic,
            story!,
            promptComments,
            buildSystemPrompt,
            {
              visualProofEnabled: isVisualProofEnabled(),
              sectionCollector: promptSections.collect,
            },
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
      promptSections.append("findings", reviewContext);
    }
    if (request.stage === "fix") {
      // A grading-only fix must not be described as a code-review rejection.
      // When open review findings also exist, retain both instruction blocks.
      if (!request.gradingFailure || reviewContext) {
        prompt = prompt + "\n\n" + PIPELINE_FIX_INSTRUCTIONS_SECTION;
        promptSections.append("other", PIPELINE_FIX_INSTRUCTIONS_SECTION);
      }
      if (request.gradingFailure) {
        const gradingFixSection = buildGradingFixSection(request.gradingFailure);
        prompt =
          prompt +
          "\n\n" +
          gradingFixSection;
        promptSections.append("findings", gradingFixSection);
      }
      // A regression-gate rejection carries its exact red→green verdict so
      // the agent repairs the real problem instead of guessing.
      if (request.verifyFailure) {
        // Same patterns the gate filtered the diff with, so the prompt states
        // the rule the agent actually has to satisfy.
        const regressionFixSection = buildRegressionFixSection(
          request.verifyFailure,
          readRegressionConfig(projectId).patterns,
        );
        prompt = prompt + "\n\n" + regressionFixSection;
        promptSections.append("findings", regressionFixSection);
      }
      if (request.verificationFailure) {
        const verificationFixSection =
          buildDeterministicVerificationFixSection(
            request.verificationFailure,
          );
        prompt = prompt + "\n\n" + verificationFixSection;
        promptSections.append("findings", verificationFixSection);
      }
    }
  }

  if (isReview && request.verificationReport) {
    const verificationReviewSection =
      buildDeterministicVerificationReviewSection(
        request.verificationReport.commands,
      );
    prompt = prompt + "\n\n" + verificationReviewSection;
    promptSections.append("findings", verificationReviewSection);
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
  promptSections.append(
    "documents",
    buildMentionContextBlock(mentionEnrichment.resolvedDocuments),
  );
  const estimatedPrompt = finalizeCapturedPrompt(
    prompt,
    promptSections,
    mentionEnrichment.missing,
  );
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
    estimatedPromptTokens: estimatedPrompt.tokens.total,
    estimatedPromptBreakdown: JSON.stringify(
      estimatedPrompt.tokens.breakdown,
    ),
    logsPath,
    branchName,
    worktreePath,
    cliSessionId,
    namedAgentId: resolved.namedAgentId ?? null,
    compositeAgentId: resolved.compositeAgentId ?? null,
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
    compositeDescent,
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
    // `silent` sits with the failures: the run delivered nothing, so the desk
    // must not light up as if a build had landed.
    if (
      terminal.kind === "failed" ||
      terminal.kind === "refused" ||
      terminal.kind === "silent"
    ) {
      emitSessionFailed(
        projectId,
        epicId,
        sessionId,
        terminal.kind === "refused"
          ? terminal.error
          : terminal.kind === "silent"
          ? SILENT_BUILD_ERROR
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

  // Prose fallback of submit_findings.prior_findings: [RC:id] FIXED lines in
  // the report resolve the prior findings they name. Idempotent — rows the
  // structured channel (or the runner's assessReview) already resolved are
  // skipped by the status filter.
  if (!askedQuestion) {
    resolvePriorFindingsFromProse({ epicId, sessionOutput: output });
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

  if (!isNegativeVerdict) {
    // A verdict that PASSED promotes the ticket to the merge boundary. An
    // unverifiable review proves nothing and a failed session delivered
    // nothing: both leave the ticket in review to earn another review.
    //
    // The blocking-findings check closes the prose gap: a review with no
    // structured verdict that still filed an open [critical]/[major] row in
    // its window is judged by prose here (resolveReviewVerdict ignores
    // findings on that path for bit-compatibility), while the runner's
    // assessReviewOutcome counts the finding and dispatches a fix. Promoting
    // in that state would show To Merge with an open critical for the length
    // of the fix cycle — and invite a manual merge that resolves it. A
    // structured non-negative verdict implies zero blocking findings, so the
    // check only ever bites on the prose path.
    const findingsWindow = readSessionFindingsWindow(sessionId);
    const blockingInWindow = findingsWindow
      ? collectBlockingFindings(epicId, findingsWindow)
      : [];
    if (
      decision &&
      !decision.unverifiable &&
      blockingInWindow.length === 0 &&
      result?.success &&
      scope === "epic"
    ) {
      try {
        transitionReviewPassed({
          projectId,
          epicId,
          scope: "epic",
          reason: `Review verdict: passed (${PIPELINE_REVIEW_LABEL})`,
          sessionId,
          verdictSource:
            decision.source === "structured" ? "structured" : "prose",
        });
      } catch (err) {
        // A refused promotion (e.g. a concurrent move) holds the ticket in
        // review; the refusal is already in the activity log.
        console.warn(
          "[pipeline] review passed but to_merge promotion was refused:",
          (err as Error).message
        );
      }
    }
    return;
  }

  if (scope === "epic") {
    const currentEpic = db
      .select()
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    if (
      currentEpic &&
      (currentEpic.status === "done" ||
        currentEpic.status === "review" ||
        currentEpic.status === "to_merge")
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
