/**
 * Pipeline wiring for Arij-owned deterministic verification:
 *
 *   successful code stage -> configured verification -> review
 *   failed verification -> existing fix-cycle budget -> verification -> review
 *   no configured commands -> the historical pipeline request/trace contract
 *
 * Verification reports are not agent sessions. The maxSessions=2 happy path
 * below only has room for the initial build and review and must still pass.
 */
import { describe, expect, it, vi } from "vitest";

import { PIPELINE_REASONS } from "@/lib/pipeline/constants";
import {
  runPipeline,
  type PipelineGuardCheck,
  type PipelineStageRequest,
  type PipelineStageResult,
} from "@/lib/pipeline/runner";
import type { VerificationResult } from "@/lib/verify/runner";

const OPEN_GUARD: PipelineGuardCheck = {
  conflictSessionId: null,
  reviewTargetStatus: "review",
};

function report(
  status: "pass" | "fail",
  suffix: string
): VerificationResult {
  return {
    id: `verify-${suffix}`,
    projectId: "project-1",
    epicId: "epic-1",
    agentSessionId: `code-${suffix}`,
    status,
    startedAt: "2026-08-25T10:00:00.000Z",
    finishedAt: "2026-08-25T10:00:01.000Z",
    commands: [
      {
        name: "test",
        command: "npm test",
        exitCode: status === "pass" ? 0 : 1,
        durationMs: 1_234,
        tail:
          status === "pass"
            ? "Tests passed"
            : "AssertionError: expected true to be false\nlast failure line",
      },
    ],
  };
}

interface HarnessOptions {
  verification?: Array<{
    ran: boolean;
    result: VerificationResult | null;
    skipReason?: string;
  }>;
  maxSessions?: number;
  /** Simulate the driver crashing instead of returning an outcome. */
  verificationThrows?: boolean;
}

function runHarness(options: HarnessOptions = {}) {
  const requests: PipelineStageRequest[] = [];
  const traces: string[] = [];
  const verificationSessionIds: Array<string | null> = [];
  let stageNumber = 0;
  let verificationNumber = 0;
  const park = vi.fn();

  const promise = runPipeline({
    maxAttempts: 2,
    maxFixCycles: 1,
    maxSessions: options.maxSessions ?? 12,
    parkRejectedTicket: park,
    initialBuild: {
      sessionId: "s-build",
      settled: Promise.resolve<PipelineStageResult>({
        sessionId: "s-build",
        success: true,
        outcome: "answered",
        error: null,
      }),
    },
    launchStage: async (request) => {
      requests.push(request);
      const sessionId = `s-${request.stage}-${++stageNumber}`;
      return {
        sessionId,
        settled: Promise.resolve<PipelineStageResult>({
          sessionId,
          success: true,
          outcome: "answered",
          error: null,
        }),
      };
    },
    assessReview: async () => ({
      blocking: false,
      blockingCount: 0,
      agentCommentCount: 1,
      usedProseFallback: false,
    }),
    readSessionStatus: () => "completed",
    checkGuards: () => OPEN_GUARD,
    runForensic: async () => ({
      sessionId: null,
      settled: Promise.resolve({
        sessionId: "",
        success: true,
        outcome: "answered",
        error: null,
      }),
    }),
    ...(options.verification || options.verificationThrows
      ? {
          runDeterministicVerification: async (
            lastCodeSessionId: string | null
          ) => {
            verificationSessionIds.push(lastCodeSessionId);
            if (options.verificationThrows) {
              throw new Error("verify driver exploded");
            }
            const index = Math.min(
              verificationNumber++,
              options.verification!.length - 1
            );
            return options.verification![index];
          },
        }
      : {}),
    callbacks: { onTrace: (reason) => traces.push(reason) },
  });

  return { promise, requests, traces, verificationSessionIds, park };
}

