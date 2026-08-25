/** Pipeline contract for the opt-in acceptance grader. */
import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/pipeline/runner";
import type {
  PipelineGradingAssessment,
  PipelineStageRequest,
  PipelineStageResult,
} from "@/lib/pipeline/runner";

const met: PipelineGradingAssessment = {
  reportId: "report-met",
  summary: "All criteria met.",
  gradings: [
    {
      storyId: "story-1",
      criterion: "The result is visible",
      status: "met",
      evidence: "The focused component test passed.",
    },
  ],
  missed: [],
};

const missed: PipelineGradingAssessment = {
  reportId: "report-missed",
  summary: "One gap remains.",
  gradings: [
    {
      storyId: "story-1",
      criterion: "The result is visible",
      status: "missed",
      evidence: "No badge is rendered by EpicCard.",
    },
  ],
  missed: [
    {
      storyId: "story-1",
      criterion: "The result is visible",
      status: "missed",
      evidence: "No badge is rendered by EpicCard.",
    },
  ],
};

function harness(options: {
  enabled?: boolean;
  assessments?: PipelineGradingAssessment[];
  gradingSkipped?: boolean;
}) {
  const events: string[] = [];
  const requests: PipelineStageRequest[] = [];
  let gradingIndex = 0;
  let stageIndex = 0;

  const promise = runPipeline({
    maxAttempts: 2,
    maxFixCycles: 2,
    maxSessions: 12,
    gradingEnabled: options.enabled,
    initialBuild: {
      sessionId: "build-1",
      settled: Promise.resolve({
        sessionId: "build-1",
        success: true,
        outcome: "answered",
        error: null,
      }),
    },
    runVerifyGate: async () => {
      events.push("verify");
      return { ran: false, passed: null, result: null };
    },
    launchStage: async (request) => {
      requests.push(request);
      events.push(request.stage);
      const sessionId = `${request.stage}-${++stageIndex}`;
      const result: PipelineStageResult = {
        sessionId,
        success: true,
        outcome: "answered",
        error: null,
        ...(request.stage === "grading"
          ? options.gradingSkipped
            ? { gradingSkipped: true, gradingReportId: null }
            : { gradingSkipped: false, gradingReportId: `report-${stageIndex}` }
          : {}),
      };
      return { sessionId: options.gradingSkipped && request.stage === "grading" ? null : sessionId, settled: Promise.resolve(result) };
    },
    assessGrading: async () =>
      options.assessments?.[
        Math.min(gradingIndex++, options.assessments.length - 1)
      ] ?? met,
    assessReview: async () => ({
      blocking: false,
      blockingCount: 0,
      agentCommentCount: 0,
      usedProseFallback: false,
    }),
    readSessionStatus: () => null,
    checkGuards: () => ({
      conflictSessionId: null,
      reviewTargetStatus: "review",
    }),
    runForensic: async () => ({
      sessionId: null,
      settled: Promise.resolve({
        sessionId: "",
        success: true,
        outcome: "answered",
        error: null,
      }),
    }),
    cancelPollIntervalMs: 5,
  });

  return { promise, events, requests };
}

describe("runPipeline — acceptance grading", () => {
  it("keeps the historical verify → review flow when the setting is OFF", async () => {
    const run = harness({ enabled: false });
    await expect(run.promise).resolves.toMatchObject({ state: "succeeded" });
    expect(run.events).toEqual(["verify", "review"]);
  });

  it("runs verify → grading → review when every criterion is met", async () => {
    const run = harness({ enabled: true, assessments: [met] });
    await expect(run.promise).resolves.toMatchObject({ state: "succeeded" });
    expect(run.events).toEqual(["verify", "grading", "review"]);
  });

  it("turns missed criteria into a fix carrying criterion and evidence", async () => {
    const run = harness({ enabled: true, assessments: [missed, met] });
    const summary = await run.promise;

    expect(summary).toMatchObject({ state: "succeeded", fixCycles: 1 });
    expect(run.events).toEqual([
      "verify",
      "grading",
      "fix",
      "verify",
      "grading",
      "review",
    ]);
    const fix = run.requests.find((request) => request.stage === "fix");
    expect(fix?.gradingFailure).toEqual({
      reportId: "report-missed",
      summary: "One gap remains.",
      missed: missed.missed,
    });
  });

  it("treats a rubric-free grading dispatch as a successful skip", async () => {
    const run = harness({ enabled: true, gradingSkipped: true });
    await expect(run.promise).resolves.toMatchObject({ state: "succeeded" });
    expect(run.events).toEqual(["verify", "grading", "review"]);
  });
});
