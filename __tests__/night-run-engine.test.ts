/**
 * Tests for the night-run engine (lib/night/run.ts): the pipeline-as-wave
 * composition adapter (per-epic pipelines drive wave settlement through the
 * C3 terminal mapping), circuit-breaker and cost-cap aborts through the wave
 * engine's shouldAbortRun hook, dual-registry bookkeeping, skip logging, and
 * the single terminal choke point (exactly one summary notification + one
 * webhook).
 *
 * startPipelineRun is mocked at the module boundary (the real pipeline is
 * covered by its own suites); the wave engine, both registries, the
 * notification creators, and the settings/cost queries are real against the
 * migrated in-memory schema.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

interface CapturedPipeline {
  input: Record<string, unknown>;
  onTerminal: (summary: {
    state: "succeeded" | "failed" | "paused_question" | "cancelled";
    reason: string | null;
    sessionIds: string[];
    fixCycles: number;
  }) => void;
}

const pipelineMocks = vi.hoisted(() => ({
  /** epicId → captured startPipelineRun input (incl. onTerminal). */
  byEpic: new Map<string, CapturedPipeline>(),
  startPipelineRun: vi.fn(),
}));

const webhookMock = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/pipeline", () => ({
  startPipelineRun: pipelineMocks.startPipelineRun,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("@/lib/webhooks/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/send")>();
  return { ...actual, sendProjectWebhook: webhookMock.send };
});

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, notifications, settings, ticketActivityLog } =
  await import("@/lib/db/schema");
const {
  startNightRun,
  mapPipelineTerminalToWaveTicket,
  NightCircuitBreaker,
  resolveNightCircuitBreaker,
  resolveNightCostCap,
} = await import("@/lib/night/run");
const { nightRunRegistry } = await import("@/lib/night/registry");
const { dagBatchRegistry } = await import("@/lib/agents/dag-batch-registry");
const {
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
  NIGHT_STOPPED_ABORT_REASON,
  nightCircuitBreakerSettingKey,
  nightCostCapSettingKey,
} = await import("@/lib/night/constants");
const { nightRunAbortKind } = await import(
  "@/components/night/night-run-format"
);
import type {
  BatchExecutionPlan,
  TicketExecutionStatus,
} from "@/lib/dependencies/scheduler";
import type { WaveLaunchHandle } from "@/lib/dependencies/wave-runner";

let counter = 0;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makePlan(layers: string[][]): BatchExecutionPlan {
  const ticketStatus = new Map<string, TicketExecutionStatus>();
  for (const layer of layers) {
    for (const id of layer) ticketStatus.set(id, "pending");
  }
  return { layers, ticketStatus, failureReasons: new Map() };
}

function graphOf(edges: Array<[string, string]>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [ticket, dependsOn] of edges) {
    if (!graph.has(ticket)) graph.set(ticket, new Set());
    graph.get(ticket)!.add(dependsOn);
  }
  return graph;
}

