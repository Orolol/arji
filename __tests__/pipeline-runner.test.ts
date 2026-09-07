/**
 * Tests for the autonomous pipeline state machine (lib/pipeline/runner.ts)
 * with scripted fake launchers, wave-runner-test style: every transition of
 * the contract's D3 matrix, the retry/escalation ladder, cycle/session caps,
 * asked_question pause, user stop (settled and queued-removed variants), and
 * the trace-string contract.
 */
import { describe, it, expect } from "vitest";

import {
  runPipeline,
  type PipelineGuardCheck,
  type PipelineStageRequest,
  type PipelineStageResult,
  type PipelineTerminalSummary,
} from "@/lib/pipeline/runner";
import { PIPELINE_REASONS } from "@/lib/pipeline/constants";

interface ScriptedStage {
  /** Explicit id; null = the dispatch fails before a session row exists. */
  sessionId?: string | null;
  success?: boolean;
  outcome?: string | null;
  error?: string | null;
  /** This attempt moved one rank down a composite agent. */
  compositeDescent?: { from: string; to: string } | null;
  /** Row status after settle (default: completed/failed by success). */
  rowStatus?: string;
  /** The settled promise never resolves (session stopped while queued). */
  neverSettle?: boolean;
  /** launchStage throws. */
  throwOnLaunch?: boolean;
}

/**
 * `true`/`false` = blocking findings or a clean review. `"throw"` = the
 * assessment itself crashed. `"unverifiable"` = the review delivered but its
 * structured channel produced nothing AND nothing was recovered from its
 * prose — blocking, with no finding to fix, so the ladder must re-REVIEW.
 * `"unverifiable-with-findings"` = the same broken channel, but
 * `ingestProseFindings` recovered anchored findings from the report: there IS
 * something to fix, and the run must not throw it away.
 */
type ScriptedAssessment =
  | boolean
  | "throw"
  | "unverifiable"
  | "unverifiable-with-findings";

interface HarnessConfig {
  build?: ScriptedStage;
  stages?: ScriptedStage[];
  assessments?: ScriptedAssessment[];
  guards?: PipelineGuardCheck[];
  maxAttempts?: number;
  /**
   * Per-stage attempt budget the driver reports — a composite's member count.
   * Absent means "no `attemptBudget` callback at all", which is the shape
   * every pre-existing caller had and must keep behaving identically.
   */
  attemptBudget?: number;
  /**
   * Per-stage budget, for a run holding a composite on one stage and a simple
   * agent on another. Takes precedence over the flat `attemptBudget`.
   */
  attemptBudgetByStage?: Partial<Record<string, number>>;
  maxFixCycles?: number;
  maxSessions?: number;
  forensicSessionId?: string | null;
  /**
   * The forensic settled promise never resolves (forensic session stopped
   * while queued → scheduler removal, closure never runs). The row status is
   * scripted 'cancelled' so the cancel watch can rescue the await.
   */
  forensicNeverSettle?: boolean;
}

const OPEN_GUARD: PipelineGuardCheck = {
  conflictSessionId: null,
  reviewTargetStatus: "review",
};

