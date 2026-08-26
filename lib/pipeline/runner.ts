import type { PipelineStage, PipelineState } from "./constants";
import { PIPELINE_REASONS } from "./constants";
import type { ReviewVerdictSource } from "./findings";
import type { VerifyGate, VerifyGateOutcome } from "./verify";
import type { RegressionReportPayload } from "@/lib/verify/regression-report";
import type { VerificationResult } from "@/lib/verify/runner";
import type {
  VerificationReport,
  VerifyCommandResult,
} from "@/lib/verify/verify-constants";
import type {
  GradingEntry,
  GradingFailureContext,
} from "@/lib/grading/report";

/**
 * Autonomous pipeline state machine (build → review → auto-fix → forensic).
 *
 * Wave-runner-shaped engine: `runPipeline` is a pure async function that
 * owns the chaining logic and NOTHING else. Every side effect — session
 * creation, DB writes, activity logging, registry updates — lives in the
 * injected stage launchers and callbacks, so the whole transition matrix is
 * unit-testable with fakes (see wave-runner.ts for the precedent).
 *
 * Chaining works on settled promises: each stage launcher returns a handle
 * whose `settled` promise resolves (never rejects) when the stage session
 * reaches a terminal state — the same contract as `WaveLaunchHandle` and the
 * batch build route's settle wrapper. The runner awaits one stage at a time;
 * a run therefore holds at most one scheduler slot and can never deadlock a
 * per-project budget of 1.
 *
 * The terminal-hook slot (lib/agent-sessions/terminal-hooks.ts) is
 * deliberately NOT used: it is a single slot already consumed by memory
 * auto-distill, and launch closures owning the session lifetime is the
 * codebase's native pattern.
 *
 * Callbacks are invoked synchronously and must not throw (the caller wraps
 * its own side effects) — same convention as WaveRunnerCallbacks.
 */

/**
 * Terminal per-stage result. Shape pinned by the pipeline contract (I2):
 * the build routes' settle wrappers and the forensic module both resolve
 * this structurally (WaveTicketResult family). Settled promises NEVER
 * reject.
 */
export interface PipelineStageResult {
  sessionId: string;
  success: boolean;
  /** Session/workflow verdict (answered, asked_question, silent, error, or transition_refused). */
  outcome: string | null;
  error: string | null;
  /** Exact structured report produced by a grading stage. */
  gradingReportId?: string | null;
  /** A rubric-free epic/story is a successful, journalled no-op. */
  gradingSkipped?: boolean;
}

/** Stages the retry ladder applies to (forensic is dispatch-once). */
export type PipelineStageKind = Exclude<PipelineStage, "forensic">;

/** Handle returned by the injected stage launcher. */
export interface PipelineStageHandle {
  /** Null when the dispatch itself failed before a session row existed. */
  sessionId: string | null;
  /** Resolves (never rejects) when the stage session reaches a terminal state. */
  settled: Promise<PipelineStageResult>;
  /** Named agent selected by the opt-in same-provider effort rung, else null. */
  escalatedToNamedAgent?: string | null;
  /**
   * Provider the stage was escalated to (attempt >= 3 without a configured
   * same-provider model escalation, or attempt >= 4 with one), else
   * null/undefined. Drives the escalation trace.
   */
  escalatedToProvider?: string | null;
}

/** What the runner asks the stage launcher to dispatch. */
export interface PipelineStageRequest {
  stage: PipelineStageKind;
  /** 1-based attempt within the stage (the retry ladder index). */
  attempt: number;
  /** 1-based fix cycle this dispatch belongs to (fix stages; else current count). */
  fixCycle: number;
  /**
   * Failed previous attempt of THIS stage — attempt 2 resumes it when the
   * machinery allows; attempt 3 uses its configured same-provider model
   * escalation when present, then later attempts change provider. Null on
   * attempt 1.
   */
  previousAttemptSessionId: string | null;
  /**
   * Most recent successful code-writing session of the run (initial build or
   * previous fix). Fix stages resume it on attempt 1.
   */
  lastCodeSessionId: string | null;
  /**
   * Set on a fix dispatch triggered by the mechanical regression gate
   * (bug tickets): the exact red→green verdict so the fix prompt carries
   * the precise failure reason. Null/absent for every other dispatch.
   */
  verifyFailure?: RegressionReportPayload | null;
  /** Failed human-configured command whose tail must guide this fix stage. */
  verificationFailure?: VerifyCommandResult;
  /**
   * Passing mechanical evidence appended to this review stage's prompt.
   * Deliberately the client-safe report shape, not the runner's result: the
   * prompt only projects `commands`, and Full Auto forwards a row it read
   * back from `verify_reports` rather than one it just executed.
   */
  verificationReport?: VerificationReport;
  /** Missed acceptance criteria that caused this fix dispatch. */
  gradingFailure?: GradingFailureContext | null;
}

