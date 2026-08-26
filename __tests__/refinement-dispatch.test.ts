/**
 * Board-refinement dispatch and its HTTP route, against the real migrated
 * schema. The CLI is the only fake: dispatch writes a real queued session
 * row through the real lifecycle and scheduler.
 *
 * The contracts under test: the session is project-scoped (no epicId, so
 * every tool call must name its ticket), it runs in code mode because its
 * whole deliverable is mutating MCP calls, two passes cannot race on the
 * same board, and an empty board is a reported skip rather than a session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const processManagerState = vi.hoisted(() => ({
  // A finished spawn by default: waitForProcessCompletion returns at once,
  // so the scheduler's task settles inside the dispatch call and the tests
  // never depend on poll timing.
  status: { status: "completed", result: { success: true } } as Record<
    string,
    unknown
  > | null,
  started: [] as string[],
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn((sessionId: string) => {
      processManagerState.started.push(sessionId);
    }),
    getStatus: vi.fn(() => processManagerState.status),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("Refine carefully."),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentForDispatch: vi.fn(async () => ({
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
const { agentSessions, epics, notifications, projects } = await import(
  "@/lib/db/schema"
);
const {
  REFINEMENT_EMPTY_BOARD_REASON,
  RefinementDispatchError,
  dispatchRefinementSession,
  getActiveRefinementSession,
} = await import("@/lib/refinement/dispatch");
const { REFINEMENT_AGENT_TYPE } = await import("@/lib/refinement/constants");
const {
  recordRefinementChange,
  peekRefinementChanges,
  _resetRefinementRegistryForTests,
} = await import("@/lib/refinement/registry");
const { GET, POST } = await import(
  "@/app/api/projects/[projectId]/refinement/route"
);
const { AGENT_TYPE_LABELS, isAgentType } = await import(
  "@/lib/agent-config/constants"
);

let counter = 0;

function seedProject(statuses: string[]): string {
  counter += 1;
  const projectId = `project-refine-${counter}`;
  db.insert(projects)
    .values({
      id: projectId,
      name: "Arij",
      gitRepoPath: "/repos/arij",
      spec: "The spec.",
    })
    .run();

  statuses.forEach((status, index) => {
    db.insert(epics)
      .values({
        id: `epic-refine-${counter}-${index}`,
        projectId,
        title: `Ticket ${index}`,
        readableId: `E-refine-${counter}-${index}`,
        status,
        position: index,
      })
      .run();
  });

  return projectId;
}

function seedRefinementSession(projectId: string, status: string): string {
  const id = `session-refine-${projectId}-${status}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      status,
      mode: "code",
      agentType: REFINEMENT_AGENT_TYPE,
    })
    .run();
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  processManagerState.status = {
    status: "completed",
    result: { success: true },
  };
  processManagerState.started = [];
});

describe("refinement agent type", () => {
  it("is a first-class agent type with a label", () => {
    expect(isAgentType(REFINEMENT_AGENT_TYPE)).toBe(true);
    expect(AGENT_TYPE_LABELS.refinement).toBe("Board Refinement");
  });
});

describe("dispatchRefinementSession", () => {
  it("creates a project-scoped code-mode session with no ticket", async () => {
    const projectId = seedProject(["backlog", "todo"]);
    const result = await dispatchRefinementSession({ projectId });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.ticketCount).toBe(2);

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId))
      .get();

    expect(row).toBeDefined();
    expect(row!.agentType).toBe(REFINEMENT_AGENT_TYPE);
    // No ticket: the pass is board-scoped, which is what forces every MCP
    // call to name its target explicitly.
    expect(row!.epicId).toBeNull();
    expect(row!.userStoryId).toBeNull();
    // Code mode — plan mode refuses the mutating tools the pass exists for.
    expect(row!.mode).toBe("code");
    // The spawn actually happened for this session.
    expect(processManagerState.started).toContain(result.sessionId);
  });

  it("puts the board snapshot in the session prompt", async () => {
    const projectId = seedProject(["backlog", "todo"]);
    const result = await dispatchRefinementSession({ projectId });
    if (result.skipped) throw new Error("expected a dispatch");

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId))
      .get();

    expect(row!.prompt).toContain("Refine carefully.");
    expect(row!.prompt).toContain("Board Snapshot");
    expect(row!.prompt).toContain(`E-refine-${counter}-0`);
  });

  it("only counts the planning columns", async () => {
    const projectId = seedProject([
      "backlog",
      "todo",
      "in_progress",
      "review",
      "done",
    ]);
    const result = await dispatchRefinementSession({ projectId });
    if (result.skipped) throw new Error("expected a dispatch");
    expect(result.ticketCount).toBe(2);
  });

  it("skips a board with nothing in Backlog or To do", async () => {
    const projectId = seedProject(["in_progress", "review"]);
    const result = await dispatchRefinementSession({ projectId });

    expect(result).toEqual({
      skipped: true,
      reason: REFINEMENT_EMPTY_BOARD_REASON,
    });
    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.projectId, projectId))
        .all()
    ).toHaveLength(0);
  });

  it.each(["queued", "running"])(
    "refuses a second pass while one is %s",
    async (status) => {
      const projectId = seedProject(["backlog", "todo"]);
      const existing = seedRefinementSession(projectId, status);

      await expect(dispatchRefinementSession({ projectId })).rejects.toThrow(
        RefinementDispatchError
      );
      expect(getActiveRefinementSession(projectId)?.id).toBe(existing);
    }
  );

  it("allows a new pass once the previous one is terminal", async () => {
    const projectId = seedProject(["backlog", "todo"]);
    seedRefinementSession(projectId, "completed");

    expect(getActiveRefinementSession(projectId)).toBeUndefined();
    const result = await dispatchRefinementSession({ projectId });
    expect(result.skipped).toBe(false);
  });

  it("publishes the synthesis report when the pass settles", async () => {
    const projectId = seedProject(["backlog", "todo"]);
    const result = await dispatchRefinementSession({ projectId });
    if (result.skipped) throw new Error("expected a dispatch");

    const settled = await result.settled;
    expect(settled.success).toBe(true);
    expect(settled.report).not.toBeNull();
    // Nothing was changed by this (faked) run, and that is still reported.
    expect(settled.summary).toContain("no changes");

    const rows = db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].agentType).toBe(REFINEMENT_AGENT_TYPE);
    expect(rows[0].sessionId).toBe(result.sessionId);
  });

  it("reports a failed run and still publishes what it changed", async () => {
    processManagerState.status = {
      status: "failed",
      result: { success: false, error: "CLI is not authenticated." },
    };
    const projectId = seedProject(["backlog"]);
    const result = await dispatchRefinementSession({ projectId });
    if (result.skipped) throw new Error("expected a dispatch");

    const settled = await result.settled;
    expect(settled.success).toBe(false);
    expect(settled.error).toContain("not authenticated");

    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId))
      .get();
    expect(row!.status).toBe("failed");

    const notification = db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()[0];
    expect(notification.status).toBe("failed");
    expect(notification.title).toContain("ended early");
  });

  /**
   * Regression: the launch-failure path returned without publishing, so any
   * board writes the session had already made went unexplained — and
   * `takeRefinementChanges` never ran, stranding that session's key in the
   * registry for the life of the process.
   */
  it("publishes and drains when the run throws", async () => {
    const projectId = seedProject(["backlog", "todo"]);
    const result = await dispatchRefinementSession({ projectId });
    if (result.skipped) throw new Error("expected a dispatch");
    await result.settled;

    // A second session that makes a board write and then dies — the exact
    // sequence that used to leave the write unexplained.
    _resetRefinementRegistryForTests();
    const { processManager } = await import("@/lib/claude/process-manager");
    (
      processManager.start as unknown as {
        mockImplementationOnce: (fn: (sessionId: string) => void) => void;
      }
    ).mockImplementationOnce((sessionId: string) => {
      recordRefinementChange(
        { sessionId, agentType: REFINEMENT_AGENT_TYPE },
        {
          kind: "promoted",
          ticketId: `epic-refine-${counter}-0`,
          label: "E-1",
          detail: "promoted to To do",
          reason: "was ready",
        }
      );
      throw new Error("provider is not authenticated");
    });

    const second = await dispatchRefinementSession({ projectId });
    if (second.skipped) throw new Error("expected a dispatch");

    const settled = await second.settled;
    expect(settled.success).toBe(false);
    // The partial work is reported rather than silently dropped.
    expect(settled.report?.promoted).toHaveLength(1);
    expect(settled.summary).toContain("promoted to To do");
    // And the registry is drained, so the session key cannot leak.
    expect(peekRefinementChanges(second.sessionId)).toEqual([]);
  });

  it("rejects an unknown project", async () => {
    await expect(
      dispatchRefinementSession({ projectId: "nope" })
    ).rejects.toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
  });
});