function runScripted(config: HarnessConfig = {}) {
  const traces: Array<{ reason: string; sessionId: string | null }> = [];
  const stateChanges: Array<{
    state: string;
    stage: string;
    attempt: number;
    fixCycles: number;
  }> = [];
  const added: Array<{ sessionId: string; stage: string }> = [];
  const requests: PipelineStageRequest[] = [];
  const forensicInputs: Array<{
    deadSessionId: string;
    stage: string;
    attempts: number;
  }> = [];
  const guardCalls: string[][] = [];
  const rowStatus = new Map<string, string>();
  let finished: PipelineTerminalSummary | null = null;
  let stageIndex = 0;
  let assessIndex = 0;
  let guardIndex = 0;

  const build = config.build ?? {};
  const buildSessionId = "s-build";
  const buildSuccess = build.success ?? true;
  rowStatus.set(
    buildSessionId,
    build.rowStatus ?? (buildSuccess ? "completed" : "failed")
  );
  const buildSettled = build.neverSettle
    ? new Promise<PipelineStageResult>(() => {})
    : Promise.resolve<PipelineStageResult>({
        sessionId: buildSessionId,
        success: buildSuccess,
        outcome:
          build.outcome !== undefined
            ? build.outcome
            : buildSuccess
              ? "answered"
              : "error",
        error: build.error ?? null,
      });

  const budgetedStages: string[] = [];
  const budgetFor = (stage: string): number | undefined =>
    config.attemptBudgetByStage?.[stage] ?? config.attemptBudget;

  const promise = runPipeline({
    maxAttempts: config.maxAttempts ?? 2,
    ...(config.attemptBudget !== undefined ||
    config.attemptBudgetByStage !== undefined
      ? {
          attemptBudget: (stage: string) => {
            budgetedStages.push(stage);
            // `NaN` for an unbudgeted stage: the runner rejects a
            // non-finite budget and keeps the configured cap, which is the
            // real shape of "this stage resolved to a simple agent".
            return budgetFor(stage) ?? Number.NaN;
          },
        }
      : {}),
    maxFixCycles: config.maxFixCycles ?? 2,
    maxSessions: config.maxSessions ?? 12,
    initialBuild: { sessionId: buildSessionId, settled: buildSettled },
    launchStage: async (request) => {
      requests.push(request);
      // Increment OUTSIDE the optional chain: `stages?.[stageIndex++]`
      // would skip the increment whenever no stages were scripted.
      const index = stageIndex;
      stageIndex += 1;
      const script = config.stages?.[index] ?? {};
      if (script.throwOnLaunch) {
        throw new Error(script.error ?? "launch exploded");
      }
      const sessionId =
        script.sessionId === null
          ? null
          : (script.sessionId ?? `s-${request.stage}-${index + 1}`);
      const success = script.success ?? true;
      if (sessionId) {
        rowStatus.set(
          sessionId,
          script.rowStatus ?? (success ? "completed" : "failed")
        );
      }
      const result: PipelineStageResult = {
        sessionId: sessionId ?? "",
        success,
        outcome:
          script.outcome !== undefined
            ? script.outcome
            : success
              ? "answered"
              : "error",
        error: script.error ?? null,
      };
      return {
        sessionId,
        settled: script.neverSettle
          ? new Promise<PipelineStageResult>(() => {})
          : Promise.resolve(result),
        compositeDescent: script.compositeDescent ?? null,
      };
    },
    assessReview: async () => {
      const index = assessIndex;
      assessIndex += 1;
      const scripted = config.assessments?.[index] ?? false;
      if (scripted === "throw") throw new Error("assessment exploded");
      if (
        scripted === "unverifiable" ||
        scripted === "unverifiable-with-findings"
      ) {
        const recovered = scripted === "unverifiable-with-findings";
        return {
          blocking: true,
          // Rows recovered by ingestProseFindings carry agent_session_id
          // NULL, so they never prove the channel worked: the session stays
          // unverifiable while blockingCount is non-zero.
          blockingCount: recovered ? 1 : 0,
          agentCommentCount: 0,
          usedProseFallback: false,
          unverifiable: true,
          verdictSource: "unverifiable" as const,
        };
      }
      return {
        blocking: scripted,
        blockingCount: scripted ? 1 : 0,
        agentCommentCount: 1,
        usedProseFallback: false,
      };
    },
    readSessionStatus: (sessionId) => rowStatus.get(sessionId) ?? null,
    checkGuards: (ownSessionIds) => {
      guardCalls.push(ownSessionIds);
      const index = guardIndex;
      guardIndex += 1;
      return config.guards?.[index] ?? OPEN_GUARD;
    },
    runForensic: async (input) => {
      forensicInputs.push(input);
      const sessionId =
        config.forensicSessionId === undefined
          ? "s-forensic"
          : config.forensicSessionId;
      if (config.forensicNeverSettle) {
        if (sessionId) rowStatus.set(sessionId, "cancelled");
        return {
          sessionId,
          settled: new Promise<PipelineStageResult>(() => {}),
        };
      }
      return {
        sessionId,
        settled: Promise.resolve({
          sessionId: sessionId ?? "",
          success: true,
          outcome: "answered",
          error: null,
        }),
      };
    },
    cancelPollIntervalMs: 5,
    callbacks: {
      onStageChange: (state, stage, attempt, fixCycles) =>
        stateChanges.push({ state, stage, attempt, fixCycles }),
      onSessionAdded: (sessionId, stage) => added.push({ sessionId, stage }),
      onTrace: (reason, sessionId) => traces.push({ reason, sessionId }),
      onFinish: (summary) => {
        finished = summary;
      },
    },
  });

  return {
    promise,
    traces,
    stateChanges,
    added,
    requests,
    forensicInputs,
    guardCalls,
    rowStatus,
    budgetedStages,
    reasons: () => traces.map((t) => t.reason),
    finished: () => finished,
  };
}

