/**
 * The QA-CHECK half of `GET /api/qa/findings`, against the real migrated
 * schema.
 *
 * WHAT THIS FILE IS FOR. `/qa` is where the nav's QA entry leads, and until
 * this payload carried `checks` and `checkableProjectIds` that screen could
 * neither start a tech check / E2E pass / failure digest nor show one running —
 * the ability the redesign lost. Two of these cases are the regression gate:
 *
 * - the payload must NEVER carry `qa_reports.report_content` or `prompt_used`.
 *   Both are uncapped multi-megabyte columns and this route is polled every
 *   8 s. MEASURED BY MUTATION, and the result is worth stating precisely: two
 *   independent things keep the blob off the wire — the narrow `select()` and
 *   `deriveChecks`' explicit projection — and re-introducing EITHER ONE ALONE
 *   leaves this file green, because the other still stops it. The case fails
 *   when both regress together, which is the contract it actually gates: the
 *   PAYLOAD, not the query. The narrow select is pinned in prose only.
 * - a still-running check must survive the `LIMIT`. With a plain `created_at
 *   DESC` it is dropped as soon as `QA_CHECK_LIMIT` newer rows exist, which is
 *   precisely the row the band exists to show.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, qaReports } = await import(
  "@/lib/db/schema"
);
const { GET } = await import("@/app/api/qa/findings/route");
const { QA_CHECK_LIMIT, QA_CHECK_SUMMARY_LIMIT } = await import(
  "@/lib/qa/types"
);
import type { QaPayload } from "@/lib/qa/types";

function reset(): void {
  db.delete(qaReports).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
}

function project(
  id: string,
  name: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
): void {
  db.insert(projects)
    .values({
      id,
      name,
      gitRepoPath: `/tmp/${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    })
    .run();
}

function report(
  id: string,
  projectId: string,
  overrides: Partial<typeof qaReports.$inferInsert> = {},
): void {
  db.insert(qaReports)
    .values({
      id,
      projectId,
      status: "completed",
      checkType: "tech_check",
      summary: `Summary ${id}`,
      createdAt: "2026-08-01T09:00:00.000Z",
      ...overrides,
    })
    .run();
}

function session(
  id: string,
  projectId: string,
  status: string,
  overrides: Partial<typeof agentSessions.$inferInsert> = {},
): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      status,
      mode: "code",
      provider: "claude-code",
      agentType: "tech_check",
      prompt: "",
      createdAt: "2026-08-01T09:00:00.000Z",
      ...overrides,
    })
    .run();
}

async function payload(): Promise<QaPayload> {
  const res = await GET(new Request("http://localhost/api/qa/findings"));
  const body = await res.json();
  return body.data as QaPayload;
}

beforeEach(reset);

describe("GET /api/qa/findings — checks", () => {
  it("carries the QA-check history the /qa screen draws", async () => {
    project("p1", "Arij");
    // A live check needs a live SESSION: `status = 'running'` on the report
    // alone is what a STRANDED row looks like, and the cases below pin that.
    session("s-live", "p1", "running");
    report("r1", "p1", {
      checkType: "e2e_test",
      status: "running",
      summary: null,
      agentSessionId: "s-live",
      createdAt: "2026-08-02T09:00:00.000Z",
    });
    report("r2", "p1", { checkType: "failure_digest" });

    const data = await payload();

    expect(data.checks.map((check) => check.reportId)).toEqual(["r1", "r2"]);
    expect(data.checks[0]).toMatchObject({
      projectId: "p1",
      checkType: "e2e_test",
      checkLabel: "E2E",
      status: "running",
      live: true,
      summary: null,
      agentSessionId: "s-live",
    });
    expect(data.checks[1]).toMatchObject({
      checkLabel: "DIGEST",
      status: "completed",
      live: false,
      summary: "Summary r2",
    });
  });

  /**
   * The two blob columns, and the whole payload's size with them seeded. A
   * byte ceiling rather than a key check alone: an absent key says nothing
   * about a megabyte that arrived under another name.
   */
  it("never ships report_content or prompt_used", async () => {
    project("p1", "Arij");
    const blob = "x".repeat(400_000);
    report("r1", "p1", { reportContent: blob, promptUsed: blob });

    const res = await GET(new Request("http://localhost/api/qa/findings"));
    const text = await res.text();

    expect(text).not.toContain(blob.slice(0, 5_000));
    expect(JSON.parse(text).data.checks[0]).not.toHaveProperty("reportContent");
    expect(JSON.parse(text).data.checks[0]).not.toHaveProperty("promptUsed");
    // 800 KB of blob seeded; the whole polled payload stays under 32 KB.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(32_768);
  });

  it("clips the summary rather than shipping the raw column", async () => {
    project("p1", "Arij");
    report("r1", "p1", { summary: "s".repeat(QA_CHECK_SUMMARY_LIMIT + 500) });

    const data = await payload();

    expect(data.checks[0].summary).toHaveLength(QA_CHECK_SUMMARY_LIMIT);
  });

  it("keeps a running check when newer rows would fill the limit", async () => {
    project("p1", "Arij");
    session("s-live", "p1", "running");
    report("old-running", "p1", {
      status: "running",
      agentSessionId: "s-live",
      createdAt: "2026-07-01T09:00:00.000Z",
    });
    for (let i = 0; i < QA_CHECK_LIMIT + 3; i += 1) {
      report(`newer-${i}`, "p1", {
        createdAt: `2026-08-1${i % 10}T09:00:00.000Z`,
      });
    }

    const data = await payload();

    expect(data.checks).toHaveLength(QA_CHECK_LIMIT);
    expect(data.checks[0].reportId).toBe("old-running");
    expect(data.checks.slice(1).every((check) => !check.live)).toBe(true);
  });

  it("is cross-project, newest first inside each liveness group", async () => {
    project("p1", "Arij", { createdAt: "2026-01-01T00:00:00.000Z" });
    project("p2", "Ledger", { createdAt: "2026-01-02T00:00:00.000Z" });
    report("a", "p1", { createdAt: "2026-08-01T09:00:00.000Z" });
    report("b", "p2", { createdAt: "2026-08-03T09:00:00.000Z" });

    const data = await payload();

    expect(data.checks.map((check) => check.reportId)).toEqual(["b", "a"]);
    expect(data.checks.map((check) => check.projectId)).toEqual(["p2", "p1"]);
  });
});