/** Result of resolving and, when configured, running deterministic checks. */
export interface PipelineDeterministicVerificationOutcome {
  /**
   * False when verify_commands is absent/empty (the strict passthrough path)
   * or when the checks could not apply; `skipReason` distinguishes the two
   * so the operator sees why nothing ran.
   */
  ran: boolean;
  result: VerificationResult | null;
  /** Present when configured checks were skipped for an applicability fault. */
  skipReason?: string;
}

/** Verdict of the blocking-findings assessment after a successful review. */
export interface PipelineReviewAssessment {
  blocking: boolean;
  /** Open [critical]/[major] agent findings filed during the stage window. */
  blockingCount: number;
  /** All agent review-comment rows filed during the stage window. */
  agentCommentCount: number;
  /** True when zero rows were filed and the prose scan decided instead. */
  usedProseFallback: boolean;
  /**
   * Which channel decided: `structured` when the reviewer's persisted
   * submit_findings verdict did, `prose` for the fallback path,
   * `unverifiable` when the reviewer had the structured channel and filed
   * nothing on it (blocking on missing evidence, not on a finding).
   */
  verdictSource?: ReviewVerdictSource;
  /** The persisted submit_findings verdict, when the reviewer filed one. */
  structuredVerdict?: string | null;
  /**
   * The reviewer had the structured channel and nothing came through it.
   * Blocking, but with no finding to fix — so the runner re-REVIEWS through
   * the stage ladder instead of dispatching a fix agent.
   */
  unverifiable?: boolean;
}

export interface PipelineGradingAssessment {
  reportId: string;
  summary: string;
  gradings: GradingEntry[];
  missed: GradingEntry[];
}

/** Pre-dispatch guard probe (target conflicts + review-status guard). */
export interface PipelineGuardCheck {
  /**
   * Active (queued|running) session on the run's target that this run did
   * not create, else null. A conflict fails the run: another agent took the
   * ticket.
   */
  conflictSessionId: string | null;
  /**
   * Current status of the run's review target — the epic for epic-scoped
   * runs, the story for story-scoped runs (mirror of the respective review
   * route guards). The review stage requires "review" | "done".
   */
  reviewTargetStatus: string | null;
}

export interface PipelineForensicHandle {
  /** Null when the forensic dispatch was refused or threw. */
  sessionId: string | null;
  settled: Promise<PipelineStageResult>;
}

export type PipelineTerminalState = Extract<
  PipelineState,
  "succeeded" | "failed" | "paused_question" | "cancelled"
>;

export interface PipelineTerminalSummary {
  state: PipelineTerminalState;
  reason: string | null;
  /** Every session the run owned, in dispatch order (initial build first). */
  sessionIds: string[];
  fixCycles: number;
}

export interface PipelineRunnerCallbacks {
  /** The run entered a new running state (stage dispatch imminent). */
  onStageChange?(
    state: PipelineState,
    stage: PipelineStage,
    stageAttempt: number,
    fixCycles: number
  ): void;
  /** A stage session was created (initial build excluded — the caller registered it). */
  onSessionAdded?(sessionId: string, stage: PipelineStage): void;
  /** One activity-trace line (exact PIPELINE_REASONS string). */
  onTrace?(reason: string, sessionId: string | null): void;
  /** The run reached a terminal state. */
  onFinish?(summary: PipelineTerminalSummary): void;
}

