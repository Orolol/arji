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

async function payload(): Promise<QaPayload> {
  const res = await GET();
  const body = await res.json();
  return body.data as QaPayload;
}

beforeEach(reset);

describe("GET /api/qa/findings — checks", () => {
  it("carries the QA-check history the /qa screen draws", async () => {
    project("p1", "Arij");
    report("r1", "p1", {
      checkType: "e2e_test",
      status: "running",
      summary: null,
      agentSessionId: null,
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

    const res = await GET();
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
    report("old-running", "p1", {
      status: "running",
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
