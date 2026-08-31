/**
 * Integration tests for the agent scheduler at the dispatch routes, against
 * the real migrated schema (createTestDb):
 *
 *   - a parallel batch of 3 epics with `agent_max_concurrent:<projectId>` = 1
 *     leaves 1 session running and 2 queued, then drains FIFO as each CLI
 *     completes (markSessionRunning only fires when a slot frees),
 *   - sessions/active surfaces queued sessions alongside running ones,
 *   - the per-target concurrency guard 409s while a session is only queued,
 *   - cancelling a queued session removes it from the queue for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const pmState = vi.hoisted(() => ({
  sessions: new Map<string, { status: string; result?: unknown }>(),
  startOrder: [] as string[],
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/pipeline", () => ({
  resolvePipelineEnabled: vi.fn(() => false),
  startPipelineRun: vi.fn(() => ({ runId: "run-test" })),
}));

vi.mock("@/lib/git/manager", () => ({
  attachWorktree: vi.fn(async (_repo: string, branchName: string) => ({
    worktreePath: `/tmp/worktree-${branchName.replace(/\//g, "-")}`,
    branchName,
  })),
  createWorktree: vi.fn(async (_repo: string, epicId: string) => ({
    worktreePath: `/tmp/worktree-${epicId}`,
    branchName: `feature/${epicId}`,
  })),
  isGitRepo: vi.fn().mockResolvedValue(true),
  resolveWorktreeHead: vi.fn(async () => null),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn((sessionId: string) => {
      pmState.sessions.set(sessionId, { status: "running" });
      pmState.startOrder.push(sessionId);
    }),
    getStatus: vi.fn((sessionId: string) => {
      const tracked = pmState.sessions.get(sessionId);
      return tracked
        ? { status: tracked.status, result: tracked.result }
        : null;
    }),
    cancel: vi.fn(() => false),
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

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

const { db } = await import("@/lib/db");
const { attachWorktree, createWorktree, resolveWorktreeHead } =
  await import("@/lib/git/manager");
const {
  projects,
  epics,
  agentSessions,
  settings,
  reviewComments,
  ticketActivityLog,
  notifications,
} = await import("@/lib/db/schema");
const { POST: batchBuildPost } =
  await import("@/app/api/projects/[projectId]/build/route");
const { POST: epicBuildPost } =
  await import("@/app/api/projects/[projectId]/epics/[epicId]/build/route");
const { GET: activeGet } =
  await import("@/app/api/projects/[projectId]/sessions/active/route");
const { DELETE: sessionDelete } =
  await import("@/app/api/projects/[projectId]/sessions/[sessionId]/route");

let counter = 0;

function seedProject(epicCount: number, maxConcurrent?: number) {
  counter += 1;
  const projectId = `proj-sched-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Sched", gitRepoPath: "/repos/sched" })
    .run();

  const epicIds: string[] = [];
  for (let i = 0; i < epicCount; i++) {
    const epicId = `epic-${counter}-${i}`;
    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: `Epic ${i}`,
        status: "todo",
        position: i,
        readableId: `E-${counter}-${i}`,
      })
      .run();
    epicIds.push(epicId);
  }

  if (maxConcurrent !== undefined) {
    db.insert(settings)
      .values({
        key: `agent_max_concurrent:${projectId}`,
        value: JSON.stringify(maxConcurrent),
      })
      .run();
  }

  return { projectId, epicIds };
}

function sessionsByStatus(projectId: string) {
  const rows = db
    .select({
      id: agentSessions.id,
      epicId: agentSessions.epicId,
      status: agentSessions.status,
      startedAt: agentSessions.startedAt,
      error: agentSessions.error,
      prompt: agentSessions.prompt,
      agentType: agentSessions.agentType,
      batchRunId: agentSessions.batchRunId,
      branchName: agentSessions.branchName,
      worktreePath: agentSessions.worktreePath,
    })
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all();
  return {
    rows,
    running: rows.filter((r) => r.status === "running"),
    queued: rows.filter((r) => r.status === "queued"),
    completed: rows.filter((r) => r.status === "completed"),
    cancelled: rows.filter((r) => r.status === "cancelled"),
  };
}

function completeSession(sessionId: string) {
  pmState.sessions.set(sessionId, {
    status: "completed",
    result: {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done.",
      }),
      duration: 1000,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pmState.sessions.clear();
  pmState.startOrder = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler-integrated batch build", () => {
  it("runs a 3-epic batch with maxConcurrent 1 as 1 running + 2 queued, draining FIFO", async () => {
    const { projectId, epicIds } = seedProject(3, 1);

    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "parallel" }),
      mockRouteContext({ projectId }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.sessions).toHaveLength(3);

    // Only one CLI spawned; the two others sit queued in the DB.
    let state = sessionsByStatus(projectId);
    expect(state.running).toHaveLength(1);
    expect(state.queued).toHaveLength(2);
    expect(state.running[0].epicId).toBe(epicIds[0]);
    expect(state.running[0].startedAt).toBeTruthy();
    expect(state.queued.every((row) => row.startedAt === null)).toBe(true);
    expect(pmState.startOrder).toHaveLength(1);

    const idByEpic = new Map(state.rows.map((row) => [row.epicId, row.id]));

    // sessions/active shows all three, queued ones marked as such.
    const activeRes = await activeGet(
      mockNextRequest(),
      mockRouteContext({ projectId }),
    );
    const activeJson = await activeRes.json();
    expect(activeJson.data).toHaveLength(3);
    expect(
      activeJson.data.filter((a: { status: string }) => a.status === "queued"),
    ).toHaveLength(2);
    expect(
      activeJson.data.every((a: { startedAt: string | null }) => !!a.startedAt),
    ).toBe(true);

    // First CLI finishes -> second epic's session starts (FIFO).
    completeSession(idByEpic.get(epicIds[0])!);
    await vi.advanceTimersByTimeAsync(2500);

    state = sessionsByStatus(projectId);
    expect(state.completed.map((r) => r.epicId)).toEqual([epicIds[0]]);
    expect(state.running.map((r) => r.epicId)).toEqual([epicIds[1]]);
    expect(state.queued.map((r) => r.epicId)).toEqual([epicIds[2]]);

    // Second finishes -> third starts.
    completeSession(idByEpic.get(epicIds[1])!);
    await vi.advanceTimersByTimeAsync(2500);

    state = sessionsByStatus(projectId);
    expect(state.running.map((r) => r.epicId)).toEqual([epicIds[2]]);
    expect(state.queued).toHaveLength(0);

    // Third finishes -> everything terminal, spawn order was FIFO.
    completeSession(idByEpic.get(epicIds[2])!);
    await vi.advanceTimersByTimeAsync(2500);

    state = sessionsByStatus(projectId);
    expect(state.completed).toHaveLength(3);
    expect(pmState.startOrder).toEqual(epicIds.map((id) => idByEpic.get(id)));

    // Epics advanced to review as usual once their build completed.
    const epicRows = db
      .select()
      .from(epics)
      .where(eq(epics.projectId, projectId))
      .all();
    expect(epicRows.every((e) => e.status === "review")).toBe(true);
  });

  it("blocks a second dispatch for an epic whose session is still queued (409)", async () => {
    const { projectId, epicIds } = seedProject(2, 1);

    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "parallel" }),
      mockRouteContext({ projectId }),
    );
    expect(res.status).toBe(200);

    const state = sessionsByStatus(projectId);
    expect(state.queued).toHaveLength(1);
    const queuedEpicId = state.queued[0].epicId!;

    const conflictRes = await epicBuildPost(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId: queuedEpicId }),
    );
    const conflictJson = await conflictRes.json();
    expect(conflictRes.status).toBe(409);
    expect(conflictJson.code).toBe("AGENT_ALREADY_RUNNING");
    expect(conflictJson.data.activeSessionId).toBe(state.queued[0].id);
  });

  it("queues CI autofix as a normal visible build and de-duplicates its PR head", async () => {
    const { projectId, epicIds } = seedProject(2, 1);

    const occupyingResponse = await epicBuildPost(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId: epicIds[0] }),
    );
    expect(occupyingResponse.status).toBe(200);

    const persistedPrBranch = `feature/${epicIds[1]}-original-title`;
    db.update(epics)
      .set({
        title: "Renamed after opening the PR",
        branchName: persistedPrBranch,
      })
      .where(eq(epics.id, epicIds[1]))
      .run();
    // An unresolved review finding exists — a CI autofix must not inherit
    // the ordinary build's "address each one" rework block.
    db.insert(reviewComments)
      .values({
        id: `rc-${epicIds[1]}`,
        epicId: epicIds[1],
        filePath: "src/legacy.ts",
        lineNumber: 12,
        body: "Extract this duplicated logic.",
      })
      .run();
    vi.mocked(attachWorktree).mockClear();
    vi.mocked(createWorktree).mockClear();
    // The local branch already carries commits the PR head never ran.
    vi.mocked(resolveWorktreeHead).mockResolvedValue(
      "dddd000000000000000000000000000000000000",
    );
    const ciAutofix = {
      prNumber: 42,
      headSha: "abc123",
      failures: [{ name: "unit", logTail: "Expected 2, received 1" }],
    };
    const response = await epicBuildPost(
      mockJsonRequest({ pipeline: false, ciAutofix }),
      mockRouteContext({ projectId, epicId: epicIds[1] }),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.ciAutofix).toEqual({ launched: true });
    expect(json.data.pipeline).toBeNull();
    expect(attachWorktree).toHaveBeenCalledWith(
      "/repos/sched",
      persistedPrBranch,
    );
    expect(createWorktree).not.toHaveBeenCalled();

    let state = sessionsByStatus(projectId);
    const autofixRow = state.queued.find(
      (row) => row.id === json.data.sessionId,
    );
    expect(autofixRow).toMatchObject({
      epicId: epicIds[1],
      status: "queued",
      agentType: "build",
      batchRunId: `ci-autofix:${epicIds[1]}:pr-42:abc123`,
      branchName: persistedPrBranch,
      worktreePath: `/tmp/worktree-${persistedPrBranch.replace(/\//g, "-")}`,
    });
    expect(autofixRow?.prompt).toContain("### unit");
    expect(autofixRow?.prompt).toContain("Expected 2, received 1");
    expect(autofixRow?.prompt).toContain("ahead of the PR head");
    expect(autofixRow?.prompt).toContain("dddd000");
    expect(autofixRow?.prompt).toContain("smallest correct change");
    // The open finding must not leak into the autofix prompt as a trailing
    // rework instruction that overrides the narrowing above.
    expect(autofixRow?.prompt).not.toContain("Code Review Feedback");
    expect(autofixRow?.prompt).not.toContain("Extract this duplicated logic.");

    const activeResponse = await activeGet(
      mockNextRequest(),
      mockRouteContext({ projectId }),
    );
    const active = (await activeResponse.json()).data as Array<{ id: string }>;
    expect(active.some((session) => session.id === json.data.sessionId)).toBe(
      true,
    );

    const duplicateResponse = await epicBuildPost(
      mockJsonRequest({ pipeline: false, ciAutofix }),
      mockRouteContext({ projectId, epicId: epicIds[1] }),
    );
    expect(await duplicateResponse.json()).toMatchObject({
      data: {
        sessionId: json.data.sessionId,
        ciAutofix: { launched: false, reason: "already_attempted" },
      },
    });

    completeSession(state.running[0].id);
    await vi.advanceTimersByTimeAsync(2500);
    state = sessionsByStatus(projectId);
    expect(state.running.map((row) => row.id)).toContain(json.data.sessionId);

    completeSession(json.data.sessionId);
    await vi.advanceTimersByTimeAsync(2500);
    expect(
      sessionsByStatus(projectId).completed.map((row) => row.id),
    ).toContain(json.data.sessionId);
    const activity = db
      .select({ reason: ticketActivityLog.reason })
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicIds[1]))
      .all();
    expect(
      activity.some(
        (row) =>
          row.reason?.includes("CI autofix") &&
          row.reason.includes("unpushed fix") &&
          row.reason.includes("manual push"),
      ),
    ).toBe(true);
    const autofixNotification = db
      .select()
      .from(notifications)
      .where(eq(notifications.sessionId, json.data.sessionId))
      .all()
      .find((notification) => notification.agentType === "ci_autofix");
    expect(autofixNotification).toMatchObject({
      status: "completed",
      targetUrl: `/projects/${projectId}/sessions/${json.data.sessionId}`,
    });
    expect(autofixNotification?.title).toContain(
      `push ${persistedPrBranch} for PR #42`,
    );
  });

  it("keeps review feedback in an ordinary build prompt", async () => {
    const { projectId, epicIds } = seedProject(1);
    db.insert(reviewComments)
      .values({
        id: `rc-ord-${epicIds[0]}`,
        epicId: epicIds[0],
        filePath: "src/a.ts",
        lineNumber: 3,
        body: "Rename this variable.",
      })
      .run();

    const response = await epicBuildPost(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId: epicIds[0] }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();

    const state = sessionsByStatus(projectId);
    const row = [...state.queued, ...state.running].find(
      (candidate) => candidate.id === json.data.sessionId,
    );
    expect(row?.prompt).toContain("Code Review Feedback");
    expect(row?.prompt).toContain("Rename this variable.");
  });

  it("refuses CI autofix when the epic has no persisted PR branch", async () => {
    const { projectId, epicIds } = seedProject(1);

    const response = await epicBuildPost(
      mockJsonRequest({
        pipeline: false,
        ciAutofix: {
          prNumber: 42,
          headSha: "abc123",
          failures: [{ name: "unit", logTail: "failed" }],
        },
      }),
      mockRouteContext({ projectId, epicId: epicIds[0] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "CI autofix requires the epic's persisted pull request branch",
    });
    expect(sessionsByStatus(projectId).rows).toHaveLength(0);
    expect(attachWorktree).not.toHaveBeenCalled();
  });

  it("cancelling a queued session removes it from the queue and it never starts", async () => {
    const { projectId, epicIds } = seedProject(3, 1);

    await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "parallel" }),
      mockRouteContext({ projectId }),
    );

    let state = sessionsByStatus(projectId);
    const [firstQueued, secondQueued] = state.queued;

    const cancelRes = await sessionDelete(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ projectId, sessionId: firstQueued.id }),
    );
    expect(cancelRes.status).toBe(200);

    state = sessionsByStatus(projectId);
    expect(state.cancelled.map((r) => r.id)).toEqual([firstQueued.id]);
    expect(state.queued.map((r) => r.id)).toEqual([secondQueued.id]);

    // Free the slot: the cancelled session is skipped, the other queued one runs.
    completeSession(state.running[0].id);
    await vi.advanceTimersByTimeAsync(2500);

    state = sessionsByStatus(projectId);
    expect(state.running.map((r) => r.id)).toEqual([secondQueued.id]);
    expect(pmState.startOrder).not.toContain(firstQueued.id);

    completeSession(secondQueued.id);
    await vi.advanceTimersByTimeAsync(2500);
    expect(sessionsByStatus(projectId).completed).toHaveLength(2);
  });

  it("keeps the historical immediate-start behavior under the default budget", async () => {
    const { projectId, epicIds } = seedProject(3); // no setting -> default 3

    const res = await batchBuildPost(
      mockJsonRequest({ epicIds, mode: "parallel" }),
      mockRouteContext({ projectId }),
    );
    expect(res.status).toBe(200);

    const state = sessionsByStatus(projectId);
    expect(state.running).toHaveLength(3);
    expect(state.queued).toHaveLength(0);

    for (const row of state.running) completeSession(row.id);
    await vi.advanceTimersByTimeAsync(2500);
    expect(sessionsByStatus(projectId).completed).toHaveLength(3);
  });
});
