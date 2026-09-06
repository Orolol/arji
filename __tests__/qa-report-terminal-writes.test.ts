/**
 * Route-level tests for the two REQUEST-TIME paths that skip the QA check's
 * closure tail and used to strand `qa_reports.status` on `running` forever.
 *
 * `lib/qa/boot-cleanup.ts` covers the third path (a server restart mid-check)
 * and, being a boot sweep, is also the only thing that ever settled these two —
 * on the NEXT restart, which for a long-lived dev server is never. These tests
 * pin the write happening in the request that observed the failure instead.
 *
 * Against the REAL migrated schema with `foreign_keys = ON` and the REAL
 * session lifecycle: the subject is a persisted column, and a chain mock would
 * only prove that some `.set()` was called with the right object. The provider
 * boundary (`processManager`) is the one thing stubbed — a launch that rejects
 * is precisely what cannot be arranged with a real CLI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const mockCreateId = vi.hoisted(() => vi.fn());
const mockProcessManager = vi.hoisted(() => ({
  start: vi.fn(),
  getStatus: vi.fn(() => null),
  cancel: vi.fn(() => true),
}));

vi.mock("@/lib/utils/nanoid", () => ({ createId: mockCreateId }));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: mockProcessManager,
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildTechCheckPrompt: vi.fn(() => "TECH_CHECK_PROMPT"),
  buildE2eTestPrompt: vi.fn(() => "E2E_TEST_PROMPT"),
  buildFailureDigestPrompt: vi.fn(() => "FAILURE_DIGEST_PROMPT"),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn(async () => "System prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    model: "claude-opus-4-1",
  })),
}));

vi.mock("@/lib/telescope/collect", () => ({
  collectFailureDigestEvidence: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

/**
 * The REAL scheduler by default — the launch path under test is its
 * submit-and-start behaviour, and a stub would prove nothing about it. One test
 * flips `captureLaunch` on to intercept the closure instead of running it,
 * which is the only way to observe the closure's own tick from outside.
 */
const scheduler = vi.hoisted(() => ({
  captureLaunch: null as null | ((launch: () => Promise<void>) => void),
}));

vi.mock("@/lib/agents/scheduler", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agents/scheduler")>();
  return {
    ...actual,
    agentScheduler: {
      submit: (
        projectId: string,
        sessionId: string,
        launch: () => Promise<void>,
      ) => {
        if (scheduler.captureLaunch) {
          scheduler.captureLaunch(launch);
          return { started: false, queuedAhead: 0 };
        }
        return actual.agentScheduler.submit(projectId, sessionId, launch);
      },
      remove: (sessionId: string) => actual.agentScheduler.remove(sessionId),
    },
  };
});

// One mock for both consumers: the route's logs-dir creation and the
// lifecycle's missing-log backfill. `existsSync: true` short-circuits the
// latter so no test writes to `data/`.
vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  },
}));

const { db } = await import("@/lib/db");
const { agentSessions, projects, qaReports } = await import("@/lib/db/schema");

const PROJECT_ID = "proj-qa-terminal";
let counter = 0;

function getReport(reportId: string) {
  return db.select().from(qaReports).where(eq(qaReports.id, reportId)).get();
}

function getSession(sessionId: string) {
  return db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
}

beforeEach(() => {
  vi.clearAllMocks();
  scheduler.captureLaunch = null;
  mockProcessManager.getStatus.mockReturnValue(null);
  mockProcessManager.cancel.mockReturnValue(true);
  db.delete(qaReports).run();
  db.delete(agentSessions).run();
  db.delete(projects).run();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Arij",
      gitRepoPath: "/tmp/repo",
      createdAt: new Date().toISOString(),
    })
    .run();
});

