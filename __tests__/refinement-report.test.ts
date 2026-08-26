/**
 * The end-of-run synthesis report.
 *
 * Covers the pure formatting (grouping, the aggregate line, the recap body
 * and its ticket links) and the publish path against the real migrated
 * schema: recap comments on the tickets that changed column, and one
 * project notification carrying the aggregate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { createId } from "@/lib/utils/nanoid";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
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

const { agentSessions, epics, notifications, projects, ticketComments } =
  await import("@/lib/db/schema");
const {
  buildRefinementReport,
  formatRefinementComment,
  formatRefinementSummary,
  publishRefinementReport,
} = await import("@/lib/refinement/report");
const {
  recordRefinementChange,
  peekRefinementChanges,
  _resetRefinementRegistryForTests,
} = await import("@/lib/refinement/registry");
const { REFINEMENT_AGENT_TYPE } = await import("@/lib/refinement/constants");

type Change = Parameters<typeof recordRefinementChange>[1];

function change(overrides: Partial<Change> & { kind: Change["kind"] }): Change {
  return {
    ticketId: "epic-1",
    label: "E-arij-001",
    detail: "detail",
    reason: "because",
    ...overrides,
  };
}

describe("buildRefinementReport / formatRefinementSummary", () => {
  it("groups changes by kind", () => {
    const report = buildRefinementReport([
      change({ kind: "promoted" }),
      change({ kind: "promoted", ticketId: "epic-2" }),
      change({ kind: "demoted", ticketId: "epic-3" }),
      change({ kind: "dependency_added" }),
      change({ kind: "dependency_removed" }),
      change({ kind: "priority" }),
      change({ kind: "reordered" }),
    ]);

    expect(report.promoted).toHaveLength(2);
    expect(report.demoted).toHaveLength(1);
    expect(report.dependenciesAdded).toHaveLength(1);
    expect(report.dependenciesRemoved).toHaveLength(1);
    expect(report.priority).toHaveLength(1);
    expect(report.reordered).toHaveLength(1);
    expect(report.total).toBe(7);
  });

  it("reads like the epic's example line", () => {
    const report = buildRefinementReport([
      ...Array.from({ length: 4 }, (_, i) =>
        change({ kind: "promoted", ticketId: `p${i}` })
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        change({ kind: "demoted", ticketId: `d${i}` })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        change({ kind: "dependency_added", ticketId: `e${i}` })
      ),
      change({ kind: "reordered" }),
    ]);

    expect(formatRefinementSummary(report)).toBe(
      "4 tickets promoted to To do · 2 tickets sent back to Backlog · 3 dependency edges added · 1 ticket reordered"
    );
  });

  it("omits categories that did not happen", () => {
    const report = buildRefinementReport([change({ kind: "reordered" })]);
    const summary = formatRefinementSummary(report);
    expect(summary).toBe("1 ticket reordered");
    expect(summary).not.toContain("promoted");
  });

  it("says so when nothing changed", () => {
    expect(formatRefinementSummary(buildRefinementReport([]))).toContain(
      "no changes"
    );
  });
});

describe("formatRefinementComment", () => {
  const report = buildRefinementReport([
    change({
      kind: "promoted",
      ticketId: "epic-1",
      label: "E-arij-001",
      detail: "promoted to To do",
      reason: "Criteria are concrete now.",
    }),
    change({
      kind: "demoted",
      ticketId: "epic-2",
      label: "E-arij-002",
      detail: "sent back to Backlog — Which provider?",
      reason: "Cannot be started as written.",
    }),
    change({
      kind: "dependency_added",
      ticketId: "epic-3",
      label: "E-arij-003",
      detail: "now depends on E-arij-001",
      reason: "Needs the schema first.",
    }),
  ]);

  it("links every listed ticket to its board deep link", () => {
    const body = formatRefinementComment("proj-1", report, undefined, {
      includeFullList: true,
    });
    expect(body).toContain("[E-arij-001](/projects/proj-1?ticket=epic-1)");
    expect(body).toContain("[E-arij-002](/projects/proj-1?ticket=epic-2)");
    expect(body).toContain("[E-arij-003](/projects/proj-1?ticket=epic-3)");
  });

  it("lists each category of change with its justification", () => {
    const body = formatRefinementComment("proj-1", report, undefined, {
      includeFullList: true,
    });
    expect(body).toContain("Promoted to To do");
    expect(body).toContain("Sent back to Backlog");
    expect(body).toContain("Dependency edges added");
    expect(body).toContain("Criteria are concrete now.");
    expect(body).toContain("Needs the schema first.");
  });

  it("leads with the focused ticket's own move", () => {
    const body = formatRefinementComment("proj-1", report, "epic-1");
    expect(body.startsWith("Promoted **Backlog → To do**")).toBe(true);
  });

  it("omits the itemised breakdown unless asked for it", () => {
    const body = formatRefinementComment("proj-1", report, "epic-1");
    // The aggregate is always there; the per-change lists are not.
    expect(body).toContain("1 ticket promoted to To do");
    expect(body).not.toContain("Dependency edges added");
    expect(body).not.toContain("Needs the schema first.");
  });

  it("points at the ticket carrying the full breakdown", () => {
    const body = formatRefinementComment("proj-1", report, "epic-2", {
      fullListTicketId: "epic-1",
    });
    expect(body).toContain("Full breakdown of this pass:");
    expect(body).toContain("/projects/proj-1?ticket=epic-1");
  });

  it("leads a demotion with its open question", () => {
    const body = formatRefinementComment("proj-1", report, "epic-2");
    expect(body.startsWith("Sent back **To do → Backlog**")).toBe(true);
    expect(body).toContain("Which provider?");
  });
});

describe("publishRefinementReport", () => {
  let projectId: string;
  let sessionId: string;
  let promotedId: string;
  let demotedId: string;
  let reorderedId: string;

  beforeEach(() => {
    testDb.instance = createTestDb();
    _resetRefinementRegistryForTests();

    projectId = createId();
    sessionId = createId();
    promotedId = createId();
    demotedId = createId();
    reorderedId = createId();
    const now = new Date().toISOString();
    const db = testDb.instance.db;

    db.insert(projects)
      .values({ id: projectId, name: "Arij", createdAt: now, updatedAt: now })
      .run();
    db.insert(epics)
      .values(
        [promotedId, demotedId, reorderedId].map((id, index) => ({
          id,
          projectId,
          title: `Ticket ${index}`,
          status: "todo",
          position: index,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .run();
    db.insert(agentSessions)
      .values({
        id: sessionId,
        projectId,
        status: "running",
        agentType: REFINEMENT_AGENT_TYPE,
        createdAt: now,
      })
      .run();
  });

  function seedChanges() {
    const auth = { sessionId, agentType: REFINEMENT_AGENT_TYPE };
    recordRefinementChange(
      auth,
      change({
        kind: "promoted",
        ticketId: promotedId,
        label: "E-1",
        detail: "promoted to To do",
        reason: "Ready.",
      })
    );
    recordRefinementChange(
      auth,
      change({
        kind: "demoted",
        ticketId: demotedId,
        label: "E-2",
        detail: "sent back to Backlog — What auth?",
        reason: "Ambiguous.",
      })
    );
    recordRefinementChange(
      auth,
      change({
        kind: "reordered",
        ticketId: reorderedId,
        label: "E-3",
        detail: "todo position 0",
        reason: "Unblocked first.",
      })
    );
  }

  function comments(epicId: string) {
    return testDb
      .instance!.db.select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
  }

  it("comments on tickets that changed column and not on the rest", () => {
    seedChanges();
    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.commentedTicketIds.sort()).toEqual(
      [promotedId, demotedId].sort()
    );
    expect(comments(promotedId)).toHaveLength(1);
    expect(comments(demotedId)).toHaveLength(1);
    // Reorder-only tickets keep their activity-log entry, no comment.
    expect(comments(reorderedId)).toHaveLength(0);
  });

  it("attributes the recap comments to the session", () => {
    seedChanges();
    publishRefinementReport({ projectId, sessionId, succeeded: true });

    const comment = comments(promotedId)[0];
    expect(comment.author).toBe("agent");
    expect(comment.agentSessionId).toBe(sessionId);
    // Its own move and reason are always present, whether or not this is the
    // ticket carrying the itemised breakdown.
    expect(comment.content).toContain("Ready.");
    expect(comment.content).toContain("Promoted **Backlog → To do**");
  });

  /**
   * Regression: the recap repeated the whole board report on every moved
   * ticket, so comment volume was quadratic in the size of the pass (10
   * promotions x 40 changes each) — and it bloated the very table the
   * board's status poll used to scan.
   */
  it("posts the itemised breakdown exactly once per pass", () => {
    seedChanges();
    publishRefinementReport({ projectId, sessionId, succeeded: true });

    const bodies = [promotedId, demotedId].map(
      (id) => comments(id)[0].content
    );
    const withFullList = bodies.filter((body) =>
      body.includes("Re-ranked")
    );
    expect(withFullList).toHaveLength(1);

    // The other one still explains itself and points at the breakdown.
    const withoutFullList = bodies.filter(
      (body) => !body.includes("Re-ranked")
    );
    expect(withoutFullList).toHaveLength(1);
    expect(withoutFullList[0]).toContain("Full breakdown of this pass:");
    expect(withoutFullList[0]).toContain("1 ticket promoted to To do");
  });

  it("raises one notification carrying the aggregate", () => {
    seedChanges();
    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    const rows = testDb.instance!.db.select().from(notifications).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(published.notificationId);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].agentType).toBe(REFINEMENT_AGENT_TYPE);
    expect(rows[0].targetUrl).toBe(`/projects/${projectId}`);
    expect(rows[0].title).toContain("1 ticket promoted to To do");
    expect(rows[0].title).toContain("1 ticket sent back to Backlog");
  });

  it("drains the registry so a second publish reports nothing", () => {
    seedChanges();
    publishRefinementReport({ projectId, sessionId, succeeded: true });
    expect(peekRefinementChanges(sessionId)).toEqual([]);

    const second = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });
    expect(second.report.total).toBe(0);
    expect(second.commentedTicketIds).toEqual([]);
  });

  it("still reports the partial work of a run that ended early", () => {
    seedChanges();
    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: false,
    });

    expect(published.report.promoted).toHaveLength(1);
    const row = testDb.instance!.db.select().from(notifications).all()[0];
    expect(row.status).toBe("failed");
    expect(row.title).toContain("ended early");
  });

  it("notifies a no-op pass rather than staying silent", () => {
    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.report.total).toBe(0);
    const row = testDb.instance!.db.select().from(notifications).all()[0];
    expect(row.title).toContain("no changes");
  });
});

describe("recordRefinementChange", () => {
  beforeEach(() => {
    _resetRefinementRegistryForTests();
  });

  it("ignores sessions that are not refinement passes", () => {
    recordRefinementChange(
      { sessionId: "s1", agentType: "build" },
      change({ kind: "promoted" })
    );
    expect(peekRefinementChanges("s1")).toEqual([]);
  });

  it("records refinement sessions", () => {
    recordRefinementChange(
      { sessionId: "s1", agentType: REFINEMENT_AGENT_TYPE },
      change({ kind: "promoted" })
    );
    expect(peekRefinementChanges("s1")).toHaveLength(1);
  });
});
