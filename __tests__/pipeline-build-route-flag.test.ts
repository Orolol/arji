/**
 * Tests for the pipeline trigger surface on the dispatch routes:
 *
 *   - epic build route: body.pipeline true forces the run on (settle wrapper
 *     + startPipelineRun with the pinned input, response gains
 *     pipeline.runId), false forces it off without consulting settings,
 *     absent falls back to resolvePipelineEnabled (default ON unless a
 *     setting opts out),
 *   - the settled promise handed to startPipelineRun resolves with the
 *     build's terminal {sessionId, success, outcome, error},
 *   - story build route: same wiring with scope 'story',
 *   - batch build route: pipeline === true is rejected 400 for the flat
 *     batch modes and dispatches a NIGHT RUN with mode 'dag'.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";
import type { PipelineStageResult, StartPipelineRunInput } from "@/lib/pipeline";

const processManagerState = vi.hoisted(() => ({
  result: undefined as Record<string, unknown> | undefined,
}));

const pipelineMocks = vi.hoisted(() => ({
  resolvePipelineEnabled: vi.fn(() => false),
  startPipelineRun: vi.fn((_input: unknown) => ({ runId: "run-test" })),
}));

const nightMocks = vi.hoisted(() => ({
  startNightRun: vi.fn((_input: unknown) => ({
    firstWaveLaunched: Promise.resolve(["s-night-1"]),
    engineDone: Promise.resolve(),
  })),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/pipeline", () => ({
  resolvePipelineEnabled: pipelineMocks.resolvePipelineEnabled,
  startPipelineRun: pipelineMocks.startPipelineRun,
  listPipelineRunsByProject: vi.fn(() => []),
}));

vi.mock("@/lib/night/run", () => ({
  startNightRun: nightMocks.startNightRun,
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/pipeline-flag-test",
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

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: vi.fn(() => null),
  createAgentAlreadyRunningPayload: vi.fn(() => ({})),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

const { db } = await import("@/lib/db");
const { projects, epics, userStories } = await import("@/lib/db/schema");
const { POST: epicBuildPost } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
);
const { POST: storyBuildPost } = await import(
  "@/app/api/projects/[projectId]/stories/[storyId]/build/route"
);
const { POST: batchBuildPost } = await import(
  "@/app/api/projects/[projectId]/build/route"
);

let counter = 0;

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function seed() {
  counter += 1;
  const projectId = `proj-flag-${counter}`;
  const epicId = `epic-flag-${counter}`;
  const storyId = `story-flag-${counter}`;

  db.insert(projects)
    .values({ id: projectId, name: "Flag Project", gitRepoPath: "/repos/f" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Pipeline epic",
      status: "todo",
      position: 0,
      readableId: `E-f-${counter}`,
    })
    .run();
  db.insert(userStories)
    .values({
      id: storyId,
      epicId,
      title: "Pipeline story",
      status: "todo",
      position: 0,
    })
    .run();

  return { projectId, epicId, storyId };
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineMocks.resolvePipelineEnabled.mockReturnValue(false);
  pipelineMocks.startPipelineRun.mockReturnValue({ runId: "run-test" });
  processManagerState.result = {
    success: true,
    result: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Implemented the ticket.",
    }),
    duration: 1000,
  };
});

describe("epic build route — pipeline flag", () => {
  it("setting off: response carries pipeline: null, setting consulted", async () => {
    const { projectId, epicId } = seed();
    const res = await epicBuildPost(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data.pipeline).toBeNull();
    expect(json.data.sessionId).toBeTruthy();
    expect(pipelineMocks.resolvePipelineEnabled).toHaveBeenCalledWith(projectId);
    expect(pipelineMocks.startPipelineRun).not.toHaveBeenCalled();
    await flushBackground();
  });

  it("pipeline: true starts a run with the pinned input and returns its runId", async () => {
    const { projectId, epicId } = seed();
    const res = await epicBuildPost(
      mockJsonRequest({ pipeline: true }),
      mockRouteContext({ projectId, epicId })
    );
    const json = await res.json();

    expect(json.data.pipeline).toEqual({ runId: "run-test" });
    expect(pipelineMocks.startPipelineRun).toHaveBeenCalledTimes(1);
    const input = pipelineMocks.startPipelineRun.mock
      .calls[0][0] as unknown as StartPipelineRunInput;
    expect(input).toMatchObject({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildSessionId: json.data.sessionId,
      buildProvider: "claude-code",
      buildNamedAgentId: null,
    });
    // An explicit flag beats the setting — it is never consulted.
    expect(pipelineMocks.resolvePipelineEnabled).not.toHaveBeenCalled();

    // The settle wrapper resolves the build's terminal result.
    await flushBackground();
    const settled: PipelineStageResult = await input.buildSettled;
    expect(settled).toEqual({
      sessionId: json.data.sessionId,
      success: true,
      outcome: "answered",
      error: null,
    });
    // The build closure still ran its normal finalize (epic → review).
    const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
    expect(epic!.status).toBe("review");
  });

  it("pipeline: true forwards the request's namedAgentId as the run's original", async () => {
    const { projectId, epicId } = seed();
    await epicBuildPost(
      mockJsonRequest({ pipeline: true, namedAgentId: "agent-42" }),
      mockRouteContext({ projectId, epicId })
    );
    await flushBackground();
    expect(pipelineMocks.startPipelineRun.mock.calls[0][0]).toMatchObject({
      buildNamedAgentId: "agent-42",
    });
  });

  it("pipeline: false forces off even when the setting is on", async () => {
    const { projectId, epicId } = seed();
    pipelineMocks.resolvePipelineEnabled.mockReturnValue(true);
    const res = await epicBuildPost(
      mockJsonRequest({ pipeline: false }),
      mockRouteContext({ projectId, epicId })
    );
    const json = await res.json();

    expect(json.data.pipeline).toBeNull();
    expect(pipelineMocks.startPipelineRun).not.toHaveBeenCalled();
    expect(pipelineMocks.resolvePipelineEnabled).not.toHaveBeenCalled();
    await flushBackground();
  });

  it("setting on + absent flag starts the run", async () => {
    const { projectId, epicId } = seed();
    pipelineMocks.resolvePipelineEnabled.mockReturnValue(true);
    const res = await epicBuildPost(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId })
    );
    const json = await res.json();

    expect(json.data.pipeline).toEqual({ runId: "run-test" });
    expect(pipelineMocks.startPipelineRun).toHaveBeenCalledTimes(1);
    await flushBackground();
  });

  it("a failing build settles the pipeline promise with the failure triple", async () => {
    const { projectId, epicId } = seed();
    processManagerState.result = {
      success: false,
      error: "tests exploded",
      duration: 500,
    };
    const res = await epicBuildPost(
      mockJsonRequest({ pipeline: true }),
      mockRouteContext({ projectId, epicId })
    );
    const json = await res.json();
    await flushBackground();

    const input = pipelineMocks.startPipelineRun.mock
      .calls[0][0] as unknown as StartPipelineRunInput;
    const settled = await input.buildSettled;
    expect(settled).toMatchObject({
      sessionId: json.data.sessionId,
      success: false,
      outcome: "error",
      error: "tests exploded",
    });
  });
});

describe("story build route — pipeline flag", () => {
  it("pipeline: true starts a story-scoped run", async () => {
    const { projectId, epicId, storyId } = seed();
    const res = await storyBuildPost(
      mockJsonRequest({ pipeline: true }),
      mockRouteContext({ projectId, storyId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data.pipeline).toEqual({ runId: "run-test" });
    expect(pipelineMocks.startPipelineRun.mock.calls[0][0]).toMatchObject({
      projectId,
      scope: "story",
      epicId,
      userStoryId: storyId,
      buildSessionId: json.data.sessionId,
    });
    await flushBackground();
  });

  it("setting off: response carries pipeline: null", async () => {
    const { projectId, storyId } = seed();
    const res = await storyBuildPost(
      mockJsonRequest({}),
      mockRouteContext({ projectId, storyId })
    );
    const json = await res.json();
    expect(json.data.pipeline).toBeNull();
    expect(pipelineMocks.startPipelineRun).not.toHaveBeenCalled();
    await flushBackground();
  });
});

describe("batch build route — pipeline flag", () => {
  it.each(["sequential", "parallel"] as const)(
    "400s pipeline: true in %s mode (waves only)",
    async (mode) => {
      const { projectId, epicId } = seed();
      const res = await batchBuildPost(
        mockJsonRequest({ epicIds: [epicId], mode, pipeline: true }),
        mockRouteContext({ projectId })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe(
        "Pipeline batch builds run as dependency waves — use mode 'dag'"
      );
      expect(nightMocks.startNightRun).not.toHaveBeenCalled();
      expect(pipelineMocks.startPipelineRun).not.toHaveBeenCalled();
    }
  );

  it("400s pipeline: true in team mode too (team defaults to a flat mode)", async () => {
    const { projectId, epicId } = seed();
    const res = await batchBuildPost(
      mockJsonRequest({ epicIds: [epicId], team: true, pipeline: true }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe(
      "Pipeline batch builds run as dependency waves — use mode 'dag'"
    );
  });

  it("dag + pipeline dispatches a night run (no longer 400)", async () => {
    const { projectId, epicId } = seed();
    const res = await batchBuildPost(
      mockJsonRequest({
        epicIds: [epicId],
        mode: "dag",
        pipeline: true,
        circuitBreaker: 2,
        costCapUsd: 12.5,
      }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data).toMatchObject({
      orchestrationMode: "dag",
      pipeline: true,
      sessions: ["s-night-1"],
      count: 1,
      waves: 1,
      totalEpics: 1,
      failurePolicy: "halt",
    });
    expect(json.data.batchId).toMatch(/^night_/);

    expect(nightMocks.startNightRun).toHaveBeenCalledTimes(1);
    const input = nightMocks.startNightRun.mock.calls[0][0] as unknown as {
      projectId: string;
      runId: string;
      breakerThreshold: number | null;
      costCapUsd: number | null;
      failurePolicy: string;
    };
    expect(input).toMatchObject({
      projectId,
      runId: json.data.batchId,
      breakerThreshold: 2,
      costCapUsd: 12.5,
      failurePolicy: "halt",
    });
    // The per-epic pipelines are the night engine's business — the route
    // itself never starts one.
    expect(pipelineMocks.startPipelineRun).not.toHaveBeenCalled();
  });
});
