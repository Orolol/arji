/**
 * Tests for startPipelineRun (lib/pipeline/index.ts): the glue between the
 * pure runner and the world — registry snapshots (active → recent ring),
 * the actor-'system' from==to activity trace with the exact D8 reason
 * strings, settings-resolved caps, and the forensic hand-off. Stage
 * dispatch is faked at the driver boundary; registry, runner, trace, and
 * settings resolution are real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  PipelineDeterministicVerificationOutcome,
  PipelineStageResult,
} from "@/lib/pipeline/runner";

const driverMocks = vi.hoisted(() => ({
  launchStage: vi.fn(),
  assessReview: vi.fn(),
  assessGrading: vi.fn(),
  readSessionStatus: vi.fn(() => "completed" as string | null),
  checkGuards: vi.fn(() => ({
    conflictSessionId: null as string | null,
    reviewTargetStatus: "review" as string | null,
  })),
  runDeterministicVerification: vi.fn(
    async (): Promise<PipelineDeterministicVerificationOutcome> => ({
      ran: false,
      result: null,
    })
  ),
  runForensic: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/pipeline/stages", () => ({
  createPipelineStageDriver: vi.fn(() => ({
    launchStage: driverMocks.launchStage,
    assessReview: driverMocks.assessReview,
    assessGrading: driverMocks.assessGrading,
    readSessionStatus: driverMocks.readSessionStatus,
    checkGuards: driverMocks.checkGuards,
    runDeterministicVerification: driverMocks.runDeterministicVerification,
  })),
}));

vi.mock("@/lib/pipeline/forensic", () => ({
  runForensic: driverMocks.runForensic,
}));

const { db } = await import("@/lib/db");
const { projects, epics, settings, ticketActivityLog } = await import(
  "@/lib/db/schema"
);
const {
  startPipelineRun,
  resolvePipelineEnabled,
  resolvePipelineGraderEnabled,
  pipelineRegistry,
} = await import("@/lib/pipeline");
const {
  PIPELINE_REASONS,
  pipelineEnabledSettingKey,
  pipelineGraderEnabledSettingKey,
} = await import(
  "@/lib/pipeline/constants"
);
const { pipelineMaxAttemptsSettingKey } = await import(
  "@/lib/pipeline/constants"
);
let counter = 0;

async function flushBackground() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

function seed() {
  counter += 1;
  const projectId = `proj-run-${counter}`;
  const epicId = `epic-run-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Run project", gitRepoPath: "/repos/r" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Run epic",
      status: "in_progress",
      position: 0,
    })
    .run();
  return { projectId, epicId };
}

function stageHandle(
  sessionId: string,
  result: Partial<PipelineStageResult> = {}
) {
  return {
    sessionId,
    settled: Promise.resolve({
      sessionId,
      success: true,
      outcome: "answered",
      error: null,
      ...result,
    }),
    escalatedToProvider: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  driverMocks.readSessionStatus.mockReturnValue("completed");
  driverMocks.checkGuards.mockReturnValue({
    conflictSessionId: null,
    reviewTargetStatus: "review",
  });
  driverMocks.runDeterministicVerification.mockResolvedValue({
    ran: false,
    result: null,
  });
});

describe("startPipelineRun", () => {
  it("runs build → review → succeeded, updating the registry and writing the trace", async () => {
    const { projectId, epicId } = seed();
    driverMocks.launchStage.mockResolvedValueOnce(stageHandle("s-review"));
    driverMocks.assessReview.mockResolvedValueOnce({
      blocking: false,
      blockingCount: 0,
      agentCommentCount: 1,
      usedProseFallback: false,
    });

    const { runId } = startPipelineRun({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildSessionId: "s-build",
      buildProvider: "claude-code",
      buildNamedAgentId: null,
      buildSettled: Promise.resolve({
        sessionId: "s-build",
        success: true,
        outcome: "answered",
        error: null,
      }),
    });

    // Synchronous return: the run is already registered and active.
    expect(pipelineRegistry.get(runId)).toMatchObject({
      state: "running_build",
      stage: "build",
      sessionIds: ["s-build"],
      endedAt: null,
    });

    await flushBackground();

    const snapshot = pipelineRegistry.get(runId)!;
    expect(snapshot).toMatchObject({
      state: "succeeded",
      reason: null,
      sessionIds: ["s-build", "s-review"],
    });
    expect(snapshot.endedAt).toBeTruthy();
    // Terminal runs live in the recent ring, still listed for the project.
    expect(
      pipelineRegistry.listByProject(projectId).map((r) => r.runId)
    ).toContain(runId);

    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    const reasons = activity.map((a) => a.reason);
    expect(reasons).toEqual([
      PIPELINE_REASONS.started,
      PIPELINE_REASONS.reviewStarted,
      PIPELINE_REASONS.finished,
    ]);
    // Every trace entry: actor system, from == to (nothing moved by tracing).
    for (const entry of activity) {
      expect(entry.actor).toBe("system");
      expect(entry.fromStatus).toBe(entry.toStatus);
      expect(entry.projectId).toBe(projectId);
    }
    // The stage session ids anchor the trace lines.
    expect(activity[0].sessionId).toBe("s-build");
    expect(activity[1].sessionId).toBe("s-review");
  });

  it("persists every deterministic verification trace as system activity", async () => {
    const { projectId, epicId } = seed();
    driverMocks.runDeterministicVerification.mockResolvedValueOnce({
      ran: true,
      result: {
        id: "verify-system-activity",
        projectId,
        epicId,
        agentSessionId: "s-build",
        persisted: true,
        status: "pass",
        startedAt: "2026-08-25T10:00:00.000Z",
        finishedAt: "2026-08-25T10:00:01.000Z",
        commands: [
          {
            name: "test",
            command: "npm test",
            exitCode: 0,
            durationMs: 1_000,
            tail: "ok",
          },
        ],
      },
    });
    driverMocks.launchStage.mockResolvedValueOnce(stageHandle("s-review"));
    driverMocks.assessReview.mockResolvedValueOnce({
      blocking: false,
      blockingCount: 0,
      agentCommentCount: 1,
      usedProseFallback: false,
    });

    startPipelineRun({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildSessionId: "s-build",
      buildProvider: "claude-code",
      buildNamedAgentId: null,
      buildSettled: Promise.resolve({
        sessionId: "s-build",
        success: true,
        outcome: "answered",
        error: null,
      }),
    });
    await flushBackground();

    const verifyActivity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .find(
        (entry) =>
          entry.reason === PIPELINE_REASONS.deterministicVerificationPassed(1)
      );
    expect(verifyActivity).toMatchObject({
      actor: "system",
      fromStatus: "in_progress",
      toStatus: "in_progress",
      sessionId: "s-build",
    });
  });

  it("honours the per-project attempts override and hands the dead session to forensic", async () => {
    const { projectId, epicId } = seed();
    // Project override: a single attempt per stage.
    db.insert(settings)
      .values({ key: pipelineMaxAttemptsSettingKey(projectId), value: "1" })
      .run();
    driverMocks.readSessionStatus.mockReturnValue("failed");
    driverMocks.runForensic.mockResolvedValueOnce({
      sessionId: "s-forensic",
      settled: Promise.resolve({
        sessionId: "s-forensic",
        success: true,
        outcome: "answered",
        error: null,
      }),
    });

    const { runId } = startPipelineRun({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildSessionId: "s-build",
      buildProvider: "claude-code",
      buildNamedAgentId: null,
      buildSettled: Promise.resolve({
        sessionId: "s-build",
        success: false,
        outcome: "error",
        error: "spawn failed",
      }),
    });

    await flushBackground();

    // No retry (cap 1): the launcher was never asked for a second build.
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
    expect(driverMocks.runForensic).toHaveBeenCalledWith({
      projectId,
      epicId,
      userStoryId: null,
      deadSessionId: "s-build",
      stage: "build",
      attempts: 1,
      batchRunId: null,
    });

    expect(pipelineRegistry.get(runId)).toMatchObject({
      state: "failed",
      reason: "stage build failed after 1 attempts",
      sessionIds: ["s-build", "s-forensic"],
    });

    const reasons = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .map((a) => a.reason);
    expect(reasons).toContain(PIPELINE_REASONS.failedStage("build", 1));
  });

  it("pauses terminally when the build asks a question", async () => {
    const { projectId, epicId } = seed();
    const { runId } = startPipelineRun({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildSessionId: "s-build",
      buildProvider: "claude-code",
      buildNamedAgentId: null,
      buildSettled: Promise.resolve({
        sessionId: "s-build",
        success: true,
        outcome: "asked_question",
        error: null,
      }),
    });

    await flushBackground();

    expect(pipelineRegistry.get(runId)).toMatchObject({
      state: "paused_question",
      reason: "agent asked a question (build)",
    });
    const reasons = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all()
      .map((a) => a.reason);
    expect(reasons).toContain(PIPELINE_REASONS.pausedQuestion("build"));
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
  });
});

describe("resolvePipelineEnabled", () => {
  it("defaults OFF, honours the global key, and lets the project key win", () => {
    const { projectId } = seed();
    expect(resolvePipelineEnabled(projectId)).toBe(false);

    db.insert(settings)
      .values({ key: "pipeline_enabled", value: "true" })
      .run();
    expect(resolvePipelineEnabled(projectId)).toBe(true);

    db.insert(settings)
      .values({ key: pipelineEnabledSettingKey(projectId), value: "false" })
      .run();
    expect(resolvePipelineEnabled(projectId)).toBe(false);
  });

  it("keeps grading OFF unless globally or per-project enabled", () => {
    const { projectId } = seed();
    expect(resolvePipelineGraderEnabled(projectId)).toBe(false);

    db.insert(settings)
      .values({ key: "pipeline_grader_enabled", value: "true" })
      .run();
    expect(resolvePipelineGraderEnabled(projectId)).toBe(true);

    db.insert(settings)
      .values({
        key: pipelineGraderEnabledSettingKey(projectId),
        value: "false",
      })
      .run();
    expect(resolvePipelineGraderEnabled(projectId)).toBe(false);
  });
});
