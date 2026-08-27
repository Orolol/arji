/**
 * Route-level tests for the batch build route's "dag" mode: wave-ordered
 * launches, skip propagation side effects (activity log + notification),
 * halt vs stop failure policies, and body validation.
 *
 * The plan/graph modules are mocked (their layering logic is covered by
 * dag-scheduler.test.ts and wave-runner.test.ts); the wave engine itself
 * runs for real so these tests exercise the actual route composition.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call counts to return different values for sequential .get() calls
let getCallCount = 0;

interface FakeCliResult {
  success: boolean;
  duration: number;
  result?: string;
  error?: string;
  endedWithQuestion?: boolean;
}

const mockState = vi.hoisted(() => ({
  /** Result served for the Nth started session (start order). */
  resultsByStartOrder: [] as Array<{
    success: boolean;
    duration: number;
    result?: string;
    error?: string;
    endedWithQuestion?: boolean;
  }>,
  startedSessions: [] as string[],
  /** Layers returned by the mocked buildExecutionPlan. */
  layers: [] as string[][],
  /** Predecessor graph returned by the mocked loadProjectGraph. */
  graphEdges: [] as Array<[string, string]>,
  /** When set, getTransitiveDependencies returns these ids. */
  expandedIds: null as string[] | null,
  /** When set, filterBuildableTickets returns these ids (guard simulation). */
  buildableIds: null as string[] | null,
  planCalls: [] as string[][],
  transitiveCalls: [] as string[][],
  buildableCalls: [] as string[][],
}));

const mockCreateQueuedSession = vi.hoisted(() => vi.fn());
const mockLogTransition = vi.hoisted(() => vi.fn());
const mockCreateDagWaveOutcomeNotification = vi.hoisted(() => vi.fn());
const mockHandleAskedQuestionOutcome = vi.hoisted(() => vi.fn());
const mockMarkSessionTerminal = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    // `buildTransitionContext` reads the epic's session facts through a
    // projected subquery (`.as`) that it then groups.
    groupBy: vi.fn().mockReturnThis(),
    as: vi.fn().mockReturnThis(),
    get: vi.fn(() => {
      getCallCount++;
      // Call 1: project lookup. Everything after: epic-shaped rows.
      if (getCallCount === 1) {
        return {
          id: "proj-1",
          name: "Test",
          gitRepoPath: "/repos/test",
          status: "building",
        };
      }
      return {
        id: "epic-generic",
        title: "Test Epic",
        description: "A test epic",
        epicId: "epic-generic",
        status: "in_progress",
        readableId: "E-p-001",
      };
    }),
    all: vi.fn().mockReturnValue([]),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
  };
  return { db: chain };
});

vi.mock("@/lib/utils/nanoid", () => {
  let n = 0;
  return { createId: vi.fn(() => `gen-${++n}`) };
});

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/epic-abc-test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn((sessionId: string) => {
      mockState.startedSessions.push(sessionId);
      return { sessionId, status: "running", startedAt: new Date() };
    }),
    getStatus: vi.fn((sessionId: string) => {
      const index = mockState.startedSessions.indexOf(sessionId);
      const result: FakeCliResult = (index >= 0 &&
        mockState.resultsByStartOrder[index]) || {
        success: true,
        duration: 1000,
        result: "Implemented; tests green.",
      };
      return { status: "completed", result };
    }),
  },
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: vi.fn().mockReturnValue("solo prompt"),
  buildTeamBuildPrompt: vi.fn().mockReturnValue("team prompt"),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("resolved system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({ provider: "claude-code" })),
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: mockCreateQueuedSession,
  markSessionRunning: vi.fn(),
  markSessionTerminal: mockMarkSessionTerminal,
  isSessionLifecycleConflictError: vi.fn(() => false),
  isSessionNotFoundError: vi.fn(() => false),
  recordSessionTransitionRefusal: vi.fn(),
}));

vi.mock("@/lib/workflow/agent-question", () => ({
  handleAskedQuestionOutcome: mockHandleAskedQuestionOutcome,
}));

vi.mock("@/lib/workflow/log", () => ({
  logTransition: mockLogTransition,
}));

vi.mock("@/lib/notifications/create", () => ({
  createDagWaveOutcomeNotification: mockCreateDagWaveOutcomeNotification,
}));

vi.mock("@/lib/dependencies/scheduler", () => ({
  buildExecutionPlan: vi.fn((_projectId: string, ticketIds: string[]) => {
    mockState.planCalls.push([...ticketIds]);
    const ticketStatus = new Map<string, string>();
    for (const layer of mockState.layers) {
      for (const id of layer) ticketStatus.set(id, "pending");
    }
    return {
      layers: mockState.layers,
      ticketStatus,
      failureReasons: new Map<string, string>(),
    };
  }),
}));