/**
 * ZOMBIE REPORTS — the reason `live` is not `status = 'running'`.
 *
 * `qa_reports.status` is moved off `running` in exactly ONE place: the tail of
 * the scheduler closure in `app/api/projects/[projectId]/qa/check/route.ts`.
 * Nothing else in the repo writes that column — `lib/agent-sessions/
 * boot-cleanup.ts` reconciles `agent_sessions` at boot and never touches
 * `qa_reports`. So three ordinary paths strand a report as `running` forever:
 *
 * 1. a restart mid-check — `failOrphanedRunningSessions()` fails the SESSION
 *    row and leaves the report alone;
 * 2. a launch closure that rejects — `handleLaunchFailure` marks the session
 *    terminal, and the `db.update(qaReports)` after the `await` never runs;
 * 3. cancelling a still-queued check — `agentScheduler.remove()` splices the
 *    closure out, so nothing errors and nothing updates the report.
 *
 * All three leave the SESSION terminal, which is why liveness is read from the
 * session and not from the report's own column. Without that, `running`-first
 * ordering pins the zombies to the top of a `QA_CHECK_LIMIT`-row band and the
 * real checks are never seen again — the ordering added to protect a live check
 * becomes the thing that hides every check.
 */
describe("GET /api/qa/findings — a report stranded on `running`", () => {
  it("is not live when its session is already terminal", async () => {
    project("p1", "Arij");
    session("s-dead", "p1", "failed");
    report("zombie", "p1", { status: "running", agentSessionId: "s-dead" });

    const data = await payload();

    expect(data.checks[0].live).toBe(false);
  });

  it("says `interrupted`, not `running`, so the word matches the dot", async () => {
    project("p1", "Arij");
    session("s-cancelled", "p1", "cancelled");
    report("zombie", "p1", {
      status: "running",
      agentSessionId: "s-cancelled",
    });

    const data = await payload();

    // NOT the session's own outcome either: `report_content` was never
    // written, so "cancelled"/"failed" would claim a finished report.
    expect(data.checks[0].status).toBe("interrupted");
  });

  it("stops monopolising the band — the real checks come back", async () => {
    project("p1", "Arij");
    for (let i = 0; i < QA_CHECK_LIMIT; i += 1) {
      session(`s-dead-${i}`, "p1", "failed");
      report(`zombie-${i}`, "p1", {
        status: "running",
        agentSessionId: `s-dead-${i}`,
        createdAt: `2026-07-0${i + 1}T09:00:00.000Z`,
      });
    }
    report("real", "p1", { createdAt: "2026-08-20T09:00:00.000Z" });

    const data = await payload();

    expect(data.checks[0].reportId).toBe("real");
    expect(data.checks.every((check) => check.live)).toBe(false);
  });

  it("still pins a genuinely live check above newer finished ones", async () => {
    project("p1", "Arij");
    session("s-live", "p1", "running");
    report("live", "p1", {
      status: "running",
      agentSessionId: "s-live",
      createdAt: "2026-07-01T09:00:00.000Z",
    });
    for (let i = 0; i < QA_CHECK_LIMIT + 2; i += 1) {
      report(`newer-${i}`, "p1", { createdAt: `2026-08-1${i % 10}T09:00:00.000Z` });
    }

    const data = await payload();

    expect(data.checks[0].reportId).toBe("live");
    expect(data.checks[0].live).toBe(true);
    expect(data.checks[0].status).toBe("running");
  });

  it("counts a queued check as live — it has not started, but it will", async () => {
    project("p1", "Arij");
    session("s-queued", "p1", "queued");
    report("queued", "p1", { status: "running", agentSessionId: "s-queued" });

    const data = await payload();

    expect(data.checks[0].live).toBe(true);
    expect(data.checks[0].status).toBe("running");
  });

  /**
   * `qa_reports.agent_session_id` is `ON DELETE SET NULL`. A `running` report
   * whose session row is gone has nothing that could still be running, and the
   * no-op digest — the only writer that stores a NULL session id — records
   * `completed`, never `running`.
   */
  it("is not live when its session row has been deleted", async () => {
    project("p1", "Arij");
    report("orphan", "p1", { status: "running", agentSessionId: null });

    const data = await payload();

    expect(data.checks[0].live).toBe(false);
    expect(data.checks[0].status).toBe("interrupted");
  });

  it("leaves an ordinary finished report's own word alone", async () => {
    project("p1", "Arij");
    session("s-ok", "p1", "completed");
    report("done", "p1", { status: "completed", agentSessionId: "s-ok" });
    report("failed", "p1", { status: "failed", agentSessionId: null });

    const data = await payload();

    const byId = new Map(data.checks.map((check) => [check.reportId, check]));
    expect(byId.get("done")?.status).toBe("completed");
    expect(byId.get("failed")?.status).toBe("failed");
    expect(byId.get("done")?.live).toBe(false);
  });
});

