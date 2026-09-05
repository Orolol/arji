/**
 * Silent-session watchdog (lib/agents/watchdog.ts) against the real migrated
 * schema (createTestDb):
 *
 *   - detection: a running session whose newest chunk is older than the
 *     threshold gets one notification + one system activity-log hold entry,
 *   - freshness: recent chunks (or recent spawn with no chunks) stay quiet,
 *   - dedupe: a session notifies at most once, and the memory of it is
 *     pruned once the session leaves 'running',
 *   - thresholds: `watchdog_threshold_minutes` global + per-agent-type
 *     override, re-read on every sweep,
 *   - exemptions: chat sessions and non-running sessions are never flagged,
 *   - interval plumbing: idempotent start(), fake-timer sweeps, and the
 *     globalThis-backed singleton.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const {
  projects,
  epics,
  agentSessions,
  notifications,
  ticketActivityLog,
  settings,
} = await import("@/lib/db/schema");
const { appendSessionChunk } = await import("@/lib/agent-sessions/chunks");
const {
  SessionWatchdog,
  WATCHDOG_SWEEP_INTERVAL_MS,
  buildStalledReason,
  getSessionLastActivityAt,
  getSessionWatchdog,
  isSessionStale,
  resolveWatchdogThresholdMinutes,
  startSessionWatchdog,
} = await import("@/lib/agents/watchdog");

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** ISO timestamp `minutes` before NOW. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

let counter = 0;

function seedSession(options: {
  status?: string;
  agentType?: string | null;
  startedAt?: string | null;
  withEpic?: boolean;
  epicStatus?: string;
}): { sessionId: string; projectId: string; epicId: string | null } {
  counter += 1;
  const projectId = `proj-wd-${counter}`;
  const sessionId = `sess-wd-${counter}`;
  const withEpic = options.withEpic ?? true;
  const epicId = withEpic ? `epic-wd-${counter}` : null;

  db.insert(projects)
    .values({ id: projectId, name: "Watchdog", gitRepoPath: "/repos/wd" })
    .run();

  if (epicId) {
    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: `Epic ${counter}`,
        status: options.epicStatus ?? "in_progress",
        position: 0,
        readableId: `E-wd-${counter}`,
      })
      .run();
  }

  db.insert(agentSessions)
    .values({
      id: sessionId,
      projectId,
      epicId,
      status: options.status ?? "running",
      agentType: options.agentType === undefined ? "build" : options.agentType,
      startedAt:
        options.startedAt === undefined ? minutesAgo(30) : options.startedAt,
      createdAt: minutesAgo(31),
    })
    .run();

  return { sessionId, projectId, epicId };
}

function seedChunk(sessionId: string, createdAt: string): void {
  appendSessionChunk({
    sessionId,
    streamType: "output",
    // Timestamped so successive chunks differ: a keyless chunk repeating
    // earlier content is deduped, and the watchdog reads the NEWEST chunk.
    content: `some agent output at ${createdAt}`,
    createdAt,
  });
}

function notificationsFor(sessionId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.sessionId, sessionId))
    .all();
}

function activityFor(epicId: string) {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, epicId))
    .all();
}

function setSetting(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value) },
    })
    .run();
}

beforeEach(() => {
  // The in-memory DB is shared across this file's tests; each test seeds
  // its own world. Chunks/sequences cascade from agentSessions.
  db.delete(settings).run();
  db.delete(ticketActivityLog).run();
  db.delete(notifications).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
});

describe("SessionWatchdog.sweep detection", () => {
  it("flags a running session whose newest chunk crossed the threshold", () => {
    const { sessionId, epicId } = seedSession({});
    seedChunk(sessionId, minutesAgo(10));
    seedChunk(sessionId, minutesAgo(6)); // newest chunk wins

    const watchdog = new SessionWatchdog();
    const flagged = watchdog.sweep(NOW);

    expect(flagged).toEqual([
      { sessionId, projectId: expect.any(String), epicId, staleMinutes: 6 },
    ]);

    const notifs = notificationsFor(sessionId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      status: "failed",
      agentType: "build",
      title: `Agent seems stalled on E-wd-${counter}: Epic ${counter} — no output for 6m`,
    });
    expect(notifs[0].targetUrl).toBe(
      `/projects/${notifs[0].projectId}/sessions/${sessionId}`
    );

    const log = activityFor(epicId!);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actor: "system",
      fromStatus: "in_progress",
      toStatus: "in_progress",
      reason: buildStalledReason(6),
      sessionId,
    });
  });

  it("stays quiet while chunks are fresh", () => {
    const { sessionId } = seedSession({});
    seedChunk(sessionId, minutesAgo(1));

    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toEqual([]);
    expect(notificationsFor(sessionId)).toHaveLength(0);
  });

  it("falls back to startedAt for sessions that never emitted a chunk", () => {
    const { sessionId } = seedSession({ startedAt: minutesAgo(7) });

    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ sessionId, staleMinutes: 7 });
  });

  it("skips queued and terminal sessions", () => {
    const queued = seedSession({ status: "queued", startedAt: null });
    const completed = seedSession({ status: "completed" });

    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toEqual([]);
    expect(notificationsFor(queued.sessionId)).toHaveLength(0);
    expect(notificationsFor(completed.sessionId)).toHaveLength(0);
  });

  it("exempts chat sessions no matter how silent they are", () => {
    const { sessionId } = seedSession({
      agentType: "chat",
      startedAt: minutesAgo(120),
    });

    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toEqual([]);
    expect(notificationsFor(sessionId)).toHaveLength(0);
  });

  it("watches grading sessions and classifies their stalled notification", () => {
    const { sessionId, epicId } = seedSession({
      agentType: "grading",
      epicStatus: "review",
      startedAt: minutesAgo(8),
    });

    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toHaveLength(1);
    expect(notificationsFor(sessionId)[0]).toMatchObject({
      agentType: "grading",
      title: `Agent seems stalled on E-wd-${counter}: Epic ${counter} — no output for 8m`,
    });
    expect(activityFor(epicId!)[0]).toMatchObject({
      fromStatus: "review",
      toStatus: "review",
      sessionId,
    });
  });

  it("notifies without an activity-log entry for epic-less sessions", () => {
    const { sessionId } = seedSession({
      withEpic: false,
      agentType: "team_build",
      startedAt: minutesAgo(9),
    });

    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toHaveLength(1);
    const notifs = notificationsFor(sessionId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe("Agent seems stalled — no output for 9m");
    expect(db.select().from(ticketActivityLog).all()).toHaveLength(0);
  });
});

describe("SessionWatchdog dedupe", () => {
  it("notifies a session at most once across sweeps", () => {
    const { sessionId, epicId } = seedSession({ startedAt: minutesAgo(20) });

    const watchdog = new SessionWatchdog();
    expect(watchdog.sweep(NOW)).toHaveLength(1);
    expect(watchdog.sweep(new Date(NOW.getTime() + 60_000))).toEqual([]);
    expect(
      watchdog.sweep(new Date(NOW.getTime() + 10 * 60_000))
    ).toEqual([]);

    expect(notificationsFor(sessionId)).toHaveLength(1);
    expect(activityFor(epicId!)).toHaveLength(1);
    expect(watchdog.hasNotified(sessionId)).toBe(true);
  });

  it("prunes the dedupe memory once a session leaves running", () => {
    const { sessionId } = seedSession({ startedAt: minutesAgo(20) });

    const watchdog = new SessionWatchdog();
    watchdog.sweep(NOW);
    expect(watchdog.hasNotified(sessionId)).toBe(true);

    db.update(agentSessions)
      .set({ status: "completed" })
      .where(eq(agentSessions.id, sessionId))
      .run();
    watchdog.sweep(new Date(NOW.getTime() + 60_000));

    expect(watchdog.hasNotified(sessionId)).toBe(false);
    // ...and the terminal session was of course not re-flagged.
    expect(notificationsFor(sessionId)).toHaveLength(1);
  });
});

describe("threshold settings", () => {
  it("defaults to 5 minutes", () => {
    expect(resolveWatchdogThresholdMinutes("build")).toBe(5);
    // 4m59s silent: fine. 5m: stale.
    expect(isSessionStale(minutesAgo(4), "build", NOW)).toBe(false);
    expect(isSessionStale(minutesAgo(5), "build", NOW)).toBe(true);
  });

  it("treats SQLite timestamps as UTC on a non-UTC host", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "Europe/Paris";
    try {
      // 11:58 UTC is only two minutes before NOW. Parsing the space form as
      // Paris local time would incorrectly make it more than two hours old.
      expect(isSessionStale("2026-08-16 11:58:00", "build", NOW)).toBe(false);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("honors the global setting", () => {
    setSetting("watchdog_threshold_minutes", 2);

    const { sessionId } = seedSession({ startedAt: minutesAgo(3) });
    const flagged = new SessionWatchdog().sweep(NOW);

    expect(flagged).toHaveLength(1);
    expect(flagged[0].sessionId).toBe(sessionId);
  });

  it("lets a per-agent-type key override the global one", () => {
    setSetting("watchdog_threshold_minutes", 2);
    setSetting("watchdog_threshold_minutes:build", 60);

    seedSession({ agentType: "build", startedAt: minutesAgo(10) });
    const flaggedBuild = new SessionWatchdog().sweep(NOW);
    expect(flaggedBuild).toEqual([]); // 10m < 60m build override

    const merge = seedSession({ agentType: "merge", startedAt: minutesAgo(10) });
    const flaggedMerge = new SessionWatchdog().sweep(NOW);
    expect(flaggedMerge).toHaveLength(1); // merge falls back to global 2m
    expect(flaggedMerge[0].sessionId).toBe(merge.sessionId);
  });

  it("ignores invalid setting values and falls through", () => {
    setSetting("watchdog_threshold_minutes", "not-a-number");
    expect(resolveWatchdogThresholdMinutes("build")).toBe(5);

    setSetting("watchdog_threshold_minutes", -3);
    expect(resolveWatchdogThresholdMinutes("build")).toBe(5);
  });
});

describe("getSessionLastActivityAt", () => {
  it("prefers the newest chunk, then startedAt, then createdAt", () => {
    const { sessionId } = seedSession({ startedAt: minutesAgo(30) });
    expect(
      getSessionLastActivityAt({
        id: sessionId,
        startedAt: minutesAgo(30),
        createdAt: minutesAgo(31),
      })
    ).toBe(minutesAgo(30));

    seedChunk(sessionId, minutesAgo(3));
    expect(
      getSessionLastActivityAt({
        id: sessionId,
        startedAt: minutesAgo(30),
        createdAt: minutesAgo(31),
      })
    ).toBe(minutesAgo(3));

    expect(
      getSessionLastActivityAt({
        id: "sess-untracked",
        startedAt: null,
        createdAt: minutesAgo(2),
      })
    ).toBe(minutesAgo(2));
  });
});

describe("interval plumbing", () => {
  afterEach(() => {
    getSessionWatchdog().stop();
    vi.useRealTimers();
  });

  it("start() is idempotent and stop() halts the interval", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    const watchdog = new SessionWatchdog();
    watchdog.start();
    watchdog.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(watchdog.isRunning).toBe(true);

    watchdog.stop();
    expect(watchdog.isRunning).toBe(false);
    setIntervalSpy.mockRestore();
  });

  it("sweeps on the interval under fake timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { sessionId } = seedSession({ startedAt: minutesAgo(20) });

    const watchdog = new SessionWatchdog();
    watchdog.start();
    expect(notificationsFor(sessionId)).toHaveLength(0);

    vi.advanceTimersByTime(WATCHDOG_SWEEP_INTERVAL_MS);
    expect(notificationsFor(sessionId)).toHaveLength(1);

    // Later ticks stay deduped.
    vi.advanceTimersByTime(WATCHDOG_SWEEP_INTERVAL_MS * 3);
    expect(notificationsFor(sessionId)).toHaveLength(1);

    watchdog.stop();
  });

  it("startSessionWatchdog reuses the globalThis singleton", () => {
    const first = startSessionWatchdog();
    const second = startSessionWatchdog();

    expect(second).toBe(first);
    expect(getSessionWatchdog()).toBe(first);
    expect(first.isRunning).toBe(true);

    first.stop();
  });
});