/** Seeds a project + one epic row per plan ticket (skip logging needs them). */
function seedProject(epicIds: string[]): string {
  counter += 1;
  const projectId = `proj-night-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: `Night ${counter}`, gitRepoPath: "/r" })
    .run();
  for (const [index, epicId] of epicIds.entries()) {
    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: `Epic ${epicId}`,
        status: "todo",
        position: index,
        readableId: `E-n${counter}-${index}`,
      })
      .run();
  }
  return projectId;
}

/** Immediate build launcher: session `s-<epicId>`, build settles success. */
function instantLaunchBuild(launched: string[]) {
  return async (epicId: string): Promise<WaveLaunchHandle> => {
    launched.push(epicId);
    return {
      sessionId: `s-${epicId}`,
      settled: Promise.resolve({
        epicId,
        sessionId: `s-${epicId}`,
        success: true,
        outcome: "answered",
        error: null,
      }),
    };
  };
}

function finishPipeline(
  epicId: string,
  state: "succeeded" | "failed" | "paused_question" | "cancelled",
  reason: string | null = null
) {
  const captured = pipelineMocks.byEpic.get(epicId);
  expect(captured, `no pipeline started for ${epicId}`).toBeTruthy();
  captured!.onTerminal({
    state,
    reason,
    sessionIds: [`s-${epicId}`],
    fixCycles: 0,
  });
}

function nightNotifications(projectId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.projectId, projectId))
    .all()
    .filter((n) => n.title?.startsWith("Night run finished"));
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineMocks.byEpic.clear();
  pipelineMocks.startPipelineRun.mockImplementation(
    (input: Record<string, unknown>) => {
      const epicId = input.epicId as string;
      pipelineMocks.byEpic.set(epicId, {
        input,
        onTerminal: input.onTerminal as CapturedPipeline["onTerminal"],
      });
      return { runId: `plr-${epicId}` };
    }
  );
  // Fresh tables per test so the short epic ids ("a", "b") never collide
  // (children before parents for the foreign keys).
  db.delete(ticketActivityLog).run();
  db.delete(notifications).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.delete(settings).run();
});

describe("mapPipelineTerminalToWaveTicket", () => {
  const summary = (state: "succeeded" | "failed" | "paused_question" | "cancelled", reason: string | null = null) => ({
    state,
    reason,
    sessionIds: [],
    fixCycles: 0,
  });

  it("maps the four terminal states per the night contract", () => {
    expect(mapPipelineTerminalToWaveTicket("e", "s", summary("succeeded"))).toEqual({
      epicId: "e",
      sessionId: "s",
      success: true,
      outcome: "answered",
      error: null,
    });
    expect(
      mapPipelineTerminalToWaveTicket("e", "s", summary("paused_question"))
    ).toEqual({
      epicId: "e",
      sessionId: "s",
      success: true,
      outcome: "asked_question",
      error: null,
    });
    expect(
      mapPipelineTerminalToWaveTicket("e", "s", summary("failed", "stage build failed after 2 attempts"))
    ).toEqual({
      epicId: "e",
      sessionId: "s",
      success: false,
      outcome: "error",
      error: "stage build failed after 2 attempts",
    });
    expect(
      mapPipelineTerminalToWaveTicket("e", "s", summary("failed"))
    ).toMatchObject({ error: "pipeline failed" });
    expect(
      mapPipelineTerminalToWaveTicket("e", "s", summary("cancelled"))
    ).toEqual({
      epicId: "e",
      sessionId: "s",
      success: false,
      outcome: "error",
      error: "stopped by user",
    });
  });
});

describe("NightCircuitBreaker", () => {
  it("trips at the threshold of consecutive failures", () => {
    const breaker = new NightCircuitBreaker(3);
    breaker.observe("failed");
    breaker.observe("failed");
    expect(breaker.trippedReason()).toBeNull();
    breaker.observe("failed");
    expect(breaker.trippedReason()).toBe(
      "circuit breaker: 3 consecutive pipeline failures"
    );
  });

  it("success resets the streak (interleaved failures never trip)", () => {
    const breaker = new NightCircuitBreaker(2);
    breaker.observe("failed");
    breaker.observe("succeeded");
    breaker.observe("failed");
    breaker.observe("succeeded");
    breaker.observe("failed");
    expect(breaker.trippedReason()).toBeNull();
    expect(breaker.currentStreak).toBe(1);
  });

  it("paused_question and cancelled are neutral: no count, no reset", () => {
    const breaker = new NightCircuitBreaker(3);
    breaker.observe("failed");
    breaker.observe("paused_question");
    breaker.observe("failed");
    breaker.observe("cancelled");
    expect(breaker.trippedReason()).toBeNull();
    expect(breaker.currentStreak).toBe(2);
    breaker.observe("failed");
    expect(breaker.trippedReason()).toBe(
      "circuit breaker: 3 consecutive pipeline failures"
    );
  });

  it("threshold 0 disables the breaker entirely", () => {
    const breaker = new NightCircuitBreaker(0);
    for (let i = 0; i < 10; i++) breaker.observe("failed");
    expect(breaker.trippedReason()).toBeNull();
  });
});

describe("night setting resolution", () => {
  it("breaker: request override → project → global → default 3, clamped", () => {
    const projectId = seedProject([]);
    expect(resolveNightCircuitBreaker(projectId)).toBe(3);

    db.insert(settings)
      .values({ key: NIGHT_CIRCUIT_BREAKER_SETTING_KEY, value: "5" })
      .run();
    expect(resolveNightCircuitBreaker(projectId)).toBe(5);

    db.insert(settings)
      .values({ key: nightCircuitBreakerSettingKey(projectId), value: "0" })
      .run();
    expect(resolveNightCircuitBreaker(projectId)).toBe(0);

    expect(resolveNightCircuitBreaker(projectId, 7)).toBe(7);
    expect(resolveNightCircuitBreaker(projectId, 99)).toBe(10);
  });

  it("cost cap: request override → project → global → unlimited; junk is unlimited", () => {
    const projectId = seedProject([]);
    expect(resolveNightCostCap(projectId)).toBeNull();

    db.insert(settings)
      .values({ key: NIGHT_COST_CAP_SETTING_KEY, value: "20" })
      .run();
    expect(resolveNightCostCap(projectId)).toBe(20);

    db.insert(settings)
      .values({ key: nightCostCapSettingKey(projectId), value: "2.5" })
      .run();
    expect(resolveNightCostCap(projectId)).toBe(2.5);

    expect(resolveNightCostCap(projectId, 9)).toBe(9);
    expect(resolveNightCostCap(projectId, -1)).toBe(2.5);
  });
});

describe("startNightRun — composition", () => {
  it("runs waves at pipeline granularity and finishes with one notification + one webhook", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_hp_${counter}`;
    const plan = makePlan([["a"], ["b"]]);
    const launched: string[] = [];

    const { firstWaveLaunched, engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([["b", "a"]]),
      failurePolicy: "halt",
      namedAgentId: null,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    // Wave 1 launched and its pipeline started with the pinned input; the
    // wave does NOT settle at build terminal (the build already succeeded).
    expect(launched).toEqual(["a"]);
    const pipelineInput = pipelineMocks.byEpic.get("a")!.input;
    expect(pipelineInput).toMatchObject({
      projectId,
      scope: "epic",
      epicId: "a",
      userStoryId: null,
      buildSessionId: "s-a",
      buildProvider: "claude-code",
      buildNamedAgentId: null,
      batchRunId: runId,
    });
    await expect(pipelineInput.buildSettled).resolves.toEqual({
      sessionId: "s-a",
      success: true,
      outcome: "answered",
      error: null,
    });
    expect(await firstWaveLaunched).toEqual(["s-a"]);

    // Live bookkeeping in BOTH registries.
    expect(nightRunRegistry.get(runId)).toMatchObject({
      state: "running",
      currentWave: 1,
      totalWaves: 2,
    });
    const epicState = nightRunRegistry
      .get(runId)!
      .epics.find((e) => e.epicId === "a");
    expect(epicState).toMatchObject({
      status: "running",
      pipelineRunId: "plr-a",
    });
    expect(dagBatchRegistry.get(runId)).toMatchObject({ currentWave: 1 });

    // Pipeline terminal releases the wave; the dependent launches.
    finishPipeline("a", "succeeded");
    await flush();
    expect(launched).toEqual(["a", "b"]);
    finishPipeline("b", "succeeded");
    await flush();
    await engineDone;

    // Terminal choke point: ring snapshot, monitor cleanup, one of each send.
    expect(nightRunRegistry.get(runId)).toMatchObject({
      state: "finished",
      counts: { done: 2, failed: 0, skipped: 0, asked: 0 },
      abortReason: null,
    });
    expect(dagBatchRegistry.get(runId)).toBeNull();

    const summaryRows = nightNotifications(projectId);
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]).toMatchObject({
      title: "Night run finished: 2 to merge",
      status: "completed",
      sessionId: null,
      agentType: "build",
      targetUrl: `/projects/${projectId}?nightRun=${runId}`,
    });

    expect(webhookMock.send).toHaveBeenCalledTimes(1);
    expect(webhookMock.send).toHaveBeenCalledWith(projectId, {
      event: "night_run.completed",
      summary: "Night run finished: 2 to merge",
      durationMs: expect.any(Number),
      error: null,
      path: `/projects/${projectId}?nightRun=${runId}`,
    });
  });

  it("a paused pipeline blocks its dependents (asked bucket, skip logged)", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_paused_${counter}`;
    const plan = makePlan([["a"], ["b"]]);
    const launched: string[] = [];

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([["b", "a"]]),
      failurePolicy: "halt",
      namedAgentId: null,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    finishPipeline("a", "paused_question");
    await flush();
    await engineDone;

    expect(launched).toEqual(["a"]);
    expect(plan.ticketStatus.get("a")).toBe("asked");
    expect(plan.ticketStatus.get("b")).toBe("skipped");

    const skipLog = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, "b"))
      .all();
    expect(skipLog).toHaveLength(1);
    expect(skipLog[0].reason).toContain("asked a question");

    const summaryRows = nightNotifications(projectId);
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]).toMatchObject({
      title: "Night run finished: 1 paused, 1 skipped",
      status: "completed",
    });
  });

  it("a failed pipeline blocks dependents with its reason and fails the summary", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_failed_${counter}`;
    const plan = makePlan([["a"], ["b"]]);

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([["b", "a"]]),
      failurePolicy: "halt",
      namedAgentId: null,
      launchBuild: instantLaunchBuild([]),
    });

    await flush();
    finishPipeline("a", "failed", "stage build failed after 2 attempts");
    await flush();
    await engineDone;

    expect(plan.ticketStatus.get("a")).toBe("failed");
    expect(plan.failureReasons.get("a")).toBe(
      "stage build failed after 2 attempts"
    );
    expect(plan.ticketStatus.get("b")).toBe("skipped");

    const summaryRows = nightNotifications(projectId);
    expect(summaryRows[0]).toMatchObject({
      title: "Night run finished: 1 failed, 1 skipped",
      status: "failed",
    });
  });

  it("a cancelled pipeline blocks dependents as 'stopped by user'", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_cancel_${counter}`;
    const plan = makePlan([["a"], ["b"]]);

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([["b", "a"]]),
      failurePolicy: "halt",
      namedAgentId: null,
      launchBuild: instantLaunchBuild([]),
    });

    await flush();
    finishPipeline("a", "cancelled");
    await flush();
    await engineDone;

    expect(plan.ticketStatus.get("a")).toBe("failed");
    expect(plan.failureReasons.get("a")).toBe("stopped by user");
    expect(plan.ticketStatus.get("b")).toBe("skipped");
  });

  it("trips the circuit breaker after N consecutive failures and aborts pending waves", async () => {
    const projectId = seedProject(["a", "b", "c"]);
    const runId = `night_breaker_${counter}`;
    // c is INDEPENDENT of the wave-1 failures: under "halt" it would build
    // in wave 2 — only the breaker abort can stop it.
    const plan = makePlan([["a", "b"], ["c"]]);
    const launched: string[] = [];

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([]),
      failurePolicy: "halt",
      namedAgentId: null,
      breakerThreshold: 2,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    expect(launched).toEqual(["a", "b"]);
    finishPipeline("a", "failed", "stage build failed after 2 attempts");
    finishPipeline("b", "failed", "stage review failed after 2 attempts");
    await flush();
    await engineDone;

    // Wave 2 never launched; c is aborted with the breaker reason verbatim.
    expect(launched).toEqual(["a", "b"]);
    expect(plan.ticketStatus.get("c")).toBe("skipped");
    expect(plan.failureReasons.get("c")).toBe(
      "circuit breaker: 2 consecutive pipeline failures"
    );

    // The abort reason lands in the activity log and the ring snapshot.
    const skipLog = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, "c"))
      .all();
    expect(skipLog[0].reason).toBe(
      "circuit breaker: 2 consecutive pipeline failures"
    );
    expect(nightRunRegistry.get(runId)).toMatchObject({
      state: "finished",
      abortReason: "circuit breaker: 2 consecutive pipeline failures",
      abortedAtWave: 1,
    });

    const summaryRows = nightNotifications(projectId);
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0].title).toBe(
      "Night run finished: 2 failed, 1 skipped — circuit breaker tripped"
    );
    expect(summaryRows[0].status).toBe("failed");
  });

  it("a success between failures keeps the breaker quiet (interleaved)", async () => {
    const projectId = seedProject(["a", "b", "c", "d"]);
    const runId = `night_interleave_${counter}`;
    // Settlement order within the wave follows launch order: a, b, c.
    const plan = makePlan([["a", "b", "c"], ["d"]]);
    const launched: string[] = [];

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([["d", "b"]]),
      failurePolicy: "halt",
      namedAgentId: null,
      breakerThreshold: 2,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    finishPipeline("a", "failed", "boom");
    finishPipeline("b", "succeeded");
    finishPipeline("c", "failed", "boom");
    await flush();

    // No trip: d launched in wave 2 (its dependency b succeeded).
    expect(launched).toEqual(["a", "b", "c", "d"]);
    finishPipeline("d", "succeeded");
    await flush();
    await engineDone;
    expect(nightRunRegistry.get(runId)).toMatchObject({ abortReason: null });
  });

  it("trips the cost cap from tagged session costs (partial totals marked ≥)", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_cost_${counter}`;
    const plan = makePlan([["a"], ["b"]]);
    const launched: string[] = [];

    // The launcher's sessions get tagged + costed like markSessionTerminal
    // would: a Claude session reporting $7 and a costless codex one.
    const launchBuild = async (epicId: string): Promise<WaveLaunchHandle> => {
      launched.push(epicId);
      db.insert(agentSessions)
        .values({
          id: `s-${epicId}`,
          projectId,
          status: "completed",
          batchRunId: runId,
          totalCostUsd: 7,
        })
        .run();
      db.insert(agentSessions)
        .values({
          id: `s-${epicId}-stage`,
          projectId,
          status: "completed",
          batchRunId: runId,
          totalCostUsd: null,
        })
        .run();
      return {
        sessionId: `s-${epicId}`,
        settled: Promise.resolve({
          epicId,
          sessionId: `s-${epicId}`,
          success: true,
          outcome: "answered",
          error: null,
        }),
      };
    };

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([["b", "a"]]),
      failurePolicy: "halt",
      namedAgentId: null,
      costCapUsd: 5,
      launchBuild,
    });

    await flush();
    finishPipeline("a", "succeeded");
    await flush();
    await engineDone;

    // Wave 2 aborted at the boundary: $7 spent >= $5 cap.
    expect(launched).toEqual(["a"]);
    expect(plan.ticketStatus.get("b")).toBe("skipped");
    expect(plan.failureReasons.get("b")).toBe(
      "cost cap reached: $7.00 of $5.00"
    );
    expect(nightRunRegistry.get(runId)).toMatchObject({
      abortReason: "cost cap reached: $7.00 of $5.00",
    });

    const summaryRows = nightNotifications(projectId);
    expect(summaryRows).toHaveLength(1);
    // One session reported no cost → the total is a lower bound.
    expect(summaryRows[0].title).toBe(
      "Night run finished: 1 to merge, 1 skipped — ≥$7.00 — cost cap reached"
    );
  });

  it("an epic that fails to launch counts as a breaker failure", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_nolaunch_${counter}`;
    // b is independent — only the breaker abort keeps it from wave 2.
    const plan = makePlan([["a"], ["b"]]);

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([]),
      failurePolicy: "halt",
      namedAgentId: null,
      breakerThreshold: 1,
      launchBuild: async () => null,
    });

    await flush();
    await engineDone;

    // No pipeline ever started; the immediate failure tripped the breaker.
    expect(pipelineMocks.startPipelineRun).not.toHaveBeenCalled();
    expect(plan.ticketStatus.get("a")).toBe("failed");
    expect(plan.ticketStatus.get("b")).toBe("skipped");
    expect(plan.failureReasons.get("b")).toBe(
      "circuit breaker: 1 consecutive pipeline failures"
    );
  });
});

/* ------------------------------------------------------------------ */
/* User stop (POST .../stop → registry flag → shouldAbortRun)          */
/* ------------------------------------------------------------------ */

describe("startNightRun — user stop", () => {
  it("stops at the wave boundary: in-flight settles, the rest is skipped 'stopped by user'", async () => {
    const projectId = seedProject(["a", "b", "c"]);
    const runId = `night_stop_${counter}`;
    // b and c are INDEPENDENT of a — under "halt" they would both build in
    // wave 2. Only the stop request can keep them from launching.
    const plan = makePlan([["a"], ["b", "c"]]);
    const launched: string[] = [];

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([]),
      failurePolicy: "halt",
      namedAgentId: null,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    expect(launched).toEqual(["a"]);
    expect(nightRunRegistry.get(runId)!.stopRequested).toBe(false);

    // The user hits Stop while wave 1 is still in flight.
    expect(nightRunRegistry.requestStop(runId)).toBe(true);
    expect(nightRunRegistry.get(runId)!.stopRequested).toBe(true);

    // a's pipeline is NOT force-cancelled — it settles normally (same
    // semantics as a breaker trip) and its epic lands "done".
    finishPipeline("a", "succeeded");
    await flush();
    await engineDone;

    expect(launched).toEqual(["a"]);
    expect(plan.ticketStatus.get("a")).toBe("done");
    for (const epicId of ["b", "c"]) {
      expect(plan.ticketStatus.get(epicId)).toBe("skipped");
      expect(plan.failureReasons.get(epicId)).toBe(NIGHT_STOPPED_ABORT_REASON);
      expect(
        db
          .select()
          .from(ticketActivityLog)
          .where(eq(ticketActivityLog.epicId, epicId))
          .all()
          .map((row) => row.reason)
      ).toContain(NIGHT_STOPPED_ABORT_REASON);
    }

    expect(nightRunRegistry.get(runId)).toMatchObject({
      state: "finished",
      abortReason: NIGHT_STOPPED_ABORT_REASON,
      abortedAtWave: 1,
      stopRequested: true,
    });

    // Summary: the stopped variant, and the client formatter agrees.
    const summaryRows = nightNotifications(projectId);
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0].title).toBe(
      "Night run finished: 1 to merge, 2 skipped — stopped by you"
    );
    expect(nightRunAbortKind(NIGHT_STOPPED_ABORT_REASON)).toBe("stopped");

    // Exactly one webhook, carrying the stop reason.
    expect(webhookMock.send).toHaveBeenCalledTimes(1);
    expect(webhookMock.send.mock.calls[0][1]).toMatchObject({
      event: "night_run.completed",
      error: NIGHT_STOPPED_ABORT_REASON,
    });
  });

  it("outranks a tripped circuit breaker in the reason", async () => {
    const projectId = seedProject(["a", "b"]);
    const runId = `night_stop_wins_${counter}`;
    const plan = makePlan([["a"], ["b"]]);
    const launched: string[] = [];

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([]),
      failurePolicy: "halt",
      namedAgentId: null,
      breakerThreshold: 1,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    nightRunRegistry.requestStop(runId);
    // This failure ALSO trips the (threshold 1) breaker — the user's intent
    // is the reason that gets reported.
    finishPipeline("a", "failed", "boom");
    await flush();
    await engineDone;

    expect(plan.failureReasons.get("b")).toBe(NIGHT_STOPPED_ABORT_REASON);
    expect(nightRunRegistry.get(runId)).toMatchObject({
      abortReason: NIGHT_STOPPED_ABORT_REASON,
    });
  });

  it("a stop arriving after the last wave changes nothing", async () => {
    const projectId = seedProject(["a"]);
    const runId = `night_stop_late_${counter}`;
    const plan = makePlan([["a"]]);
    const launched: string[] = [];

    const { engineDone } = startNightRun({
      projectId,
      runId,
      plan,
      graph: graphOf([]),
      failurePolicy: "halt",
      namedAgentId: null,
      launchBuild: instantLaunchBuild(launched),
    });

    await flush();
    finishPipeline("a", "succeeded");
    await flush();
    await engineDone;

    // The run already closed: the registry refuses the late stop.
    expect(nightRunRegistry.requestStop(runId)).toBe(false);
    expect(nightRunRegistry.get(runId)).toMatchObject({
      state: "finished",
      abortReason: null,
      stopRequested: false,
    });
    expect(plan.ticketStatus.get("a")).toBe("done");
  });
});
