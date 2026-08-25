/**
 * Tests for the boot sweep that cancels agent sessions orphaned in 'queued'
 * by a dead server process (lib/agent-sessions/boot-cleanup.ts), plus its
 * wiring in instrumentation.ts, against the real migrated schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db, ensureDbReady } = await import("@/lib/db");
const {
  agentSessions,
  epics,
  projects,
  ticketActivityLog,
  userStories,
} = await import("@/lib/db/schema");
const {
  cancelOrphanedQueuedSessions,
  failOrphanedRunningSessions,
  resetBootCleanupGuard,
  ORPHANED_BY_RESTART_REASON,
} = await import("@/lib/agent-sessions/boot-cleanup");

let counter = 0;

function seedSession(status: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  const projectId = `proj-boot-${counter}`;
  const sessionId = `sess-boot-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Boot", gitRepoPath: "/repos/boot" })
    .run();
  db.insert(agentSessions)
    .values({
      id: sessionId,
      projectId,
      status,
      createdAt: new Date().toISOString(),
      ...extra,
    })
    .run();
  return sessionId;
}

function getSession(sessionId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(agentSessions).run();
  // The sweeps run at most once per process; each test is its own "boot".
  resetBootCleanupGuard();
});

describe("cancelOrphanedQueuedSessions", () => {
  it("cancels queued sessions with the orphaned-by-restart reason", () => {
    const queuedId = seedSession("queued");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const cancelled = cancelOrphanedQueuedSessions();
    logSpy.mockRestore();

    expect(cancelled).toBe(1);
    const session = getSession(queuedId);
    expect(session).toMatchObject({
      status: "cancelled",
      error: ORPHANED_BY_RESTART_REASON,
    });
    expect(session!.endedAt).toBeTruthy();
    expect(session!.completedAt).toBeTruthy();
    // Cancellation is not a delivery verdict — outcome stays unclassified.
    expect(session!.outcome).toBeNull();
  });

  it("leaves running and terminal sessions untouched", () => {
    const runningId = seedSession("running", {
      startedAt: new Date().toISOString(),
    });
    const completedId = seedSession("completed");
    const failedId = seedSession("failed", { error: "boom" });
    const cancelledId = seedSession("cancelled", { error: "user" });

    const cancelled = cancelOrphanedQueuedSessions();

    expect(cancelled).toBe(0);
    expect(getSession(runningId)!.status).toBe("running");
    expect(getSession(completedId)!.status).toBe("completed");
    expect(getSession(failedId)!.status).toBe("failed");
    expect(getSession(cancelledId)!.error).toBe("user");
  });

  it("sweeps multiple orphans and returns the count", () => {
    const ids = [
      seedSession("queued"),
      seedSession("queued"),
      seedSession("running", { startedAt: new Date().toISOString() }),
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(cancelOrphanedQueuedSessions()).toBe(2);
    logSpy.mockRestore();

    expect(getSession(ids[0])!.status).toBe("cancelled");
    expect(getSession(ids[1])!.status).toBe("cancelled");
    expect(getSession(ids[2])!.status).toBe("running");
  });

  it("is a no-op on an empty table", () => {
    expect(cancelOrphanedQueuedSessions()).toBe(0);
  });
});

describe("once-per-process guard", () => {
  it("does not re-sweep queued sessions enqueued after the boot sweep", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    seedSession("queued");
    expect(cancelOrphanedQueuedSessions()).toBe(1);

    // A live request queues a session after boot — a second sweep would
    // cancel it as "orphaned by restart".
    const liveId = seedSession("queued");
    expect(cancelOrphanedQueuedSessions()).toBe(0);
    logSpy.mockRestore();

    expect(getSession(liveId)!.status).toBe("queued");
  });

  it("does not re-fail running sessions started after the boot sweep", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    seedSession("running", { startedAt: new Date().toISOString() });
    expect(failOrphanedRunningSessions()).toBe(1);

    const liveId = seedSession("running", {
      startedAt: new Date().toISOString(),
    });
    expect(failOrphanedRunningSessions()).toBe(0);
    logSpy.mockRestore();

    expect(getSession(liveId)!.status).toBe("running");
  });

  it("guards the two sweeps independently", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    seedSession("queued");
    seedSession("running", { startedAt: new Date().toISOString() });

    expect(cancelOrphanedQueuedSessions()).toBe(1);
    // The running sweep has not run yet — its own flag is still unset.
    expect(failOrphanedRunningSessions()).toBe(1);
    logSpy.mockRestore();
  });
});

describe("failOrphanedRunningSessions — mid-run promotion rollback", () => {
  // The owning-session exemption lets a live build promote its own ticket
  // to Review. If the server dies before the in-process terminal handler
  // runs, the sweep is the last place that can undo that promotion —
  // Full Auto starts in the same boot and would otherwise pick the
  // orphaned review ticket up as a review-and-merge candidate.

  function seedTicket(epicStatus: string, storyStatuses: string[] = []) {
    counter += 1;
    const projectId = `proj-pull-${counter}`;
    const epicId = `epic-pull-${counter}`;
    db.insert(projects)
      .values({ id: projectId, name: "Pull", gitRepoPath: "/repos/pull" })
      .run();
    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Promoted by a dead build",
        status: epicStatus,
        type: "feature",
        position: 0,
      })
      .run();
    const storyIds = storyStatuses.map((storyStatus, index) => {
      const id = `story-pull-${counter}-${index + 1}`;
      db.insert(userStories)
        .values({ id, epicId, title: `Story ${index + 1}`, status: storyStatus })
        .run();
      return id;
    });
    return { projectId, epicId, storyIds };
  }

  function seedZombie(session: {
    projectId: string;
    epicId?: string;
    userStoryId?: string;
    agentType: string;
  }) {
    counter += 1;
    const sessionId = `sess-pull-${counter}`;
    db.insert(agentSessions)
      .values({
        id: sessionId,
        projectId: session.projectId,
        epicId: session.epicId ?? null,
        userStoryId: session.userStoryId ?? null,
        status: "running",
        agentType: session.agentType,
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();
    return sessionId;
  }

  function epicStatus(epicId: string) {
    return db.select().from(epics).where(eq(epics.id, epicId)).get()?.status;
  }

  function storyStatus(storyId: string) {
    return db
      .select()
      .from(userStories)
      .where(eq(userStories.id, storyId))
      .get()?.status;
  }

  function epicActivity(epicId: string) {
    return db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
  }

  it("pulls a zombie build's epic back out of review and logs it", () => {
    const { projectId, epicId } = seedTicket("review");
    const sessionId = seedZombie({ projectId, epicId, agentType: "build" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const failed = failOrphanedRunningSessions();
    logSpy.mockRestore();

    expect(failed).toBe(1);
    expect(getSession(sessionId)!.status).toBe("failed");
    expect(epicStatus(epicId)).toBe("in_progress");

    // The rollback is audited on the epic's activity feed, naming the
    // restart — no silent board write.
    expect(epicActivity(epicId)).toContainEqual(
      expect.objectContaining({
        fromStatus: "review",
        toStatus: "in_progress",
        actor: "agent",
        sessionId,
        reason: expect.stringContaining("orphaned by restart"),
      })
    );
  });

  it("pulls a zombie story build's story back without touching the epic", () => {
    const { projectId, epicId, storyIds } = seedTicket("in_progress", [
      "review",
      "todo",
    ]);
    const sessionId = seedZombie({
      projectId,
      epicId,
      userStoryId: storyIds[0],
      agentType: "ticket_build",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const failed = failOrphanedRunningSessions();
    logSpy.mockRestore();

    expect(failed).toBe(1);
    expect(getSession(sessionId)!.status).toBe("failed");
    // The story comes back; the epic and its sibling never move — epic
    // promotion belongs to the sibling-story rule, which the sweep never
    // runs.
    expect(storyStatus(storyIds[0])).toBe("in_progress");
    expect(storyStatus(storyIds[1])).toBe("todo");
    expect(epicStatus(epicId)).toBe("in_progress");
  });

  it("fails a zombie whose ticket never left in_progress without a board write", () => {
    // No promotion to undo: the session is marked failed, but the epic
    // keeps its status and no activity row is written.
    const { projectId, epicId } = seedTicket("in_progress");
    const sessionId = seedZombie({ projectId, epicId, agentType: "build" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const failed = failOrphanedRunningSessions();
    logSpy.mockRestore();

    expect(failed).toBe(1);
    expect(getSession(sessionId)!.status).toBe("failed");
    expect(epicStatus(epicId)).toBe("in_progress");
    expect(epicActivity(epicId)).toHaveLength(0);
  });

  it("does not touch the board for a non-code-producing zombie", () => {
    // A live reviewer on a review epic is expected; the sweep fails the
    // session but must not demote the epic on its behalf.
    const { projectId, epicId } = seedTicket("review");
    const sessionId = seedZombie({ projectId, epicId, agentType: "review_code" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const failed = failOrphanedRunningSessions();
    logSpy.mockRestore();

    expect(failed).toBe(1);
    expect(getSession(sessionId)!.status).toBe("failed");
    expect(epicStatus(epicId)).toBe("review");
    expect(epicActivity(epicId)).toHaveLength(0);
  });
});

describe("instrumentation register()", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  afterEach(() => {
    if (originalRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalRuntime;
    }
  });

  it("readies the db then sweeps orphaned queued sessions on the nodejs runtime", async () => {
    const queuedId = seedSession("queued");
    process.env.NEXT_RUNTIME = "nodejs";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { register } = await import("@/instrumentation");
    await register();
    logSpy.mockRestore();

    expect(ensureDbReady).toHaveBeenCalled();
    expect(getSession(queuedId)).toMatchObject({
      status: "cancelled",
      error: ORPHANED_BY_RESTART_REASON,
    });

    // The silent-session watchdog boots alongside the sweep; repeat
    // registrations (dev hot reload) reuse the same ticking singleton.
    const { getSessionWatchdog } = await import("@/lib/agents/watchdog");
    const watchdog = getSessionWatchdog();
    expect(watchdog.isRunning).toBe(true);

    // A second register() in the same process must not sweep again: these
    // rows belong to live requests, not to a dead predecessor.
    const liveQueuedId = seedSession("queued");
    const liveRunningId = seedSession("running", {
      startedAt: new Date().toISOString(),
    });
    await register();
    expect(getSessionWatchdog()).toBe(watchdog);
    expect(watchdog.isRunning).toBe(true);
    expect(getSession(liveQueuedId)!.status).toBe("queued");
    expect(getSession(liveRunningId)!.status).toBe("running");
    watchdog.stop();
  });

  it("does nothing outside the nodejs runtime", async () => {
    const queuedId = seedSession("queued");
    process.env.NEXT_RUNTIME = "edge";

    const { register } = await import("@/instrumentation");
    await register();

    expect(getSession(queuedId)!.status).toBe("queued");
  });
});
