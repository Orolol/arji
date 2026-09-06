/**
 * Tests for the boot sweep that reconciles `qa_reports` rows stranded on
 * `running` by a dead server process, a rejected launch closure or a check
 * cancelled while still queued (lib/qa/boot-cleanup.ts), plus its wiring in
 * instrumentation.ts.
 *
 * Against the REAL migrated schema with `foreign_keys = ON` (createTestDb runs
 * the full migration chain), not hand-written DDL: the sweep's whole subject is
 * a LEFT JOIN across the `agent_session_id` FK, which is `ON DELETE SET NULL`,
 * and only the real schema carries that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { agentSessions, projects, qaReports } = await import("@/lib/db/schema");
const { checkStatusLabel, isCheckLive, QA_CHECK_INTERRUPTED_STATUS } =
  await import("@/lib/qa/aggregate");
const { reconcileStrandedQaReports, QA_CHECK_INTERRUPTED_SUMMARY } =
  await import("@/lib/qa/boot-cleanup");
const { resetBootCleanupGuard } = await import(
  "@/lib/agent-sessions/boot-cleanup"
);

let counter = 0;
const PROJECT_ID = "proj-qa-boot";

/**
 * One report + (optionally) its owning session.
 *
 * `sessionStatus: null` means the report carries no session id at all — the
 * shape a row takes once its session row is deleted, since the FK is
 * `ON DELETE SET NULL`.
 */
function seedReport(
  reportStatus: string,
  sessionStatus: string | null,
  extra: Record<string, unknown> = {},
) {
  counter += 1;
  const reportId = `qa-report-${counter}`;
  let sessionId: string | null = null;

  if (sessionStatus !== null) {
    sessionId = `qa-sess-${counter}`;
    db.insert(agentSessions)
      .values({
        id: sessionId,
        projectId: PROJECT_ID,
        status: sessionStatus,
        agentType: "tech_check",
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  db.insert(qaReports)
    .values({
      id: reportId,
      projectId: PROJECT_ID,
      status: reportStatus,
      agentSessionId: sessionId,
      checkType: "tech_check",
      createdAt: new Date().toISOString(),
      ...extra,
    })
    .run();

  return { reportId, sessionId };
}

function getReport(reportId: string) {
  return db.select().from(qaReports).where(eq(qaReports.id, reportId)).get();
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.delete(qaReports).run();
  db.delete(agentSessions).run();
  db.delete(projects).run();
  db.insert(projects)
    .values({ id: PROJECT_ID, name: "QA boot", gitRepoPath: "/repos/qa-boot" })
    .run();
  resetBootCleanupGuard();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("reconcileStrandedQaReports", () => {
  it("moves a report stranded by a dead session to the derived terminal status", () => {
    const { reportId } = seedReport("running", "failed");

    expect(reconcileStrandedQaReports()).toBe(1);

    const report = getReport(reportId);
    expect(report!.status).toBe(QA_CHECK_INTERRUPTED_STATUS);
    expect(report!.summary).toBe(QA_CHECK_INTERRUPTED_SUMMARY);
    expect(report!.completedAt).toBeTruthy();
    // No run wrote a report, so none is invented.
    expect(report!.reportContent).toBeNull();
  });

  it("writes exactly the word lib/qa/aggregate.ts already derives, and the reading is stable", () => {
    const { reportId, sessionId } = seedReport("running", "cancelled");

    // What the reader says BEFORE the sweep, from the two columns.
    const before = checkStatusLabel({
      status: "running",
      sessionStatus: "cancelled",
    });

    reconcileStrandedQaReports();

    const report = getReport(reportId);
    expect(report!.status).toBe(before);
    // …and it still reads the same afterwards: the sweep does not change what
    // /qa shows, it makes the column agree with it.
    expect(
      checkStatusLabel({ status: report!.status, sessionStatus: "cancelled" }),
    ).toBe(before);
    expect(
      isCheckLive({ status: report!.status, sessionStatus: "cancelled" }),
    ).toBe(false);
    expect(sessionId).toBeTruthy();
  });

  it("moves exactly one of a stranded row and a live row", () => {
    const stranded = seedReport("running", "failed");
    const live = seedReport("running", "running");

    expect(reconcileStrandedQaReports()).toBe(1);

    expect(getReport(stranded.reportId)!.status).toBe(
      QA_CHECK_INTERRUPTED_STATUS,
    );
    expect(getReport(live.reportId)!.status).toBe("running");
    expect(getReport(live.reportId)!.completedAt).toBeNull();
  });

  it("never touches a check whose session is still queued", () => {
    const { reportId } = seedReport("running", "queued");

    expect(reconcileStrandedQaReports()).toBe(0);
    expect(getReport(reportId)!.status).toBe("running");
  });

  it("reconciles a running report that carries no session id", () => {
    const { reportId } = seedReport("running", null);

    expect(reconcileStrandedQaReports()).toBe(1);
    expect(getReport(reportId)!.status).toBe(QA_CHECK_INTERRUPTED_STATUS);
  });

  it("reconciles a running report whose session row was deleted (FK set null)", () => {
    const { reportId, sessionId } = seedReport("running", "completed");
    db.delete(agentSessions).where(eq(agentSessions.id, sessionId!)).run();
    // The FK is ON DELETE SET NULL on the real schema — pin that we are
    // actually exercising the orphaned shape.
    expect(getReport(reportId)!.agentSessionId).toBeNull();

    expect(reconcileStrandedQaReports()).toBe(1);
    expect(getReport(reportId)!.status).toBe(QA_CHECK_INTERRUPTED_STATUS);
  });

  it("leaves reports that already reached a terminal status alone", () => {
    const completed = seedReport("completed", "completed", {
      summary: "All green",
      reportContent: "# Report",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    const failed = seedReport("failed", "failed", { summary: "Boom" });
    const cancelled = seedReport("cancelled", "cancelled");

    expect(reconcileStrandedQaReports()).toBe(0);

    expect(getReport(completed.reportId)!.status).toBe("completed");
    expect(getReport(completed.reportId)!.summary).toBe("All green");
    expect(getReport(failed.reportId)!.status).toBe("failed");
    expect(getReport(cancelled.reportId)!.status).toBe("cancelled");
  });

  it("is idempotent: a second run on the same database changes nothing", () => {
    const { reportId } = seedReport("running", "failed");

    expect(reconcileStrandedQaReports()).toBe(1);
    const afterFirst = getReport(reportId);

    expect(reconcileStrandedQaReports()).toBe(0);
    expect(getReport(reportId)).toEqual(afterFirst);
  });

  it("keeps a summary the run had already written", () => {
    const { reportId } = seedReport("running", "failed", {
      summary: "partial output",
    });

    reconcileStrandedQaReports();

    expect(getReport(reportId)!.summary).toBe("partial output");
    expect(getReport(reportId)!.status).toBe(QA_CHECK_INTERRUPTED_STATUS);
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

  it("reconciles stranded QA reports at boot, after the session sweeps", async () => {
    // A report whose session the boot sweep itself is about to fail: the QA
    // pass must run AFTER failOrphanedRunningSessions(), or the session still
    // reads as running and the report is skipped forever.
    const { reportId, sessionId } = seedReport("running", "running");
    process.env.NEXT_RUNTIME = "nodejs";

    const { register } = await import("@/instrumentation");
    await register();

    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId!))
        .get()!.status,
    ).toBe("failed");
    expect(getReport(reportId)!.status).toBe(QA_CHECK_INTERRUPTED_STATUS);

    const { getSessionWatchdog } = await import("@/lib/agents/watchdog");
    getSessionWatchdog().stop();
  });
});