vi.mock("@/lib/dependencies/validation", () => ({
  getTransitiveDependencies: vi.fn(
    (_projectId: string, ticketIds: string[]) => {
      mockState.transitiveCalls.push([...ticketIds]);
      return new Set(mockState.expandedIds ?? ticketIds);
    }
  ),
  filterBuildableTickets: vi.fn(
    (_projectId: string, ticketIds: string[]) => {
      mockState.buildableCalls.push([...ticketIds]);
      if (mockState.buildableIds === null) return [...ticketIds];
      const keep = new Set(mockState.buildableIds);
      return ticketIds.filter((id) => keep.has(id));
    }
  ),
  loadProjectGraph: vi.fn(() => {
    const graph = new Map<string, Set<string>>();
    for (const [ticket, dependsOn] of mockState.graphEdges) {
      if (!graph.has(ticket)) graph.set(ticket, new Set());
      graph.get(ticket)!.add(dependsOn);
    }
    return graph;
  }),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join("/")),
  },
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

async function flushBackground() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sessions created, as `[epicId, sessionId]` in creation order. */
function createdSessions(): Array<[string, string]> {
  return mockCreateQueuedSession.mock.calls.map((call) => [
    (call[0] as { epicId: string }).epicId,
    (call[0] as { id: string }).id,
  ]);
}

function systemActivity() {
  return mockLogTransition.mock.calls
    .map((call) => call[0] as {
      actor: string;
      epicId: string;
      reason?: string;
      fromStatus: string;
      toStatus: string;
      projectId: string;
    })
    .filter((entry) => entry.actor === "system");
}

describe("Build Route — dag mode", () => {
  beforeEach(() => {
    getCallCount = 0;
    mockState.resultsByStartOrder = [];
    mockState.startedSessions = [];
    mockState.layers = [];
    mockState.graphEdges = [];
    mockState.expandedIds = null;
    mockState.buildableIds = null;
    mockState.planCalls = [];
    mockState.transitiveCalls = [];
    mockState.buildableCalls = [];
    mockCreateQueuedSession.mockClear();
    mockLogTransition.mockClear();
    mockCreateDagWaveOutcomeNotification.mockClear();
    mockHandleAskedQuestionOutcome.mockClear();
    mockMarkSessionTerminal.mockClear();
  });

  it("responds with wave-1 sessions + plan metadata, then launches later waves in the background", async () => {
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = [["e2", "e1"]];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2"], mode: "dag" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.orchestrationMode).toBe("dag");
    expect(json.data.waves).toBe(2);
    expect(json.data.totalEpics).toBe(2);
    expect(json.data.failurePolicy).toBe("halt");
    expect(json.data.batchId).toBeDefined();
    // Only wave 1 has launched when the response returns.
    expect(json.data.count).toBe(1);
    expect(json.data.sessions).toHaveLength(1);

    await flushBackground();

    // Both epics got sessions, dependency first.
    const sessions = createdSessions();
    expect(sessions.map(([epicId]) => epicId)).toEqual(["e1", "e2"]);
    expect(json.data.sessions[0]).toBe(sessions[0][1]);
    expect(mockState.startedSessions).toEqual([sessions[0][1], sessions[1][1]]);
    expect(systemActivity()).toEqual([]);
    expect(mockCreateDagWaveOutcomeNotification).not.toHaveBeenCalled();
  });

  it("expands the selection to its transitive dependency closure", async () => {
    mockState.expandedIds = ["e1", "e2"];
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = [["e2", "e1"]];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(mockRequest({ epicIds: ["e2"], mode: "dag" }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    expect(mockState.transitiveCalls[0]).toEqual(["e2"]);
    expect(mockState.planCalls[0]).toEqual(["e1", "e2"]);
    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e1", "e2"]);
  });

  it("drops already-delivered epics from the plan: no wave, no session, wave 1 for the dependent", async () => {
    // e1 is done/released: the closure still names it (the client may have
    // selected it), but the guard filters it out — e2 then has no
    // prerequisite left to wait for and is planned as the only wave.
    mockState.expandedIds = ["e1", "e2"];
    mockState.buildableIds = ["e2"];
    mockState.layers = [["e2"]];
    mockState.graphEdges = [["e2", "e1"]];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2"], mode: "dag" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.waves).toBe(1);
    expect(json.data.totalEpics).toBe(1);
    await flushBackground();

    // The guard saw the whole closure and the plan only the buildable rest.
    expect(mockState.buildableCalls[0]).toEqual(["e1", "e2"]);
    expect(mockState.planCalls[0]).toEqual(["e2"]);

    // The done epic is never rebuilt, and never blocks its dependent.
    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e2"]);
    expect(systemActivity()).toEqual([]);
    expect(mockCreateDagWaveOutcomeNotification).not.toHaveBeenCalled();
  });

  it("rejects a selection with no buildable epic left", async () => {
    mockState.buildableIds = [];
    mockState.layers = [["e1"]];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(mockRequest({ epicIds: ["e1"], mode: "dag" }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("No buildable epics");
    expect(mockCreateQueuedSession).not.toHaveBeenCalled();
    expect(mockState.planCalls).toHaveLength(0);
  });

  it("a failed dependency skips transitive dependents: no sessions, system activity entries, one wave notification", async () => {
    mockState.layers = [["e1"], ["e2"], ["e3"]];
    mockState.graphEdges = [
      ["e2", "e1"],
      ["e3", "e2"],
    ];
    mockState.resultsByStartOrder = [
      { success: false, duration: 500, error: "build exploded" },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2", "e3"], mode: "dag" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    // Only the failed dependency ever got a session.
    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e1"]);

    // Skips are logged as system activity, blaming the failed dependency.
    expect(systemActivity()).toHaveLength(2);
    const loggedEpicIds = systemActivity().map((entry) => entry.epicId);
    expect(new Set(loggedEpicIds)).toEqual(new Set(["e2", "e3"]));
    for (const entry of systemActivity()) {
      expect(entry.projectId).toBe("proj-1");
      expect(entry.actor).toBe("system");
      expect(entry.reason).toBe("skipped: dependency E-p-001 failed");
      expect(entry.fromStatus).toBe(entry.toStatus);
    }

    // One notification summarizing the blocked wave.
    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        wave: 1,
        totalWaves: 3,
        blocked: [{ epicId: "e1", kind: "failed" }],
        skippedCount: 2,
        stopped: false,
      })
    );
  });

  it("asked_question blocks dependents too, with the question-flavored reason", async () => {
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = [["e2", "e1"]];
    mockState.resultsByStartOrder = [
      {
        success: true,
        duration: 800,
        result: "Which auth provider should I integrate?",
        endedWithQuestion: true,
      },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2"], mode: "dag" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e1"]);

    // The per-session asked-question workflow still runs for the blocker...
    expect(mockHandleAskedQuestionOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", epicIds: ["e1"] })
    );

    // ...and the dependent is skipped with the question-flavored reason.
    expect(systemActivity()).toHaveLength(1);
    expect(systemActivity()).toContainEqual(
      expect.objectContaining({
        epicId: "e2",
        actor: "system",
        reason: "skipped: dependency E-p-001 asked a question",
      })
    );

    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        blocked: [{ epicId: "e1", kind: "asked_question" }],
        skippedCount: 1,
      })
    );
  });

  it("skips the wave notification when a question blocked nothing", async () => {
    // e1 asks a question but has zero dependents: the per-session
    // "Agent asked a question" notification already says everything, so the
    // wave summary would be a duplicate.
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = []; // e2 does NOT depend on e1
    mockState.resultsByStartOrder = [
      {
        success: true,
        duration: 800,
        result: "Which auth provider should I integrate?",
        endedWithQuestion: true,
      },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2"], mode: "dag" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    // The per-session workflow still fires, and the independent branch runs.
    expect(mockHandleAskedQuestionOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ epicIds: ["e1"] })
    );
    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e1", "e2"]);
    expect(systemActivity()).toEqual([]);
    expect(mockCreateDagWaveOutcomeNotification).not.toHaveBeenCalled();
  });

  it("still notifies when a failure blocked nothing", async () => {
    // Same shape, but a failure is news even with zero dependents.
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = [];
    mockState.resultsByStartOrder = [
      { success: false, duration: 500, error: "boom" },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    await POST(mockRequest({ epicIds: ["e1", "e2"], mode: "dag" }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    await flushBackground();

    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        blocked: [{ epicId: "e1", kind: "failed" }],
        skippedCount: 0,
      })
    );
  });

  it("halt policy (default) still builds independent branches after a failure", async () => {
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = []; // e2 does NOT depend on e1
    mockState.resultsByStartOrder = [
      { success: false, duration: 500, error: "boom" },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2"], mode: "dag" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    // Independent e2 still got its session; nothing was skipped.
    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e1", "e2"]);
    expect(systemActivity()).toEqual([]);
    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ skippedCount: 0, stopped: false })
    );
  });

  it("stop policy abandons remaining waves, skipping even independent epics", async () => {
    mockState.layers = [["e1"], ["e2"]];
    mockState.graphEdges = []; // e2 independent
    mockState.resultsByStartOrder = [
      { success: false, duration: 500, error: "boom" },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({
        epicIds: ["e1", "e2"],
        mode: "dag",
        failurePolicy: "stop",
      }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.failurePolicy).toBe("stop");
    await flushBackground();

    expect(createdSessions().map(([epicId]) => epicId)).toEqual(["e1"]);
    expect(systemActivity()).toHaveLength(1);
    expect(systemActivity()).toContainEqual(
      expect.objectContaining({
        epicId: "e2",
        actor: "system",
        reason: "skipped: batch stopped after wave 1 failure",
      })
    );
    expect(mockCreateDagWaveOutcomeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ stopped: true, skippedCount: 1 })
    );
  });

  it("rejects an invalid failurePolicy with a zod validation error", async () => {
    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({
        epicIds: ["e1"],
        mode: "dag",
        failurePolicy: "explode",
      }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Validation failed");
    expect(json.details.failurePolicy).toBeDefined();
    expect(mockCreateQueuedSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid mode with a zod validation error", async () => {
    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(mockRequest({ epicIds: ["e1"], mode: "waves" }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Validation failed");
    expect(json.details.mode).toBeDefined();
  });

  it("rejects team mode combined with dag mode", async () => {
    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(
      mockRequest({ epicIds: ["e1", "e2"], mode: "dag", team: true }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Team mode cannot be combined");
  });
});