describe("refinement route", () => {
  it("reports the idle state and the workload", async () => {
    const projectId = seedProject(["backlog", "todo", "done"]);
    const response = await GET(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({
      running: false,
      sessionId: null,
      ticketCount: 2,
    });
  });

  /**
   * The status endpoint is polled per open board tab. It must answer from a
   * COUNT rather than assembling the whole snapshot (5 queries including
   * unindexed reads of ticket_comments and agent_sessions) to return an int.
   */
  it("counts the planning columns without loading the snapshot", async () => {
    const projectId = seedProject([
      "backlog",
      "backlog",
      "todo",
      "in_progress",
      "review",
      "done",
      "released",
    ]);

    const response = await GET(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    expect((await response.json()).data.ticketCount).toBe(3);
  });

  it("reports zero for a board with nothing to refine", async () => {
    const projectId = seedProject(["in_progress", "done"]);
    const response = await GET(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    expect((await response.json()).data.ticketCount).toBe(0);
  });

  it("starts a pass", async () => {
    const projectId = seedProject(["backlog"]);
    const started = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    const startedJson = await started.json();

    expect(started.status).toBe(200);
    expect(startedJson.data.started).toBe(true);
    expect(startedJson.data.ticketCount).toBe(1);
    expect(startedJson.data.sessionId).toBeTruthy();
  });

  it("reports an in-flight pass so the button can disable itself", async () => {
    const projectId = seedProject(["backlog"]);
    const sessionId = seedRefinementSession(projectId, "running");

    const response = await GET(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    expect((await response.json()).data).toMatchObject({
      running: true,
      sessionId,
    });
  });

  it("reports an empty board as a skip, not an error", async () => {
    const projectId = seedProject(["review"]);
    const response = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({
      started: false,
      reason: REFINEMENT_EMPTY_BOARD_REASON,
    });
  });

  it("returns 409 when a pass is already running", async () => {
    const projectId = seedProject(["backlog"]);
    seedRefinementSession(projectId, "running");

    const response = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("REFINEMENT_ALREADY_RUNNING");
    expect(json.sessionId).toBeTruthy();
  });

  it("returns 404 for an unknown project", async () => {
    const response = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId: "missing" })
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("PROJECT_NOT_FOUND");
  });
});
