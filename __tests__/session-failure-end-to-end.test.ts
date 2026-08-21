/**
 * The failure story end to end, in-process:
 *
 * a build session whose provider exits non-zero WITHOUT stderr and WITHOUT
 * any captured output — the exact "Agent error" report — must end with
 *   1. a session row carrying an explicit, human error message (the history
 *      stays legible afterwards, AC3),
 *   2. a global notification that carries that same full message, not just
 *      a title (AC1), created by the terminal hook exactly the way
 *      instrumentation.ts composes it,
 *   3. an on-disk log record, so the Raw Logs tab is never empty (AC3),
 *   4. no duplicate notification when the dispatch route's own
 *      emitSessionFailed path lands afterwards (idempotency).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { eq } from "drizzle-orm";
import {
  agentSessions,
  notifications,
  projects,
} from "@/lib/db/schema";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<typeof import("@/lib/db/test-utils").createTestDb> | null,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
}));

// ---- Import the real modules AFTER the db mock is in place ----
import { markSessionCancelled, markSessionTerminal } from "@/lib/agent-sessions/lifecycle";
import { setSessionTerminalHook } from "@/lib/agent-sessions/terminal-hooks";
import { createTerminalSessionNotification } from "@/lib/agent-sessions/terminal-notification";
import { createNotificationFromSession } from "@/lib/notifications/create";

const tempDirs: string[] = [];

beforeEach(() => {
  testDb.instance = createTestDb();
  testDb.instance.db.insert(projects).values({ id: "p1", name: "My Project" }).run();
});

afterEach(() => {
  setSessionTerminalHook(null);
  testDb.instance = null;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function seedRunningBuildSession(logsPath: string | null): string {
  const id = "sess-silent-failure";
  testDb.instance!.db
    .insert(agentSessions)
    .values({
      id,
      projectId: "p1",
      status: "running",
      agentType: "build",
      provider: "claude-code",
      prompt: "Build the epic",
      logsPath,
      startedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

describe("silent agent failure — full story", () => {
  it("fails with an explicit message, notifies with it, keeps a log, and dedups the route path", () => {
    const { db, sqlite } = testDb.instance!;

    // The dispatch route's log write threw away because its result was
    // empty: simulate a logsPath whose file was never written.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-silent-fail-e2e-"));
    tempDirs.push(dir);
    const logsPath = path.join(dir, "logs.json");
    const sessionId = seedRunningBuildSession(logsPath);

    // instrumentation.ts composes exactly this hook at boot.
    setSessionTerminalHook(createTerminalSessionNotification);

    // The reported scenario: the provider exited non-zero with NO stderr
    // and the run captured no output at all.
    markSessionTerminal(
      sessionId,
      { success: false, error: null },
      new Date().toISOString()
    );

    // 1. The session history is legible afterwards: the row keeps an
    //    explicit error, never NULL, never a bare label.
    const row = db
      .select({ status: agentSessions.status, error: agentSessions.error })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get() as { status: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
    expect(row.error).toMatch(/failed without any error message and without any output/i);
    expect(row.error).toContain(logsPath);

    // 2. The terminal hook created the global notification, and it carries
    //    the SAME full message — the bell explains the failure.
    const notifs = db
      .select()
      .from(notifications)
      .where(eq(notifications.sessionId, sessionId))
      .all() as Array<{
      status: string;
      title: string;
      message: string | null;
      targetUrl: string;
    }>;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].status).toBe("failed");
    expect(notifs[0].title).toContain("Build failed");
    expect(notifs[0].message).toBe(row.error);
    expect(notifs[0].targetUrl).toBe(`/projects/p1/sessions/${sessionId}`);

    // 3. Traceability: the session's log record exists even though nobody
    //    ever wrote it (the backstop filled it in at finalization).
    expect(fs.existsSync(logsPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(logsPath, "utf-8"));
    expect(record.success).toBe(false);
    expect(record.error).toBe(row.error);

    // 4. The dispatch route's emitSessionFailed lands afterwards — the
    //    per-session idempotency guard keeps the bell from duplicating.
    createNotificationFromSession(sessionId);
    const still = sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM notifications WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    expect(still.cnt).toBe(1);
  });

  it("notifies with the real stderr when the provider DID produce an error line", () => {
    const { db } = testDb.instance!;
    const sessionId = seedRunningBuildSession(null);

    setSessionTerminalHook(createTerminalSessionNotification);

    markSessionTerminal(
      sessionId,
      { success: false, error: "Claude CLI exited with code 1: Invalid API key" },
      new Date().toISOString()
    );

    const notifs = db
      .select()
      .from(notifications)
      .where(eq(notifications.sessionId, sessionId))
      .all() as Array<{ message: string | null }>;
    expect(notifs).toHaveLength(1);
    // A real error stays the message — synthesis only fills the void.
    expect(notifs[0].message).toBe("Claude CLI exited with code 1: Invalid API key");
  });

  it("leaves cancelled sessions without a failure notification", () => {
    const { db } = testDb.instance!;
    const sessionId = seedRunningBuildSession(null);

    setSessionTerminalHook(createTerminalSessionNotification);

    // User-initiated stop: terminal, but not an alarm.
    markSessionCancelled(sessionId);

    const notifs = db
      .select()
      .from(notifications)
      .where(eq(notifications.sessionId, sessionId))
      .all();
    expect(notifs).toHaveLength(0);
  });
});