export interface RunPipelineOptions {
  /** Per-stage attempt cap (clamped 1..5 by the caller). */
  maxAttempts: number;
  /** Review → fix → review cycle cap (0 = report-only). */
  maxFixCycles: number;
  /** Hard ceiling on sessions the run may own (PIPELINE_MAX_SESSIONS_PER_RUN). */
  maxSessions: number;
  /** Stage 1: the dispatching route's own build session. */
  initialBuild: {
    sessionId: string;
    settled: Promise<PipelineStageResult>;
  };
  /**
   * Dispatches one review/fix/build-retry stage. A thrown error is treated
   * like a dispatch-refusal (a failed attempt on the ladder).
   */
  launchStage(request: PipelineStageRequest): Promise<PipelineStageHandle>;
  /** Blocking-findings assessment for a successful review stage. */
  assessReview(input: {
    sessionId: string;
    stageStartedAt: string;
  }): Promise<PipelineReviewAssessment>;
  /** Reads and validates the exact report filed by a successful grader. */
  assessGrading?(input: {
    sessionId: string;
    reportId: string;
  }): Promise<PipelineGradingAssessment>;
  /**
   * Reads the stage session's row status. Called after every settle (a
   * 'cancelled' row means the user stopped the run) and by the cancel watch
   * that rescues settles for sessions removed from the scheduler queue.
   */
  readSessionStatus(sessionId: string): string | null;
  /** Pre-dispatch guard probe. `ownSessionIds` = sessions this run created. */
  checkGuards(ownSessionIds: string[]): PipelineGuardCheck;
  /** Dispatches the post-mortem after a stage exhausted its ladder. */
  runForensic(input: {
    deadSessionId: string;
    stage: PipelineStageKind;
    attempts: number;
  }): Promise<PipelineForensicHandle>;
  /**
   * Cadence of the cancel watch while awaiting a settle. A session stopped
   * while still QUEUED is removed from the scheduler, so its launch closure
   * never runs and its settled promise would hang forever — the watch reads
   * the row and synthesizes the settle when it finds 'cancelled'.
   */
  cancelPollIntervalMs?: number;
  callbacks?: PipelineRunnerCallbacks;
  /**
   * Mechanical verify gate run after each successful code stage, before
   * review (lib/pipeline/verify.ts). Absent → no gate: behaviour identical
   * to pre-regression runs.
   */
  runVerifyGate?: VerifyGate;
  /** Opt-in only. False/absent preserves the pre-grader pipeline exactly. */
  gradingEnabled?: boolean;
  /**
   * Arij-owned test/lint/build commands run after every successful code stage.
   * Reports are plain persisted records, never agent sessions, so invoking
   * this callback cannot consume the session ceiling.
   */
  runDeterministicVerification?: (
    lastCodeSessionId: string | null
  ) => Promise<PipelineDeterministicVerificationOutcome>;
  /**
   * Parks a gate-rejected bug back to in_progress (guarded review →
   * in_progress) before the run terminates on regression exhaustion — the
   * board counterpart of the terminal failure. Receives the last code
   * session id for the transition's audit trail. Absent → the ticket keeps
   * whatever status the code stage left it in.
   */
  /**
   * Moves a ticket the code stage already promoted to review back to
   * in_progress. `reason` is written verbatim to the activity log, so each
   * call site passes what actually happened rather than one shared string.
   */
  parkRejectedTicket?: (
    lastCodeSessionId: string | null,
    reason: string
  ) => void;
}

const RUNNING_STATE_BY_STAGE: Record<PipelineStageKind, PipelineState> = {
  build: "running_build",
  grading: "running_grading",
  review: "running_review",
  fix: "running_fix",
};

/**
 * Executes one pipeline run to its terminal state. Resolves with the
 * terminal summary; per-stage launch/session failures never reject (they
 * feed the retry ladder). A rejection here is an engine bug.
 */
