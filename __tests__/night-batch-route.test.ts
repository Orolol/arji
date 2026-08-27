/**
 * Route-level tests for night dispatch on POST /api/projects/[projectId]/build:
 *
 *   - the three refusal guards and their 409 codes (NIGHT_RUN_ACTIVE,
 *     BATCH_ACTIVE, PIPELINE_ACTIVE_ON_EPIC — scope-overlap only),
 *   - night response shape (night_ batchId, pipeline: true) and the
 *     startNightRun hand-off,
 *   - batch_run_id tagging: plain DAG batches stamp their batchId on every
 *     session row (retroactive benefit); sequential/parallel stay NULL.
 *
 * startNightRun is mocked (the engine has its own suite); the plain-dag wave
 * engine, scheduler, and lifecycle run for real against the migrated schema.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const processManagerState = vi.hoisted(() => ({
  result: undefined as Record<string, unknown> | undefined,
}));

const nightMocks = vi.hoisted(() => ({
  startNightRun: vi.fn((_input: unknown) => ({
    firstWaveLaunched: Promise.resolve(["s-night-1"]),
    engineDone: Promise.resolve(),
  })),
}));

const pipelineListMock = vi.hoisted(() => ({
  listPipelineRunsByProject: vi.fn(() => [] as Array<Record<string, unknown>>),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/night/run", () => ({
  startNightRun: nightMocks.startNightRun,
}));

vi.mock("@/lib/pipeline", () => ({
  listPipelineRunsByProject: pipelineListMock.listPipelineRunsByProject,
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/night-route-test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerState.result,
    })),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions } = await import("@/lib/db/schema");
const { nightRunRegistry } = await import("@/lib/night/registry");
const { dagBatchRegistry } = await import("@/lib/agents/dag-batch-registry");
const { POST: batchBuildPost } = await import(
  "@/app/api/projects/[projectId]/build/route"
);
import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";

let counter = 0;

async function flushBackground() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function seed(epicCount = 1) {
  counter += 1;
  const projectId = `proj-nbr-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Night Route", gitRepoPath: "/repos/n" })
    .run();
  const epicIds: string[] = [];
  for (let i = 0; i < epicCount; i++) {
    const epicId = `epic-nbr-${counter}-${i}`;
    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: `Night epic ${i}`,
        status: "todo",
        position: i,
        readableId: `E-n-${counter}-${i}`,
      })
      .run();
    epicIds.push(epicId);
  }
  return { projectId, epicIds };
}

function registerNightRun(projectId: string, runId: string) {
  nightRunRegistry.register({
    runId,
    projectId,
    failurePolicy: "halt",
    breakerThreshold: 3,
    costCapUsd: null,
    state: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    currentWave: 1,
    totalWaves: 1,
    totalEpics: 1,
    counts: {
      pending: 0,
      running: 1,
      done: 0,
      asked: 0,
      failed: 0,
      skipped: 0,
    } as Record<TicketExecutionStatus, number>,
    epics: [],
    stopRequested: false,
    abortReason: null,
    abortedAtWave: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineListMock.listPipelineRunsByProject.mockReturnValue([]);
  processManagerState.result = {
    success: true,
    result: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Implemented; tests green.",
    }),
    duration: 1000,
  };
});

describe("night dispatch guards", () => {
  it("409 NIGHT_RUN_ACTIVE when the project already has an active night run", async () => {
    const { projectId, epicIds } = seed();
    registerNightRun(projectId, `night_guard_${counter}`);

    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "dag", pipeline: true }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("NIGHT_RUN_ACTIVE");
    expect(json.error).toBeTruthy();
    expect(nightMocks.startNightRun).not.toHaveBeenCalled();

    nightRunRegistry.finish(`night_guard_${counter}`);
  });

  it("409 BATCH_ACTIVE over an active plain DAG batch", async () => {
    const { projectId, epicIds } = seed();
    dagBatchRegistry.start({
      batchId: `batch_guard_${counter}`,
      projectId,
      failurePolicy: "halt",
      totalWaves: 1,
      totalEpics: 1,
    });

    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "dag", pipeline: true }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("BATCH_ACTIVE");
    expect(nightMocks.startNightRun).not.toHaveBeenCalled();

    dagBatchRegistry.finish(`batch_guard_${counter}`);
  });

  it("409 PIPELINE_ACTIVE_ON_EPIC only when the active pipeline overlaps the scope", async () => {
    const { projectId, epicIds } = seed();

    // Active pipeline on an epic OUTSIDE the scope: no conflict.
    pipelineListMock.listPipelineRunsByProject.mockReturnValue([
      { runId: "plr-other", epicId: "unrelated-epic", state: "running_build" },
    ]);
    const ok = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "dag", pipeline: true }),
      mockRouteContext({ projectId })
    );
    expect(ok.status).toBe(200);

    // Active pipeline ON a scoped epic: refused.
    const { projectId: p2, epicIds: e2 } = seed();
    pipelineListMock.listPipelineRunsByProject.mockReturnValue([
      { runId: "plr-hit", epicId: e2[0], state: "running_review" },
    ]);
    const res = await batchBuildPost(
      mockJsonRequest({ epicIds: e2, mode: "dag", pipeline: true }),
      mockRouteContext({ projectId: p2 })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PIPELINE_ACTIVE_ON_EPIC");

    // A TERMINAL pipeline on a scoped epic does not block.
    const { projectId: p3, epicIds: e3 } = seed();
    pipelineListMock.listPipelineRunsByProject.mockReturnValue([
      { runId: "plr-done", epicId: e3[0], state: "succeeded" },
    ]);
    const done = await batchBuildPost(
      mockJsonRequest({ epicIds: e3, mode: "dag", pipeline: true }),
      mockRouteContext({ projectId: p3 })
    );
    expect(done.status).toBe(200);
  });

  it("plain dag keeps today's behavior: no night guards consulted", async () => {
    const { projectId, epicIds } = seed();
    // An active night run elsewhere does NOT block a plain dag batch.
    registerNightRun(projectId, `night_plain_${counter}`);

    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "dag" }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    expect(nightMocks.startNightRun).not.toHaveBeenCalled();
    await flushBackground();

    nightRunRegistry.finish(`night_plain_${counter}`);
  });
});

describe("night dispatch response", () => {
  it("responds with the night batchId (night_ prefix), pipeline flag, and plan metadata", async () => {
    const { projectId, epicIds } = seed(2);
    const res = await batchBuildPost(
      mockJsonRequest({
        epicIds,
        mode: "dag",
        pipeline: true,
        failurePolicy: "stop",
      }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({
      orchestrationMode: "dag",
      pipeline: true,
      failurePolicy: "stop",
      totalEpics: 2,
      sessions: ["s-night-1"],
      count: 1,
    });
    expect(json.data.batchId).toMatch(/^night_/);

    const input = nightMocks.startNightRun.mock.calls[0][0] as unknown as {
      runId: string;
      projectId: string;
      failurePolicy: string;
      namedAgentId: string | null;
      breakerThreshold: number | null;
      costCapUsd: number | null;
      plan: { layers: string[][] };
      launchBuild: (epicId: string) => Promise<unknown>;
    };
    expect(input.runId).toBe(json.data.batchId);
    expect(input.projectId).toBe(projectId);
    expect(input.failurePolicy).toBe("stop");
    // No overrides sent: the engine falls back to the settings chain.
    expect(input.breakerThreshold).toBeNull();
    expect(input.costCapUsd).toBeNull();
    expect(input.plan.layers.flat().sort()).toEqual([...epicIds].sort());
    expect(typeof input.launchBuild).toBe("function");
  });
});

describe("batch_run_id tagging", () => {
  it("plain dag stamps its batchId on every session row (retroactive benefit)", async () => {
    const { projectId, epicIds } = seed(2);
    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "dag" }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    await flushBackground();

    const rows = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.projectId, projectId))
      .all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.batchRunId).toBe(json.data.batchId);
      expect(row.estimatedPromptTokens).toBeGreaterThan(0);
      expect(row.estimatedPromptBreakdown).not.toBeNull();
      const breakdown = JSON.parse(row.estimatedPromptBreakdown!);
      expect(breakdown.ticket).toBeGreaterThan(0);
      const sum = Object.values(breakdown as Record<string, number>).reduce(
        (total, tokens) => total + tokens,
        0,
      );
      expect(Math.abs(sum - row.estimatedPromptTokens!)).toBeLessThanOrEqual(8);
    }
    expect(json.data.batchId).not.toMatch(/^night_/);
  });

  it("sequential and parallel dispatches leave batch_run_id NULL", async () => {
    const { projectId, epicIds } = seed();
    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "sequential" }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    await flushBackground();

    const rows = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.projectId, projectId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].batchRunId).toBeNull();
  });
});