describe("runPipeline — happy path", () => {
  it("build success → review (non-blocking) → succeeded, ticket left in review", async () => {
    const h = runScripted({ assessments: [false] });
    const summary = await h.promise;

    expect(summary).toMatchObject({ state: "succeeded", reason: null });
    expect(summary.sessionIds).toEqual(["s-build", "s-review-1"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      stage: "review",
      attempt: 1,
      previousAttemptSessionId: null,
      lastCodeSessionId: "s-build",
    });
    expect(h.reasons()).toEqual([
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.finished,
    ]);
    expect(h.stateChanges).toEqual([
      { state: "running_review", stage: "review", attempt: 1, fixCycles: 0 },
    ]);
    expect(h.added).toEqual([{ sessionId: "s-review-1", stage: "review" }]);
    expect(h.finished()).toMatchObject({ state: "succeeded" });
  });

  it("review blocking → fix (resuming the build session) → review clean → succeeded", async () => {
    const h = runScripted({ assessments: [true, false] });
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(summary.fixCycles).toBe(1);
    expect(h.requests.map((r) => r.stage)).toEqual(["review", "fix", "review"]);
    // Fix cycle 1 resumes the initial build; the second review carries the
    // fix session as the latest code writer.
    expect(h.requests[1]).toMatchObject({
      stage: "fix",
      attempt: 1,
      fixCycle: 1,
      lastCodeSessionId: "s-build",
    });
    expect(h.requests[2].lastCodeSessionId).toBe("s-fix-2");
    expect(h.reasons()).toEqual([
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.fixStarted(1, 2),
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.finished,
    ]);
  });
});

describe("runPipeline — asked_question pause", () => {
  it("build asked_question → paused_question, no further dispatch", async () => {
    const h = runScripted({ build: { outcome: "asked_question" } });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "paused_question",
      reason: "agent asked a question (build)",
    });
    expect(h.requests).toHaveLength(0);
    expect(h.reasons()).toEqual([PIPELINE_REASONS.pausedQuestion("build")]);
  });

  it("review asked_question → paused_question with the review stage named", async () => {
    const h = runScripted({ stages: [{ outcome: "asked_question" }] });
    const summary = await h.promise;

    expect(summary.state).toBe("paused_question");
    expect(h.reasons()).toContain(PIPELINE_REASONS.pausedQuestion("review"));
  });

  it("fix asked_question → paused_question with the fix stage named", async () => {
    const h = runScripted({
      assessments: [true],
      stages: [{}, { outcome: "asked_question" }],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("paused_question");
    expect(h.reasons()).toContain(PIPELINE_REASONS.pausedQuestion("fix"));
  });
});