export async function runPipeline(
  options: RunPipelineOptions
): Promise<PipelineTerminalSummary> {
  const callbacks = options.callbacks ?? {};
  const pollMs = options.cancelPollIntervalMs ?? 2000;

  const sessionIds: string[] = [options.initialBuild.sessionId];
  let stage: PipelineStageKind = "build";
  let stageAttempt = 1;
  let fixCycles = 0;
  let lastCodeSessionId: string | null = null;
  let reviewStageStartedAt = "";
  let handle: PipelineStageHandle = {
    sessionId: options.initialBuild.sessionId,
    settled: options.initialBuild.settled,
    escalatedToProvider: null,
  };
  let currentRequest: PipelineStageRequest | null = null;
  /**
   * Passing mechanical evidence from the latest code stage. Grading sits
   * between that stage and review, so the report has to outlive the dispatch
   * that carried it in order to still reach the reviewer's prompt.
   */
  let lastVerificationReport: VerificationReport | undefined;

  const readStatusSafe = (sessionId: string): string | null => {
    try {
      return options.readSessionStatus(sessionId);
    } catch {
      return null;
    }
  };

  const finish = (
    state: PipelineTerminalState,
    reason: string | null
  ): PipelineTerminalSummary => {
    const summary: PipelineTerminalSummary = {
      state,
      reason,
      sessionIds: [...sessionIds],
      fixCycles,
    };
    callbacks.onFinish?.(summary);
    return summary;
  };

  /**
   * Awaits a stage settle with the cancel watch: when the session row turns
   * 'cancelled' before the closure settles (queued session removed from the
   * scheduler by the user's stop), a synthesized failure settles the wait.
   * First resolution wins; the post-settle status re-read keeps the race
   * benign (both paths see the cancelled row).
   */
  const awaitSettled = (
    current: PipelineStageHandle
  ): Promise<PipelineStageResult> => {
    const sessionId = current.sessionId;
    if (!sessionId) return current.settled;

    return new Promise<PipelineStageResult>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (result: PipelineStageResult): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      current.settled.then(settle, (error: unknown) =>
        // Settled promises never reject by contract — belt and braces.
        settle({
          sessionId,
          success: false,
          outcome: null,
          error:
            error instanceof Error ? error.message : "Stage settled rejected",
        })
      );

      const tick = (): void => {
        if (done) return;
        if (readStatusSafe(sessionId) === "cancelled") {
          settle({
            sessionId,
            success: false,
            outcome: null,
            error: "Cancelled by user",
          });
          return;
        }
        timer = setTimeout(tick, pollMs);
      };
      timer = setTimeout(tick, pollMs);
    });
  };

  /**
   * Guards + dispatches one stage. Returns null when the stage is in flight
   * (`handle` updated), or the terminal summary when a guard tripped.
   */
  const dispatch = async (
    request: PipelineStageRequest
  ): Promise<PipelineTerminalSummary | null> => {
    // Guard (a): hard session cap.
    if (sessionIds.length >= options.maxSessions) {
      callbacks.onTrace?.(PIPELINE_REASONS.failedSessionCap, null);
      return finish("failed", "session cap reached");
    }

    // Guard (b): another agent took the ticket between stages.
    let guard: PipelineGuardCheck;
    try {
      guard = options.checkGuards([...sessionIds]);
    } catch {
      guard = { conflictSessionId: null, reviewTargetStatus: null };
    }
    if (guard.conflictSessionId) {
      callbacks.onTrace?.(
        PIPELINE_REASONS.failedTargetBusy,
        guard.conflictSessionId
      );
      return finish("failed", "target busy: another agent took the ticket");
    }

    // Guard (c): observational grading and review both require the delivered
    // target to still sit in review|done.
    if (
      (request.stage === "grading" || request.stage === "review") &&
      guard.reviewTargetStatus !== "review" &&
      guard.reviewTargetStatus !== "done"
    ) {
      callbacks.onTrace?.(PIPELINE_REASONS.failedTicketNotInReview, null);
      return finish("failed", "ticket left review before the review stage");
    }

    stage = request.stage;
    stageAttempt = request.attempt;
    currentRequest = request;
    callbacks.onStageChange?.(
      RUNNING_STATE_BY_STAGE[request.stage],
      request.stage,
      request.attempt,
      fixCycles
    );

    if (request.stage === "review") {
      // Findings window: everything the reviewer files lands at or after
      // this instant (submit_findings writes explicit ISO timestamps).
      reviewStageStartedAt = new Date().toISOString();
    }

    try {
      handle = await options.launchStage(request);
    } catch (error) {
      handle = {
        sessionId: null,
        settled: Promise.resolve({
          sessionId: "",
          success: false,
          outcome: null,
          error:
            error instanceof Error ? error.message : "Stage dispatch failed",
        }),
        escalatedToNamedAgent: null,
        escalatedToProvider: null,
      };
    }

    if (handle.sessionId) {
      sessionIds.push(handle.sessionId);
      callbacks.onSessionAdded?.(handle.sessionId, request.stage);
    }

    // First attempts announce the stage; retries were announced by the
    // retry trace at the failure decision.
    if (request.attempt === 1) {
      if (request.stage === "review") {
        callbacks.onTrace?.(PIPELINE_REASONS.reviewStarted, handle.sessionId);
      } else if (request.stage === "grading") {
        // A rubric-free dispatch writes its own explicit skip journal entry.
        if (handle.sessionId) {
          callbacks.onTrace?.(
            PIPELINE_REASONS.gradingStarted,
            handle.sessionId
          );
        }
      } else if (request.stage === "fix") {
        callbacks.onTrace?.(
          PIPELINE_REASONS.fixStarted(request.fixCycle, options.maxFixCycles),
          handle.sessionId
        );
      }
    }

    if (handle.escalatedToProvider) {
      callbacks.onTrace?.(
        PIPELINE_REASONS.escalation(request.stage, handle.escalatedToProvider),
        handle.sessionId
      );
    }
    if (handle.escalatedToNamedAgent) {
      callbacks.onTrace?.(
        PIPELINE_REASONS.effortEscalation(
          request.stage,
          handle.escalatedToNamedAgent
        ),
        handle.sessionId
      );
    }

    return null;
  };

  /**
   * Failure path for the current stage: climb the retry ladder, or exhaust
   * into the forensic post-mortem and terminal failure.
   */
  const handleStageFailure = async (): Promise<PipelineTerminalSummary | null> => {
    if (stageAttempt < options.maxAttempts) {
      const nextAttempt = stageAttempt + 1;
      callbacks.onTrace?.(
        PIPELINE_REASONS.retry(stage, nextAttempt, options.maxAttempts),
        handle.sessionId
      );
      return dispatch({
        stage,
        attempt: nextAttempt,
        fixCycle: fixCycles,
        previousAttemptSessionId: handle.sessionId,
        lastCodeSessionId,
        ...(currentRequest?.verifyFailure
          ? { verifyFailure: currentRequest.verifyFailure }
          : {}),
        ...(currentRequest?.gradingFailure
          ? { gradingFailure: currentRequest.gradingFailure }
          : {}),
        ...(currentRequest?.verificationFailure
          ? { verificationFailure: currentRequest.verificationFailure }
          : {}),
        ...(currentRequest?.verificationReport
          ? { verificationReport: currentRequest.verificationReport }
          : {}),
      });
    }

    // Ladder exhausted — post-mortem, then terminal failure. The terminal
    // reason is always the stage failure; the forensic run is best-effort
    // diagnostics and never changes how the run ends (nor does the session
    // cap blocking its dispatch).
    const failedStage = stage;
    const attempts = stageAttempt;
    const reason = `stage ${failedStage} failed after ${attempts} attempts`;
    callbacks.onTrace?.(
      PIPELINE_REASONS.failedStage(failedStage, attempts),
      handle.sessionId
    );

    const deadSessionId = handle.sessionId;
    if (deadSessionId && sessionIds.length < options.maxSessions) {
      callbacks.onStageChange?.("running_forensic", "forensic", 1, fixCycles);
      try {
        const forensic = await options.runForensic({
          deadSessionId,
          stage: failedStage,
          attempts,
        });
        if (forensic.sessionId) {
          sessionIds.push(forensic.sessionId);
          callbacks.onSessionAdded?.(forensic.sessionId, "forensic");
        }
        // Any result (success, failure, refusal) → the run still fails.
        // Awaited through the cancel watch: a forensic session stopped while
        // still QUEUED is removed from the scheduler without its closure ever
        // running, so its settled promise would hang this engine forever.
        await awaitSettled({
          sessionId: forensic.sessionId,
          settled: forensic.settled,
        });
      } catch (error) {
        console.warn(
          "[pipeline] Forensic dispatch failed:",
          error instanceof Error ? error.message : error
        );
      }
    }

    return finish("failed", reason);
  };

  // -------------------------------------------------------------------
  // Main loop — one settled stage per iteration.
  // -------------------------------------------------------------------
  for (;;) {
    const result = await awaitSettled(handle);

    // User stop wins over whatever the closure reported.
    if (
      handle.sessionId &&
      readStatusSafe(handle.sessionId) === "cancelled"
    ) {
      callbacks.onTrace?.(PIPELINE_REASONS.cancelled, handle.sessionId);
      return finish("cancelled", "stopped by user");
    }

    // asked_question at ANY stage pauses the run; the stage closure already
    // held the ticket, notified, and logged via handleAskedQuestionOutcome.
    if (result.outcome === "asked_question") {
      callbacks.onTrace?.(
        PIPELINE_REASONS.pausedQuestion(stage),
        handle.sessionId
      );
      return finish("paused_question", `agent asked a question (${stage})`);
    }

    if (!result.success) {
      const summary = await handleStageFailure();
      if (summary) return summary;
      continue;
    }

    // Success: Arij-owned deterministic commands, then the bug-specific
    // regression gate, then review. Neither mechanical check creates an
    // agent session or enters sessionIds, so the hard ceiling remains an
    // agent-session ceiling.
    if (stage === "build" || stage === "fix") {
      lastCodeSessionId = handle.sessionId ?? lastCodeSessionId;
      let verificationReport: VerificationResult | undefined;
      try {
        if (options.runDeterministicVerification) {
          const verification =
            await options.runDeterministicVerification(lastCodeSessionId);
          if (verification.ran) {
            if (!verification.result) {
              throw new Error("Verification ran without producing a report");
            }

            if (verification.result.status === "pass") {
              verificationReport = verification.result;
              callbacks.onTrace?.(
                PIPELINE_REASONS.deterministicVerificationPassed(
                  verification.result.commands.length
                ),
                handle.sessionId
              );
            } else {
              const failedCommand =
                verification.result.commands.find(
                  (command) => command.exitCode !== 0
                ) ?? verification.result.commands.at(-1);
              if (!failedCommand) {
                throw new Error(
                  "Failed verification report contains no command result"
                );
              }

              callbacks.onTrace?.(
                PIPELINE_REASONS.deterministicVerificationFailed(
                  failedCommand.name
                ),
                handle.sessionId
              );

              if (fixCycles >= options.maxFixCycles) {
                callbacks.onTrace?.(
                  PIPELINE_REASONS.failedDeterministicVerification(fixCycles),
                  handle.sessionId
                );
                try {
                  options.parkRejectedTicket?.(
                    lastCodeSessionId,
                    "Deterministic verification rejected the branch"
                  );
                } catch (parkError) {
                  console.warn(
                    "[pipeline] Failed to park verification-rejected ticket:",
                    parkError instanceof Error
                      ? parkError.message
                      : parkError
                  );
                }
                return finish(
                  "failed",
                  `deterministic verification still failing after ${fixCycles} fix cycles`
                );
              }

              fixCycles += 1;
              const summary = await dispatch({
                stage: "fix",
                fixCycle: fixCycles,
                attempt: 1,
                previousAttemptSessionId: null,
                lastCodeSessionId,
                verificationFailure: failedCommand,
              });
              if (summary) return summary;
              continue;
            }
          } else if (verification.skipReason) {
            callbacks.onTrace?.(
              PIPELINE_REASONS.deterministicVerificationSkipped(
                verification.skipReason
              ),
              handle.sessionId
            );
          }
        }
      } catch (error) {
        console.warn(
          "[pipeline] Deterministic verification crashed:",
          error instanceof Error ? error.message : error
        );
        callbacks.onTrace?.(
          PIPELINE_REASONS.failedDeterministicVerificationCrashed,
          handle.sessionId
        );
        try {
          options.parkRejectedTicket?.(
            lastCodeSessionId,
            "Deterministic verification crashed before it could verify the branch"
          );
        } catch (parkError) {
          console.warn(
            "[pipeline] Failed to park verification-crashed ticket:",
            parkError instanceof Error ? parkError.message : parkError
          );
        }
        return finish("failed", "deterministic verification crashed");
      }

      let gate: VerifyGateOutcome = { ran: false, passed: null, result: null };
      try {
        if (options.runVerifyGate) {
          gate = await options.runVerifyGate(lastCodeSessionId);
        }
      } catch (error) {
        console.warn(
          "[pipeline] Regression gate crashed:",
          error instanceof Error ? error.message : error
        );
        callbacks.onTrace?.(
          PIPELINE_REASONS.failedRegressionGateCrashed,
          handle.sessionId
        );
        try {
          options.parkRejectedTicket?.(
            lastCodeSessionId,
            "Regression gate crashed before it could verify the branch"
          );
        } catch (parkError) {
          console.warn(
            "[pipeline] Failed to park regression-crashed ticket:",
            parkError instanceof Error ? parkError.message : parkError
          );
        }
        return finish("failed", "regression gate crashed");
      }
      if (gate.ran && !gate.passed && gate.result) {
        const payload: RegressionReportPayload = {
          regression: {
            status: gate.result.status,
            reason: gate.result.reason,
            testFiles: gate.result.testFiles,
            detail: gate.result.detail,
            checkedAt: new Date().toISOString(),
          },
        };

        // command_error means the command failed to execute (environment or
        // configuration fault, e.g. runner missing or timeout). An agent in
        // a fix cycle cannot fix an environment fault — fail immediately
        // rather than burning the fix budget.
        if (gate.result.reason === "command_error") {
          callbacks.onTrace?.(
            PIPELINE_REASONS.failedRegressionCommandError,
            handle.sessionId
          );
          try {
            options.parkRejectedTicket?.(
              lastCodeSessionId,
              "Regression test command could not run — the branch was never verified"
            );
          } catch (parkError) {
            console.warn(
              "[pipeline] Failed to park regression-rejected ticket:",
              parkError instanceof Error ? parkError.message : parkError
            );
          }
          return finish(
            "failed",
            `regression command error: ${gate.result.detail ?? "could not run command"}`
          );
        }

        if (fixCycles >= options.maxFixCycles) {
          callbacks.onTrace?.(
            PIPELINE_REASONS.failedRegression(fixCycles),
            handle.sessionId
          );
          // The code stage already moved the ticket to review; a gate
          // rejection is the opposite of approval-ready. Park it back in
          // in_progress like the negative-review path does — best effort,
          // it must not change how the run terminates.
          try {
            options.parkRejectedTicket?.(
              lastCodeSessionId,
              "Mandatory regression test rejected the branch (red → green)"
            );
          } catch (parkError) {
            console.warn(
              "[pipeline] Failed to park regression-rejected ticket:",
              parkError instanceof Error ? parkError.message : parkError
            );
          }
          return finish(
            "failed",
            `mandatory regression test still failing after ${fixCycles} fix cycles`
          );
        }
        fixCycles += 1;
        callbacks.onTrace?.(
          PIPELINE_REASONS.regressionFailed(fixCycles, options.maxFixCycles),
          handle.sessionId
        );
        const summary = await dispatch({
          stage: "fix",
          attempt: 1,
          fixCycle: fixCycles,
          previousAttemptSessionId: null,
          lastCodeSessionId,
          verifyFailure: payload,
        });
        if (summary) return summary;
        continue;
      }
      lastVerificationReport = verificationReport;
      const summary = await dispatch({
        stage: options.gradingEnabled ? "grading" : "review",
        attempt: 1,
        fixCycle: fixCycles,
        previousAttemptSessionId: null,
        lastCodeSessionId,
        ...(verificationReport ? { verificationReport } : {}),
      });
      if (summary) return summary;
      continue;
    }

    // Grading success is assessed only from the exact structured report id
    // returned by this stage. A rubric-free target is an intentional no-op.
    if (stage === "grading") {
      if (result.gradingSkipped) {
        const summary = await dispatch({
          stage: "review",
          attempt: 1,
          fixCycle: fixCycles,
          previousAttemptSessionId: null,
          lastCodeSessionId,
          // Grading sits between the code stage and review, so the passing
          // mechanical evidence has to survive the hop to reach the reviewer.
          ...(lastVerificationReport
            ? { verificationReport: lastVerificationReport }
            : {}),
        });
        if (summary) return summary;
        continue;
      }

      let grading: PipelineGradingAssessment;
      try {
        if (!result.gradingReportId || !options.assessGrading) {
          throw new Error("Grading stage completed without a readable report");
        }
        grading = await options.assessGrading({
          sessionId: handle.sessionId ?? "",
          reportId: result.gradingReportId,
        });
      } catch {
        const summary = await handleStageFailure();
        if (summary) return summary;
        continue;
      }

      if (grading.missed.length === 0) {
        callbacks.onTrace?.(PIPELINE_REASONS.gradingPassed, handle.sessionId);
        const summary = await dispatch({
          stage: "review",
          attempt: 1,
          fixCycle: fixCycles,
          previousAttemptSessionId: null,
          lastCodeSessionId,
          // Grading sits between the code stage and review, so the passing
          // mechanical evidence has to survive the hop to reach the reviewer.
          ...(lastVerificationReport
            ? { verificationReport: lastVerificationReport }
            : {}),
        });
        if (summary) return summary;
        continue;
      }

      if (fixCycles >= options.maxFixCycles) {
        callbacks.onTrace?.(
          PIPELINE_REASONS.failedGrading(grading.missed.length, fixCycles),
          handle.sessionId
        );
        try {
          options.parkRejectedTicket?.(
            lastCodeSessionId,
            "Acceptance grading found missed criteria after the fix-cycle budget was exhausted"
          );
        } catch (parkError) {
          console.warn(
            "[pipeline] Failed to park grading-rejected ticket:",
            parkError instanceof Error ? parkError.message : parkError
          );
        }
        return finish(
          "failed",
          `${grading.missed.length} acceptance ${grading.missed.length === 1 ? "criterion remains" : "criteria remain"} missed after ${fixCycles} fix cycles`
        );
      }

      fixCycles += 1;
      callbacks.onTrace?.(
        PIPELINE_REASONS.gradingMissed(
          grading.missed.length,
          fixCycles,
          options.maxFixCycles
        ),
        handle.sessionId
      );
      const summary = await dispatch({
        stage: "fix",
        attempt: 1,
        fixCycle: fixCycles,
        previousAttemptSessionId: null,
        lastCodeSessionId,
        gradingFailure: {
          reportId: grading.reportId,
          summary: grading.summary,
          missed: grading.missed,
        },
      });
      if (summary) return summary;
      continue;
    }

    // Review success: assess blocking findings.
    let assessment: PipelineReviewAssessment;
    try {
      assessment = await options.assessReview({
        sessionId: handle.sessionId ?? "",
        stageStartedAt: reviewStageStartedAt,
      });
    } catch {
      // An assessment crash must never green-light the change — treat it
      // as a failed review attempt and let the ladder decide.
      const summary = await handleStageFailure();
      if (summary) return summary;
      continue;
    }

    if (!assessment.blocking) {
      // Success end-state: green review awaiting human sign-off. The
      // pipeline NEVER auto-approves — review → done stays human-gated by
      // the workflow engine.
      callbacks.onTrace?.(PIPELINE_REASONS.finished, handle.sessionId);
      return finish("succeeded", null);
    }

    if (assessment.unverifiable) {
      // The review delivered nothing Arij can read, and filed no finding — so
      // there is nothing for a fix agent to do. Dispatching one anyway hands
      // it "fix every [critical] and [major] item" with an empty list, and it
      // no-ops or invents changes to a branch nothing faulted. This is a
      // FAILED REVIEW ATTEMPT: the ladder re-runs the review (a fresh session
      // usually gets a working channel), and exhausting it fails the run with
      // a forensic, exactly like a reviewer that crashed.
      const summary = await handleStageFailure();
      if (summary) return summary;
      continue;
    }

    if (fixCycles >= options.maxFixCycles) {
      // Nothing crashed — the open findings + trace are the diagnostic, so
      // no forensic here.
      callbacks.onTrace?.(
        PIPELINE_REASONS.failedFindings(fixCycles),
        handle.sessionId
      );
      return finish(
        "failed",
        `blocking findings remain after ${fixCycles} fix cycles`
      );
    }

    fixCycles += 1;
    const summary = await dispatch({
      stage: "fix",
      attempt: 1,
      fixCycle: fixCycles,
      previousAttemptSessionId: null,
      lastCodeSessionId,
    });
    if (summary) return summary;
  }
}