describe("QA check launch closure that rejects", () => {
  it("writes a terminal failed status carrying the error before the request returns", async () => {
    counter += 1;
    const sessionId = `qa-launch-sess-${counter}`;
    const reportId = `qa-launch-report-${counter}`;
    mockCreateId.mockReset().mockReturnValueOnce(sessionId).mockReturnValueOnce(reportId);
    mockProcessManager.start.mockImplementation(() => {
      throw new Error("claude CLI not found on PATH");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/projects/[projectId]/qa/check/route");
    const res = await POST(
      mockJsonRequest({ checkType: "tech_check" }),
      mockRouteContext({ projectId: PROJECT_ID }),
    );

    expect(res.status).toBe(200);

    // The row is already terminal when the response is handed back — no second
    // request, no restart, no timer advanced. (This assertion does not
    // discriminate at MICROTASK granularity; the test below does.)
    const report = getReport(reportId);
    expect(report?.status).toBe("failed");
    expect(report?.summary).toContain("claude CLI not found on PATH");
    expect(report?.completedAt).toBeTruthy();
    // A report that was never written is not invented.
    expect(report?.reportContent).toBeNull();

    consoleError.mockRestore();
  });

  /**
   * The AC's "before the request returns", pinned at the only granularity that
   * can discriminate it: the closure's OWN tick.
   *
   * Spawning is synchronous, so the launch failure that actually happens (a
   * missing CLI, a vanished worktree) is a synchronous throw. The route's
   * prologue is therefore deliberately not wrapped in `async` — an `async`
   * wrapper would defer the catch to a microtask and leave the row `running`
   * for the rest of the request. Capturing the closure and calling it by hand
   * is what makes that difference visible: with the prologue as written the
   * call throws and the row is terminal on the next line; wrap it in `async`
   * and the call returns a pending promise instead, failing this test.
   */
  it("settles the report inside the launch closure's own synchronous tick", async () => {
    counter += 1;
    const sessionId = `qa-sync-sess-${counter}`;
    const reportId = `qa-sync-report-${counter}`;
    mockCreateId.mockReset().mockReturnValueOnce(sessionId).mockReturnValueOnce(reportId);
    mockProcessManager.start.mockImplementation(() => {
      throw new Error("worktree is gone");
    });

    let captured: (() => Promise<void>) | null = null;
    scheduler.captureLaunch = (launch) => {
      captured = launch;
    };

    const { POST } = await import("@/app/api/projects/[projectId]/qa/check/route");
    await POST(
      mockJsonRequest({ checkType: "tech_check" }),
      mockRouteContext({ projectId: PROJECT_ID }),
    );

    // Not started yet: the report is exactly as the route inserted it.
    expect(getReport(reportId)?.status).toBe("running");

    const launch = captured as unknown as () => Promise<void>;
    expect(launch).toBeTypeOf("function");
    expect(() => launch()).toThrow("worktree is gone");

    // Same tick as the throw, no await in between.
    expect(getReport(reportId)?.status).toBe("failed");
    expect(getReport(reportId)?.summary).toContain("worktree is gone");
  });

  it("keeps a partial summary the run already recorded", async () => {
    counter += 1;
    const reportId = `qa-partial-report-${counter}`;
    db.insert(qaReports)
      .values({
        id: reportId,
        projectId: PROJECT_ID,
        status: "running",
        checkType: "tech_check",
        summary: "Reached step 3 of 7.",
        createdAt: new Date().toISOString(),
      })
      .run();

    const { failQaReportLaunch } = await import("@/lib/qa/report-lifecycle");
    expect(failQaReportLaunch(reportId, new Error("boom"))).toBe(true);

    const report = getReport(reportId);
    expect(report?.status).toBe("failed");
    // The canned sentence is a fallback for "no summary at all", never an
    // overwrite of evidence the run actually produced.
    expect(report?.summary).toBe("Reached step 3 of 7.");
  });

  it("clips an unbounded error message to the shared summary ceiling", async () => {
    counter += 1;
    const reportId = `qa-clip-report-${counter}`;
    db.insert(qaReports)
      .values({
        id: reportId,
        projectId: PROJECT_ID,
        status: "running",
        checkType: "tech_check",
        createdAt: new Date().toISOString(),
      })
      .run();

    const { failQaReportLaunch, QA_REPORT_SUMMARY_MAX_CHARS } = await import(
      "@/lib/qa/report-lifecycle"
    );
    failQaReportLaunch(reportId, new Error("x".repeat(5000)));

    expect(getReport(reportId)?.summary?.length).toBe(QA_REPORT_SUMMARY_MAX_CHARS);
  });

  it("refuses to move a report that is no longer running", async () => {
    counter += 1;
    const reportId = `qa-cas-report-${counter}`;
    db.insert(qaReports)
      .values({
        id: reportId,
        projectId: PROJECT_ID,
        status: "completed",
        checkType: "tech_check",
        summary: "All good.",
        createdAt: new Date().toISOString(),
      })
      .run();

    const { failQaReportLaunch } = await import("@/lib/qa/report-lifecycle");
    expect(failQaReportLaunch(reportId, new Error("boom"))).toBe(false);
    expect(getReport(reportId)?.status).toBe("completed");
  });
});

describe("cancelling a QA check that is still queued", () => {
  it("writes a terminal cancelled status on the report row", async () => {
    counter += 1;
    const sessionId = `qa-cancel-sess-${counter}`;
    const reportId = `qa-cancel-report-${counter}`;
    const now = new Date().toISOString();

    db.insert(agentSessions)
      .values({
        id: sessionId,
        projectId: PROJECT_ID,
        status: "queued",
        agentType: "tech_check",
        createdAt: now,
      })
      .run();
    db.insert(qaReports)
      .values({
        id: reportId,
        projectId: PROJECT_ID,
        status: "running",
        agentSessionId: sessionId,
        checkType: "tech_check",
        createdAt: now,
      })
      .run();

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );
    const res = await DELETE(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ projectId: PROJECT_ID, sessionId }),
    );

    expect(res.status).toBe(200);
    expect(getSession(sessionId)?.status).toBe("cancelled");

    const report = getReport(reportId);
    expect(report?.status).toBe("cancelled");
    expect(report?.completedAt).toBeTruthy();
    expect(report?.reportContent).toBeNull();
  });

  it("leaves reports owned by another session alone", async () => {
    counter += 1;
    const sessionId = `qa-cancel-sess-${counter}`;
    const otherSessionId = `qa-other-sess-${counter}`;
    const reportId = `qa-cancel-report-${counter}`;
    const otherReportId = `qa-other-report-${counter}`;
    const now = new Date().toISOString();

    for (const id of [sessionId, otherSessionId]) {
      db.insert(agentSessions)
        .values({
          id,
          projectId: PROJECT_ID,
          status: "queued",
          agentType: "tech_check",
          createdAt: now,
        })
        .run();
    }
    db.insert(qaReports)
      .values([
        {
          id: reportId,
          projectId: PROJECT_ID,
          status: "running",
          agentSessionId: sessionId,
          checkType: "tech_check",
          createdAt: now,
        },
        {
          id: otherReportId,
          projectId: PROJECT_ID,
          status: "running",
          agentSessionId: otherSessionId,
          checkType: "tech_check",
          createdAt: now,
        },
      ])
      .run();

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );
    await DELETE(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ projectId: PROJECT_ID, sessionId }),
    );

    expect(getReport(reportId)?.status).toBe("cancelled");
    expect(getReport(otherReportId)?.status).toBe("running");
  });

  it("does not overwrite a report the closure tail already finalized", async () => {
    counter += 1;
    const sessionId = `qa-cancel-sess-${counter}`;
    const reportId = `qa-cancel-report-${counter}`;
    const now = new Date().toISOString();

    db.insert(agentSessions)
      .values({
        id: sessionId,
        projectId: PROJECT_ID,
        status: "running",
        agentType: "tech_check",
        createdAt: now,
      })
      .run();
    db.insert(qaReports)
      .values({
        id: reportId,
        projectId: PROJECT_ID,
        status: "completed",
        agentSessionId: sessionId,
        checkType: "tech_check",
        reportContent: "# Tech check\n\nAll good.",
        summary: "All good.",
        createdAt: now,
        completedAt: now,
      })
      .run();

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/sessions/[sessionId]/route"
    );
    await DELETE(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ projectId: PROJECT_ID, sessionId }),
    );

    const report = getReport(reportId);
    expect(report?.status).toBe("completed");
    expect(report?.summary).toBe("All good.");
  });
});
