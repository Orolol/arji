/**
 * Runner wiring for the mechanical regression verify gate
 * (lib/pipeline/runner.ts + lib/pipeline/verify.ts contract):
 *
 *  - no gate / gate not applicable → review dispatch happens unchanged;
 *  - gate failed with fix-cycle budget left → fix dispatched with the exact
 *    failure payload, fixCycles incremented;
 *  - gate failed with budget exhausted → terminal failure, no review;
 *  - gate passed → review proceeds;
 *  - gate crash → run fails ("regression gate crashed").
 */
import { describe, it, expect } from "vitest";

import type { RegressionCheckResult } from "@/lib/verify/regression-check";
import { runPipeline } from "@/lib/pipeline/runner";
import { PIPELINE_REASONS } from "@/lib/pipeline/constants";
import type {
  PipelineGuardCheck,
  PipelineStageRequest,
  PipelineStageResult,
} from "@/lib/pipeline/runner";
import type { RegressionReportPayload } from "@/lib/verify/regression-report";

const OPEN_GUARD: PipelineGuardCheck = {
  conflictSessionId: null,
  reviewTargetStatus: "review",
};

function failingCheck(): RegressionCheckResult {
  return {
    status: "failed",
    reason: "test_passes_on_base",
    testFiles: ["src/bug.test.js"],
    detail: null,
  };
}

/** What the runner should persist for that failing check (fresh timestamp). */
function expectedPayloadFor(check: RegressionCheckResult): RegressionReportPayload {
  return {
    regression: {
      status: check.status,
      reason: check.reason,
      testFiles: check.testFiles,
      detail: check.detail,
      checkedAt: expect.any(String) as unknown as string,
    },
  };
}

interface GateHarnessConfig {
  /** Gate outcomes per invocation; last one repeats. Default: not-ran. */
  gateOutcomes?: Array<{
    ran?: boolean;
    passed?: boolean | null;
    result?: RegressionCheckResult;
    throwOnCall?: boolean;
  }>;
  assessments?: boolean[];
  maxFixCycles?: number;
}

function runWithGate(config: GateHarnessConfig = {}) {
  const traces: string[] = [];
  const requests: PipelineStageRequest[] = [];
  let stageIndex = 0;
  let assessIndex = 0;
  let callCount = 0;
  const seenSessionIds: Array<string | null> = [];

  const buildSettled = Promise.resolve<PipelineStageResult>({
    sessionId: "s-build",
    success: true,
    outcome: "answered",
    error: null,
  });

  const promise = runPipeline({
    maxAttempts: 2,
    maxFixCycles: config.maxFixCycles ?? 1,
    maxSessions: 12,
    initialBuild: { sessionId: "s-build", settled: buildSettled },
    launchStage: async (request) => {
      requests.push(request);
      const sessionId = `s-${request.stage}-${++stageIndex}`;
      return {
        sessionId,
        settled: Promise.resolve<PipelineStageResult>({
          sessionId,
          success: true,
          outcome: "answered",
          error: null,
        }),
        escalatedToProvider: null,
      };
    },
    assessReview: async () => {
      const blocking = config.assessments?.[assessIndex++] ?? false;
      return {
        blocking,
        blockingCount: blocking ? 1 : 0,
        agentCommentCount: 1,
        usedProseFallback: false,
      };
    },
    readSessionStatus: () => null,
    checkGuards: () => OPEN_GUARD,
    runForensic: async () => ({
      sessionId: "s-forensic",
      settled: Promise.resolve<PipelineStageResult>({
        sessionId: "s-forensic",
        success: true,
        outcome: "answered",
        error: null,
      }),
    }),
    runVerifyGate: async (lastCodeSessionId) => {
      seenSessionIds.push(lastCodeSessionId);
      const script =
        config.gateOutcomes?.[Math.min(callCount++, config.gateOutcomes.length - 1)] ??
        {};
      if (script.throwOnCall) throw new Error("gate exploded");
      return {
        ran: script.ran ?? false,
        passed: script.passed ?? null,
        result: script.result ?? null,
      };
    },
    cancelPollIntervalMs: 5,
    callbacks: { onTrace: (reason) => traces.push(reason) },
  });

  return { promise, traces, requests, seenSessionIds };
}

describe("runPipeline — regression verify gate", () => {
  it("dispatches review unchanged when the gate does not apply (default OFF)", async () => {
    const h = runWithGate();
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(h.requests.map((r) => r.stage)).toEqual(["review"]);
  });

  it("enters a fix cycle with the exact failure payload when the gate is red", async () => {
    const h = runWithGate({
      gateOutcomes: [
        { ran: true, passed: false, result: failingCheck() },
        { ran: false },
      ],
      assessments: [false],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(h.requests.map((r) => r.stage)).toEqual(["fix", "review"]);
    expect(h.requests[0].verifyFailure).toEqual(
      expectedPayloadFor(failingCheck())
    );
    expect(h.requests[0].fixCycle).toBe(1);
    expect(h.traces).toContain(PIPELINE_REASONS.regressionFailed(1, 1));
    // The gate verified the code session's worktree.
    expect(h.seenSessionIds[0]).toBe("s-build");
    // The post-fix code stage is verified again before review.
    expect(h.seenSessionIds[1]).toBe("s-fix-1");
  });

  it("fails the run without review when the gate is red and no fix cycles remain", async () => {
    const h = runWithGate({
      maxFixCycles: 0,
      gateOutcomes: [{ ran: true, passed: false, result: failingCheck() }],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("failed");
    expect(summary.reason).toContain("regression test still failing");
    expect(h.requests).toEqual([]);
    expect(h.traces).toContain(PIPELINE_REASONS.failedRegression(0));
  });

  it("proceeds to review when the gate passes", async () => {
    const h = runWithGate({
      gateOutcomes: [
        {
          ran: true,
          passed: true,
          result: {
            status: "passed",
            reason: null,
            testFiles: ["src/bug.test.js"],
            detail: null,
          },
        },
      ],
      assessments: [false],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("succeeded");
    expect(h.requests.map((r) => r.stage)).toEqual(["review"]);
  });

  it("fails the run when the gate itself crashes", async () => {
    const h = runWithGate({
      gateOutcomes: [{ throwOnCall: true }],
    });
    const summary = await h.promise;

    expect(summary.state).toBe("failed");
    expect(summary.reason).toBe("regression gate crashed");
    expect(h.requests).toEqual([]);
  });
});