describe("runPipeline — deterministic verification stage", () => {
  it("keeps the disabled path observably identical to the historical pipeline", async () => {
    const historical = runHarness();
    const disabled = runHarness({
      verification: [{ ran: false, result: null }],
    });

    const [historicalSummary, disabledSummary] = await Promise.all([
      historical.promise,
      disabled.promise,
    ]);

    expect(disabledSummary).toEqual(historicalSummary);
    expect(disabled.requests).toEqual(historical.requests);
    expect(disabled.traces).toEqual(historical.traces);
    expect(disabled.verificationSessionIds).toEqual(["s-build"]);
  });

  it("spends one existing fix cycle and carries the failing output tail into the fix request", async () => {
    const failed = report("fail", "build");
    const passed = report("pass", "fix");
    const harness = runHarness({
      verification: [
        { ran: true, result: failed },
        { ran: true, result: passed },
      ],
    });

    const summary = await harness.promise;

    expect(summary).toMatchObject({ state: "succeeded", fixCycles: 1 });
    expect(harness.requests.map((request) => request.stage)).toEqual([
      "fix",
      "review",
    ]);
    expect(harness.requests[0]).toMatchObject({
      fixCycle: 1,
      verificationFailure: failed.commands[0],
    });
    expect(harness.requests[1]).toMatchObject({
      verificationReport: passed,
    });
    expect(harness.verificationSessionIds).toEqual(["s-build", "s-fix-1"]);
    expect(harness.traces).toContain(
      PIPELINE_REASONS.deterministicVerificationFailed("test")
    );
    expect(harness.traces).toContain(
      PIPELINE_REASONS.deterministicVerificationPassed(1)
    );
  });

  it("passes a successful one-line-per-command report to review without consuming a session", async () => {
    const passed = report("pass", "build");
    const harness = runHarness({
      verification: [{ ran: true, result: passed }],
      // Exactly enough room for build + review. A verify session would make
      // the review dispatch hit the hard cap and fail this run.
      maxSessions: 2,
    });

    const summary = await harness.promise;

    expect(summary).toMatchObject({
      state: "succeeded",
      sessionIds: ["s-build", "s-review-1"],
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      stage: "review",
      verificationReport: passed,
    });
    expect(harness.traces).toContain(
      PIPELINE_REASONS.deterministicVerificationPassed(1)
    );
  });

  it("parks the ticket and fails the run when verification exhausts the fix budget", async () => {
    const failedBuild = report("fail", "build");
    const failedFix = report("fail", "fix");
    const harness = runHarness({
      verification: [
        { ran: true, result: failedBuild },
        { ran: true, result: failedFix },
      ],
    });

    const summary = await harness.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: expect.stringMatching(/deterministic verification/i),
    });
    // One fix cycle was spent before exhaustion (maxFixCycles: 1).
    expect(harness.requests.map((request) => request.stage)).toEqual(["fix"]);
    expect(harness.verificationSessionIds).toEqual(["s-build", "s-fix-1"]);
    expect(harness.park).toHaveBeenCalledWith(
      "s-fix-1",
      "Deterministic verification rejected the branch"
    );
    expect(harness.traces).toContain(
      PIPELINE_REASONS.failedDeterministicVerification(1)
    );
  });

  it("parks the ticket and fails the run when the verification driver crashes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = runHarness({ verificationThrows: true });

    const summary = await harness.promise;

    expect(summary).toMatchObject({
      state: "failed",
      reason: "deterministic verification crashed",
    });
    expect(harness.park).toHaveBeenCalledWith(
      "s-build",
      "Deterministic verification crashed before it could verify the branch"
    );
    expect(harness.traces).toContain(
      PIPELINE_REASONS.failedDeterministicVerificationCrashed
    );
    // No review was dispatched after the crash.
    expect(harness.requests).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[pipeline] Deterministic verification crashed:",
      "verify driver exploded"
    );
  });

  it("traces a visible reason when configured checks are skipped", async () => {
    const harness = runHarness({
      verification: [
        { ran: false, result: null, skipReason: "no epic worktree recorded" },
      ],
    });

    const summary = await harness.promise;

    // A skip must be observable in the activity feed — it must not read as
    // "the configured checks passed".
    expect(summary.state).toBe("succeeded");
    expect(harness.traces).toContain(
      PIPELINE_REASONS.deterministicVerificationSkipped(
        "no epic worktree recorded"
      )
    );
  });
});
