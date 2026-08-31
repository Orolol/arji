/**
 * `GET /api/qa/findings` against the real migrated schema.
 *
 * The sibling `qa-findings-aggregate.test.ts` covers every derivation from
 * plain objects; this file is the only place the cross-project SQL is actually
 * EXECUTED, which is what proves the `blocksMergeSql` / `epicSessionFactsCte` /
 * `listUnverifiableReviewEpicIds` project-optional overloads still bind, that
 * the route never ships a prompt, and that the payload the screen polls has the
 * shape the components read.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
  reviewComments,
  ticketActivityLog,
  ticketComments,
  customReviewAgents,
} = await import("@/lib/db/schema");
const { GET } = await import("@/app/api/qa/findings/route");
const { QA_LOG_LINE_LIMIT } = await import("@/lib/qa/types");
import type { QaPayload } from "@/lib/qa/types";

function iso(daysAgo: number, hour = 9): string {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
}

function reset(): void {
  db.delete(ticketActivityLog).run();
  db.delete(ticketComments).run();
  db.delete(reviewComments).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(customReviewAgents).run();
  db.delete(projects).run();
}

function project(id: string, name: string, createdAt: string): void {
  db.insert(projects)
    .values({ id, name, gitRepoPath: `/tmp/${id}`, createdAt })
    .run();
}

function epic(
  id: string,
  projectId: string,
  overrides: Partial<typeof epics.$inferInsert> = {},
): void {
  db.insert(epics)
    .values({
      id,
      projectId,
      title: `Epic ${id}`,
      readableId: `${projectId.toUpperCase()}-${id}`,
      status: "review",
      position: 0,
      ...overrides,
    })
    .run();
}

function finding(
  id: string,
  epicId: string,
  overrides: Partial<typeof reviewComments.$inferInsert> = {},
): void {
  db.insert(reviewComments)
    .values({
      id,
      epicId,
      filePath: "lib/agents/session.ts",
      lineNumber: 214,
      body: "[critical] the MCP token is logged in clear",
      author: "agent",
      status: "open",
      createdAt: iso(1),
      updatedAt: iso(1),
      ...overrides,
    })
    .run();
}

function session(
  id: string,
  projectId: string,
  overrides: Partial<typeof agentSessions.$inferInsert> = {},
): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      status: "completed",
      agentType: "review_code",
      createdAt: iso(1),
      ...overrides,
    })
    .run();
}

async function load(): Promise<QaPayload> {
  const res = await GET();
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return body.data as QaPayload;
}

beforeEach(() => {
  reset();
});

describe("GET /api/qa/findings — cross-project findings", () => {
  it("gathers open findings from every project, each carrying its own identity", async () => {
    project("p1", "Arij", "2026-01-01");
    project("p2", "Ledger", "2026-01-02");
    epic("e1", "p1");
    epic("e2", "p2");
    finding("f1", "e1");
    finding("f2", "e2", { body: "[major] no test on the defaults" });

    const payload = await load();

    expect(payload.findings.map((row) => row.projectId).sort()).toEqual([
      "p1",
      "p2",
    ]);
    // Project identity is the desk's own derivation: creation order.
    expect(payload.projects.map((p) => [p.id, p.colorIndex])).toEqual([
      ["p1", 0],
      ["p2", 1],
    ]);
  });

  it("lists a [minor] and a [critical] on one epic, and blocks only the critical", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    finding("f1", "e1");
    finding("f2", "e1", { body: "[minor] inconsistent parser naming" });

    const payload = await load();
    const byId = new Map(payload.findings.map((row) => [row.findingId, row]));

    expect(byId.get("f1")?.severityLabel).toBe("BLOCKING");
    expect(byId.get("f1")?.blocking).toBe(true);
    expect(byId.get("f2")?.severityLabel).toBe("MINOR");
    expect(byId.get("f2")?.blocking).toBe(false);
    // The prefix is stripped for display, but the raw body travels for the
    // "Fix with agent" markdown.
    expect(byId.get("f1")?.text).toBe("the MCP token is logged in clear");
    expect(byId.get("f1")?.rawBody).toContain("[critical]");
  });

  it("does not block a [major] a later clean verdict superseded", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    // The finding, then the code it names, then a clean verdict that read it.
    finding("f1", "e1", { body: "[major] stale", createdAt: iso(9) });
    session("build1", "p1", {
      agentType: "build",
      status: "completed",
      endedAt: iso(8),
      epicId: "e1",
    });
    session("rev1", "p1", {
      agentType: "review_code",
      status: "completed",
      outcome: "answered",
      reviewVerdict: "approved",
      startedAt: iso(7),
      endedAt: iso(7),
      epicId: "e1",
    });

    const payload = await load();
    const row = payload.findings.find((f) => f.findingId === "f1");

    // Present and still stamped MAJOR — the stamp is the reviewer's word.
    expect(row?.severityLabel).toBe("MAJOR");
    // …but not blocking. This is the assertion that proves `blocksMergeSql`
    // ran rather than a re-derivation in JavaScript.
    expect(row?.blocking).toBe(false);
  });

  it("treats a human's open comment as HUMAN, and always blocking", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    finding("f1", "e1", { author: "user", body: "[minor] I still want this" });

    const payload = await load();
    expect(payload.findings[0].severityLabel).toBe("HUMAN");
    expect(payload.findings[0].blocking).toBe(true);
    expect(payload.findings[0].reviewer).toBeNull();
  });

  it("omits resolved rows entirely", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    finding("f1", "e1", { status: "resolved" });

    expect((await load()).findings).toHaveLength(0);
  });

  it("names the filing session's agent, and its type for the Security filter", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    session("s1", "p1", { agentType: "review_security", namedAgentName: "Security CC" });
    finding("f1", "e1", { agentSessionId: "s1" });

    const payload = await load();
    expect(payload.findings[0].reviewer).toBe("Security CC");
    expect(payload.findings[0].reviewerAgentType).toBe("review_security");
  });

  it("withholds Fix on a shipped ticket, because the build route refuses it", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1", { status: "done" });
    epic("e2", "p1", { status: "review" });
    finding("f1", "e1");
    finding("f2", "e2");

    const payload = await load();
    const byId = new Map(payload.findings.map((row) => [row.findingId, row]));
    expect(byId.get("f1")?.fixable).toBe(false);
    expect(byId.get("f2")?.fixable).toBe(true);
  });
});

describe("GET /api/qa/findings — runs", () => {
  it("counts only the four ordinary review types as a QA run", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    session("live", "p1", {
      status: "running",
      agentType: "review_security",
      namedAgentName: "Security CC",
      epicId: "e1",
      startedAt: iso(0),
      lastNonEmptyText: "checking migration rollback",
    });
    session("build", "p1", { status: "running", agentType: "build", epicId: "e1" });
    session("second", "p1", {
      status: "running",
      agentType: "review_second_opinion",
      epicId: "e1",
    });
    session("queued", "p1", {
      status: "queued",
      agentType: "review_code",
      epicId: "e1",
    });

    const payload = await load();
    expect(payload.runs.map((run) => run.sessionId)).toEqual(["live"]);
    expect(payload.queued.map((run) => run.sessionId)).toEqual(["queued"]);
    expect(payload.runs[0].agentName).toBe("Security CC");
    expect(payload.runs[0].lastLine).toBe("checking migration rollback");
  });

  it("reports what a live reviewer has already filed", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    session("live", "p1", {
      status: "running",
      agentType: "review_security",
      epicId: "e1",
      startedAt: iso(0),
    });
    finding("f1", "e1", { agentSessionId: "live" });
    finding("f2", "e1", { agentSessionId: "live", body: "[minor] naming" });

    const payload = await load();
    expect(payload.runs[0].findingsFiled).toBe(2);
    expect(payload.runs[0].blockingFiled).toBe(1);
  });

  it("never ships a prompt, and clips the log line in SQL", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    session("live", "p1", {
      status: "running",
      agentType: "review_code",
      epicId: "e1",
      startedAt: iso(0),
      prompt: `SECRET-PROMPT-MARKER${"p".repeat(1000)}`,
      lastNonEmptyText: "x".repeat(300 * 1024),
    });

    const res = await GET();
    const raw = await res.text();
    expect(raw).not.toContain("SECRET-PROMPT-MARKER");

    const payload = JSON.parse(raw).data as QaPayload;
    expect(payload.runs[0].lastLine).toHaveLength(QA_LOG_LINE_LIMIT);
  });
});

describe("GET /api/qa/findings — coverage, verdicts and the rubric", () => {
  it("measures coverage over what shipped in the window", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1", { status: "done" });
    epic("e2", "p1", { status: "done" });
    for (const [id, epicId] of [
      ["a1", "e1"],
      ["a2", "e2"],
    ] as const) {
      db.insert(ticketActivityLog)
        .values({
          id,
          projectId: "p1",
          epicId,
          fromStatus: "to_merge",
          toStatus: "done",
          actor: "user",
          createdAt: iso(2),
        })
        .run();
    }
    session("rev1", "p1", {
      agentType: "review_code",
      status: "completed",
      epicId: "e1",
    });

    expect((await load()).coveragePercent).toBe(50);
  });

  it("answers an em-dash's null — never 0 — when nothing shipped", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1");
    expect((await load()).coveragePercent).toBeNull();
  });

  it("derives a verdict row per epic and its destination arrow", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1", { status: "to_merge" });
    session("rev1", "p1", {
      agentType: "review_code",
      status: "completed",
      outcome: "answered",
      reviewVerdict: "changes_requested",
      epicId: "e1",
      endedAt: iso(1),
    });
    finding("f1", "e1", { agentSessionId: "rev1" });

    const payload = await load();
    expect(payload.verdicts).toHaveLength(1);
    expect(payload.verdicts[0].verdictText).toBe("changes requested · 1 finding");
    expect(payload.verdicts[0].outcome).toBe("→ ready");
    expect(payload.verdicts[0].kind).toBe("attention");
  });

  it("reads the rubric from the real checklist and counts enabled project rules", async () => {
    project("p1", "Arij", "2026-01-01");
    db.insert(customReviewAgents)
      .values({ id: "c1", name: "House rules", systemPrompt: "…", scope: "global", isEnabled: 1 })
      .run();
    db.insert(customReviewAgents)
      .values({ id: "c2", name: "Off", systemPrompt: "…", scope: "global", isEnabled: 0 })
      .run();

    const payload = await load();
    expect(payload.rubric.items).toContain("Tests");
    expect(payload.rubric.projectRuleCount).toBe(1);
  });

  it("offers Run QA pass only on tickets the review route would accept", async () => {
    project("p1", "Arij", "2026-01-01");
    epic("e1", "p1", { status: "review" });
    epic("e2", "p1", { status: "backlog" });
    epic("e3", "p1", { status: "done" });
    epic("e4", "p1", { status: "review" });
    // e4 already owns an agent — the route would 409.
    session("busy", "p1", { status: "running", agentType: "build", epicId: "e4" });

    const payload = await load();
    expect(payload.reviewable.map((row) => row.epicId)).toEqual(["e1"]);
  });

  it("returns a folded payload — not a crash — on an empty install", async () => {
    const payload = await load();
    expect(payload.projects).toEqual([]);
    expect(payload.findings).toEqual([]);
    expect(payload.coveragePercent).toBeNull();
    expect(payload.rubric.items.length).toBeGreaterThan(0);
  });
});