describe("runPipeline — user stop", () => {
  it("cancelled session row wins over the settled result", async () => {
    const h = runScripted({ build: { rowStatus: "cancelled" } });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "cancelled",
      reason: "stopped by user",
    });
    expect(h.reasons()).toEqual([PIPELINE_REASONS.cancelled]);
    expect(h.requests).toHaveLength(0);
  });

  it("rescues a queued session whose closure never runs (scheduler removal)", async () => {
    // Stop of a QUEUED session removes it from the scheduler: the launch
    // closure never runs, its settled promise never resolves. The cancel
    // watch reads the 'cancelled' row and synthesizes the settle.
    const h = runScripted({
      build: { neverSettle: true, rowStatus: "cancelled" },
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "cancelled",
      reason: "stopped by user",
    });
  });

  it("rescues a queued stage session too, not just the initial build", async () => {
    const h = runScripted({
      stages: [{ neverSettle: true, rowStatus: "cancelled" }],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("cancelled");
    expect(h.requests).toHaveLength(1);
  });
});

describe("runPipeline — retry ladder and forensic", () => {
  it("build failure retries once, then exhausts into forensic + terminal failure", async () => {
    const h = runScripted({
      build: { success: false, error: "tests failed" },
      stages: [{ success: false, error: "still failing" }],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "stage build failed after 2 attempts",
    });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      stage: "build",
      attempt: 2,
      previousAttemptSessionId: "s-build",
    });
    expect(h.reasons()).toEqual([
      PIPELINE_REASONS.retry("build", 2, 2),
      PIPELINE_REASONS.failedStage("build", 2),
    ]);
    expect(h.forensicInputs).toEqual([
      { deadSessionId: "s-build-1", stage: "build", attempts: 2 },
    ]);
    // Forensic session is recorded on the run.
    expect(h.added).toContainEqual({
      sessionId: "s-forensic",
      stage: "forensic",
    });
    expect(
      h.stateChanges.some((c) => c.state === "running_forensic")
    ).toBe(true);
  });

  it("review failure ladder: retry resumes the failed attempt, then forensic on the review stage", async () => {
    const h = runScripted({
      stages: [
        { success: false, error: "review crashed" },
        { success: false, error: "review crashed again" },
      ],
    });
    const summary = await h.promise;

    expect(summary.reason).toBe("stage review failed after 2 attempts");
    expect(h.requests[1]).toMatchObject({
      stage: "review",
      attempt: 2,
      previousAttemptSessionId: "s-review-1",
    });
    expect(h.forensicInputs[0]).toMatchObject({
      stage: "review",
      attempts: 2,
    });
  });

  it("traces a composite rank-down naming both ends and the reason", async () => {
    const h = runScripted({
      attemptBudget: 3,
      stages: [
        { success: false },
        { compositeDescent: { from: "Sonnet reviewer", to: "Codex reviewer" } },
      ],
      assessments: [false],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(h.requests.map((r) => r.attempt)).toEqual([1, 2]);
    // The reason travels INTO the request, so the stage driver could act on
    // it, and out into the trace so a reader can see what the descent was for.
    expect(h.requests[1].descentReason).toBe("the session failed");
    expect(h.reasons()).toContain(
      PIPELINE_REASONS.compositeRankDown(
        "review",
        "Sonnet reviewer",
        "Codex reviewer",
        "the session failed",
        2,
        3
      )
    );
  });

  it("names the descent reason for a silent and for a refused attempt", async () => {
    const silent = runScripted({
      attemptBudget: 2,
      stages: [
        { success: false, outcome: "silent" },
        { compositeDescent: { from: "A", to: "B" } },
      ],
      assessments: [false],
    });
    await silent.promise;
    expect(silent.requests[1].descentReason).toBe(
      "the agent delivered nothing"
    );

    const refused = runScripted({
      attemptBudget: 2,
      stages: [
        { success: false, outcome: "transition_refused" },
        { compositeDescent: { from: "A", to: "B" } },
      ],
      assessments: [false],
    });
    await refused.promise;
    expect(refused.requests[1].descentReason).toBe(
      "its workflow transition was refused"
    );
  });

  it("spends a composite's member count, not the configured attempt cap", async () => {
    // `maxAttempts` stays at the product default of 2 while the composite
    // reports three members. The ladder must follow the LIST — this is the
    // whole reason `pipeline_max_attempts` no longer gates an agent switch.
    const h = runScripted({
      maxAttempts: 2,
      attemptBudget: 3,
      stages: [{ success: false }, { success: false }, { success: false }],
    });
    const summary = await h.promise;

    expect(summary.reason).toBe("stage review failed after 3 attempts");
    expect(h.requests.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(h.reasons()).toContain(PIPELINE_REASONS.retry("review", 3, 3));
  });

  /**
   * THE BUILD STAGE IS SIZED TOO — the case every other ladder test misses.
   *
   * The initial build never passes through the runner's `dispatch()`: the
   * ROUTE launched it and hands it in as `options.initialBuild`. So the one
   * place its budget can be asked is before the loop, and while it was not,
   * `pipeline_max_attempts` still governed a build composite — the exact
   * mechanism this epic removed, surviving on the stage a build composite
   * exists for.
   *
   * These two cases fail in opposite directions on the unfixed runner, which
   * is why both are here: a list LONGER than the cap loses its tail, and a
   * list SHORTER than the cap sends `launchStage` after a rank that does not
   * exist.
   */
  it("spends a BUILD composite's member count, not the configured attempt cap", async () => {
    const h = runScripted({
      maxAttempts: 2,
      attemptBudget: 4,
      build: { success: false },
      stages: [
        { success: false },
        { success: false },
        { success: false },
        { success: false },
      ],
    });
    const summary = await h.promise;

    // Attempt 1 was the route's build; the engine owns 2, 3 and 4.
    expect(h.requests.map((r) => r.attempt)).toEqual([2, 3, 4]);
    expect(h.requests.every((r) => r.stage === "build")).toBe(true);
    expect(summary.reason).toBe("stage build failed after 4 attempts");
    expect(h.reasons()).toContain(PIPELINE_REASONS.retry("build", 4, 4));
    // The budget was asked for the build stage, not only for the later ones.
    expect(h.budgetedStages[0]).toBe("build");
  });

  it("stops a BUILD composite at its last member even when the cap is higher", async () => {
    // Two members under a cap of five. Attempts 3-5 would ask
    // `resolveCompositeMemberAtRank` for ranks that do not exist, which
    // throws inside `launchStage` and burns attempts on an internal error.
    const h = runScripted({
      maxAttempts: 5,
      attemptBudget: 2,
      build: { success: false },
      stages: [{ success: false }, { success: false }, { success: false }],
    });
    const summary = await h.promise;

    expect(h.requests.map((r) => r.attempt)).toEqual([2]);
    expect(summary.reason).toBe("stage build failed after 2 attempts");
  });

  it("sizes each stage separately when build and review resolve differently", async () => {
    // A composite for the code stages and a simple agent for review: the
    // build ladder must follow the list while review keeps the configured
    // cap. Re-asking per stage entry is what makes that possible.
    const h = runScripted({
      maxAttempts: 2,
      attemptBudgetByStage: { build: 3 },
      build: { success: false },
      stages: [
        { success: false },
        { success: true },
        { success: false },
        { success: false },
      ],
    });
    const summary = await h.promise;

    expect(h.requests.map((r) => `${r.stage}:${r.attempt}`)).toEqual([
      "build:2",
      "build:3",
      "review:1",
      "review:2",
    ]);
    expect(summary.reason).toBe("stage review failed after 2 attempts");
  });

  it("lets the session ceiling cut a composite longer than the run's budget", async () => {
    // Five members, but the run may only own three sessions in total — the
    // initial build plus two. PIPELINE_MAX_SESSIONS_PER_RUN is the runaway
    // guard and it outranks the list.
    const h = runScripted({
      attemptBudget: 5,
      maxSessions: 3,
      stages: [
        { success: false },
        { success: false },
        { success: false },
        { success: false },
      ],
    });
    const summary = await h.promise;

    expect(h.requests.map((r) => r.attempt)).toEqual([1, 2]);
    expect(summary.state).toBe("failed");
    expect(summary.reason).toBe(
      "stage review failed after 2 attempts (session ceiling reached)"
    );
  });

  it("maxAttempts 1 fails straight into forensic without a retry trace", async () => {
    const h = runScripted({
      maxAttempts: 1,
      build: { success: false },
    });
    const summary = await h.promise;

    expect(summary.reason).toBe("stage build failed after 1 attempts");
    expect(h.reasons()).toEqual([PIPELINE_REASONS.failedStage("build", 1)]);
    expect(h.forensicInputs).toEqual([
      { deadSessionId: "s-build", stage: "build", attempts: 1 },
    ]);
  });

  it("a forensic session stopped while queued cannot hang the engine (cancel-watch rescue)", async () => {
    // Scheduler removal of a queued forensic session drops its launch
    // closure: `settled` would never resolve. The runner must await the
    // forensic through the same cancel watch as the stages and still close
    // the run with the stage-failure reason (forensic never changes the
    // terminal outcome).
    const h = runScripted({
      maxAttempts: 1,
      build: { success: false },
      forensicNeverSettle: true,
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "stage build failed after 1 attempts",
    });
    expect(h.added).toContainEqual({
      sessionId: "s-forensic",
      stage: "forensic",
    });
  });

  it("a throwing dispatch counts as a failed attempt (fresh retry, no resume target)", async () => {
    const h = runScripted({
      stages: [{ throwOnLaunch: true }, {}],
      assessments: [false],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(h.requests[1]).toMatchObject({
      stage: "review",
      attempt: 2,
      previousAttemptSessionId: null,
    });
  });

  it("skips forensic when the exhausted stage never produced a session", async () => {
    const h = runScripted({
      stages: [{ throwOnLaunch: true }, { throwOnLaunch: true }],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "stage review failed after 2 attempts",
    });
    expect(h.forensicInputs).toHaveLength(0);
  });

  it("an assessment crash is treated as a failed review attempt, never a green light", async () => {
    const h = runScripted({
      assessments: ["throw", false],
      stages: [{}, {}],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(h.requests.map((r) => [r.stage, r.attempt])).toEqual([
      ["review", 1],
      ["review", 2],
    ]);
  });
});

describe("runPipeline — fix cycle caps", () => {
  it("blocking findings after the last cycle fail the run WITHOUT forensic", async () => {
    const h = runScripted({
      maxFixCycles: 1,
      assessments: [true, true],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "blocking findings remain after 1 fix cycles",
    });
    expect(h.forensicInputs).toHaveLength(0);
    expect(h.reasons()).toContain(PIPELINE_REASONS.failedFindings(1));
    expect(h.requests.map((r) => r.stage)).toEqual(["review", "fix", "review"]);
  });

  it("maxFixCycles 0 = report-only: first blocking review is terminal", async () => {
    const h = runScripted({ maxFixCycles: 0, assessments: [true] });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "blocking findings remain after 0 fix cycles",
    });
    expect(h.requests.map((r) => r.stage)).toEqual(["review"]);
  });

  /**
   * A review whose structured channel produced nothing is blocking, but
   * there is nothing to FIX: no finding was filed, so a fix agent would be
   * dispatched with an empty findings list and instructions to "fix every
   * [critical] and [major] item". The remedy for a broken review channel is
   * another review, so it goes through the stage ladder instead.
   */
  it("re-reviews an unverifiable review instead of dispatching a fix", async () => {
    const h = runScripted({
      stages: [
        { sessionId: "s-review-1" },
        { sessionId: "s-review-2" },
      ],
      assessments: ["unverifiable", false],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({ state: "succeeded", fixCycles: 0 });
    expect(h.requests.map((r) => r.stage)).toEqual(["review", "review"]);
    expect(h.requests.filter((r) => r.stage === "review").map((r) => r.attempt))
      .toEqual([1, 2]);
  });

  /**
   * The channel is down, so the reviewer's prose report is the only evidence
   * — and Arij parsed it itself, independent of MCP. Those findings are real
   * and anchored; re-reviewing instead of fixing discards them, and every
   * fresh review window re-ingests the same report, leaving duplicate open
   * rows that nothing ever addresses.
   */
  it("fixes an unverifiable review that recovered findings from its prose", async () => {
    const h = runScripted({
      stages: [
        { sessionId: "s-review-1" },
        { sessionId: "s-fix-1" },
        { sessionId: "s-review-2" },
      ],
      assessments: ["unverifiable-with-findings", false],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({ state: "succeeded", fixCycles: 1 });
    expect(h.requests.map((r) => r.stage)).toEqual(["review", "fix", "review"]);
  });

  it("fails an unverifiable review that never delivers, without a fix cycle", async () => {
    const h = runScripted({
      maxAttempts: 2,
      stages: [{ sessionId: "s-review-1" }, { sessionId: "s-review-2" }],
      assessments: ["unverifiable", "unverifiable"],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("failed");
    // The reason must not blame findings that were never filed.
    expect(summary.reason).not.toMatch(/blocking findings remain/);
    expect(summary.fixCycles).toBe(0);
    expect(h.requests.some((r) => r.stage === "fix")).toBe(false);
  });
});

describe("runPipeline — dispatch guards", () => {
  it("session cap fails the run before dispatching", async () => {
    // Cap 2: build + review fill it; the fix dispatch must trip the cap.
    const h = runScripted({ maxSessions: 2, assessments: [true] });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "session cap reached",
    });
    expect(h.reasons()).toContain(PIPELINE_REASONS.failedSessionCap);
    expect(h.requests.map((r) => r.stage)).toEqual(["review"]);
  });

  it("a target conflict not created by this run fails the run (no retry)", async () => {
    const h = runScripted({
      guards: [{ conflictSessionId: "s-intruder", reviewTargetStatus: "review" }],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "target busy: another agent took the ticket",
    });
    expect(h.traces).toContainEqual({
      reason: PIPELINE_REASONS.failedTargetBusy,
      sessionId: "s-intruder",
    });
    expect(h.requests).toHaveLength(0);
    // The guard saw the run's own sessions.
    expect(h.guardCalls[0]).toEqual(["s-build"]);
  });

  it("review guard: ticket no longer in review|done fails the run", async () => {
    const h = runScripted({
      guards: [{ conflictSessionId: null, reviewTargetStatus: "backlog" }],
    });
    const summary = await h.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "ticket left review before the review stage",
    });
    expect(h.reasons()).toContain(PIPELINE_REASONS.failedTicketNotInReview);
  });

  it("review guard accepts 'done' (mirror of the review routes)", async () => {
    const h = runScripted({
      guards: [{ conflictSessionId: null, reviewTargetStatus: "done" }],
      assessments: [false],
    });
    const summary = await h.promise;
    expect(summary.state).toBe("succeeded");
  });

  it("the fix stage has no review-status requirement", async () => {
    const h = runScripted({
      assessments: [true, false],
      guards: [
        OPEN_GUARD,
        // Fix dispatch happens while the closure reverted the ticket.
        { conflictSessionId: null, reviewTargetStatus: "in_progress" },
        OPEN_GUARD,
      ],
    });
    const summary = await h.promise;
    expect(summary.state).toBe("succeeded");
  });
});