/**
 * THE META IS A COUNT, SO IT COUNTS EVERYTHING — not the `QA_CHECK_LIMIT` rows
 * the band happens to draw. A capped slice rendered as a total saturates at the
 * cap and understates reality exactly when several checks are in flight.
 */
describe("GET /api/qa/findings — checkTotals", () => {
  it("counts every report, not the windowed slice", async () => {
    project("p1", "Arij");
    for (let i = 0; i < QA_CHECK_LIMIT + 4; i += 1) {
      report(`r${i}`, "p1", { createdAt: `2026-08-0${i % 10}T09:00:00.000Z` });
    }

    const data = await payload();

    expect(data.checks).toHaveLength(QA_CHECK_LIMIT);
    expect(data.checkTotals).toEqual({
      p1: { running: 0, total: QA_CHECK_LIMIT + 4 },
    });
  });

  it("counts running by the same liveness the rows use, so zombies are excluded", async () => {
    project("p1", "Arij");
    session("s-live", "p1", "running");
    report("live", "p1", { status: "running", agentSessionId: "s-live" });
    session("s-dead", "p1", "failed");
    report("zombie", "p1", { status: "running", agentSessionId: "s-dead" });
    report("done", "p1", {});

    const data = await payload();

    expect(data.checkTotals).toEqual({ p1: { running: 1, total: 3 } });
  });

  /**
   * A project with no report gets no key at all, and `sumCheckTotals` reads a
   * missing key as zero — the band prints "0 running · 0 total" from an empty
   * map rather than from a fabricated row.
   */
  it("has no key for a project that has never run a check", async () => {
    project("p1", "Arij");

    const data = await payload();

    expect(data.checkTotals).toEqual({});
  });

  it("keeps each project's counts apart", async () => {
    project("p1", "Arij");
    project("p2", "Ledger", { createdAt: "2026-01-02T00:00:00.000Z" });
    session("s-live", "p2", "running");
    report("a", "p1", {});
    report("b", "p2", { status: "running", agentSessionId: "s-live" });
    report("c", "p2", {});

    const data = await payload();

    expect(data.checkTotals).toEqual({
      p1: { running: 0, total: 1 },
      p2: { running: 1, total: 2 },
    });
  });
});

describe("GET /api/qa/findings — checkableProjectIds", () => {
  /**
   * `POST /api/projects/{p}/qa/check` is
   * `getProjectOr404(..., { requireGitRepo: true })`, so a project with no
   * `git_repo_path` is a 400 and must never be offered. Derived server-side for
   * the same reason `reviewable` is.
   */
  it("offers only projects the check route would accept", async () => {
    project("p1", "Arij");
    project("p2", "No repo", { gitRepoPath: null });
    project("p3", "Empty repo", { gitRepoPath: "" });

    const data = await payload();

    expect(data.checkableProjectIds).toEqual(["p1"]);
  });

  it("is empty, not absent, on a workspace with no project at all", async () => {
    const data = await payload();

    expect(data.checks).toEqual([]);
    expect(data.checkableProjectIds).toEqual([]);
  });
});
