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

describe("merges, discards and creations in the report", () => {
  const report = buildRefinementReport([
    change({
      kind: "merged",
      ticketId: "epic-1",
      label: "E-arij-001",
      detail: "absorbed E-arij-009",
      reason: "One screen, one ticket.",
      snapshot: "**E-arij-009 — Search sorting** (feature, priority 0, was in todo)",
    }),
    change({
      kind: "discarded",
      ticketId: "epic-9",
      label: "E-arij-009",
      detail: 'deleted — "Legacy exporter"',
      reason: "The exporter was removed in 0.3.",
      ticketGone: true,
      snapshot: "**E-arij-009 — Legacy exporter** (feature, priority 0, was in backlog)",
    }),
    change({
      kind: "created",
      ticketId: "epic-4",
      label: "E-arij-004",
      detail: 'new feature in Backlog — "Backfill the index"',
      reason: "Nothing covered pre-existing rows.",
    }),
  ]);

  it("names all three in the aggregate line", () => {
    expect(formatRefinementSummary(report)).toBe(
      "1 merge · 1 ticket discarded · 1 ticket created"
    );
  });

  /**
   * A discarded ticket's deep link resolves to nothing. Linking it would read
   * as a broken navigation rather than as "this ticket is gone".
   */
  it("does not link a ticket the pass deleted", () => {
    const body = formatRefinementComment("proj-1", report, undefined, {
      includeFullList: true,
    });
    expect(body).not.toContain("?ticket=epic-9");
    expect(body).toContain("~~E-arij-009~~");
    // The ones that survived are still links.
    expect(body).toContain("[E-arij-004](/projects/proj-1?ticket=epic-4)");
  });

  /** For a discard this block is the only surviving copy of the ticket. */
  it("carries the deleted ticket's own text", () => {
    const body = formatRefinementComment("proj-1", report, undefined, {
      includeFullList: true,
    });
    expect(body).toContain("What E-arij-009 contained:");
    expect(body).toContain("Legacy exporter");
    expect(body).toContain("The exporter was removed in 0.3.");
  });

  /**
   * A merge's absorbed text is already posted on the survivor as the
   * absorption comment (app/api/mcp/merge-tickets/route.ts), and the recap
   * usually lands on that same ticket — a merge target is first among the
   * pass's structural changes. Re-rendering the snapshot here published every
   * absorbed story's acceptance criteria twice in one feed.
   */
  it("does not repeat a merge's absorbed text, which the survivor already carries", () => {
    const withMergeSnapshot = buildRefinementReport([
      change({
        kind: "merged",
        ticketId: "epic-1",
        label: "E-arij-001",
        detail: "absorbed E-arij-009",
        reason: "One screen, one ticket.",
        // A record built the way the route no longer builds one.
        snapshot: "**E-arij-009 — Search sorting** (feature, priority 0)",
      }),
    ]);
    const body = formatRefinementComment("proj-1", withMergeSnapshot, undefined, {
      includeFullList: true,
    });
    // The merge is still listed with its justification...
    expect(body).toContain("Merged together");
    expect(body).toContain("absorbed E-arij-009");
    // ...and the absorbed text is not re-rendered under any heading.
    expect(body).not.toContain("Search sorting");
    expect(body).not.toContain("What E-arij-001");
  });

  /**
   * Ticket comments are rendered as plain text under `whitespace-pre-wrap`
   * (components/ticket/CommentBubble.tsx) — never as markdown, never as HTML.
   * A `<details>` fold-out therefore shows the user its own tags, which is
   * what this recap used to do.
   */
  it("puts no raw HTML in a body the feed renders verbatim", () => {
    const body = formatRefinementComment("proj-1", report, undefined, {
      includeFullList: true,
    });
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("<summary>");
    expect(body).not.toMatch(/<\/?[a-z][^>]*>/);
  });

  it("leads a merge and a creation with their own headline", () => {
    expect(
      formatRefinementComment("proj-1", report, "epic-1").startsWith(
        "Absorbed other tickets"
      )
    ).toBe(true);
    expect(
      formatRefinementComment("proj-1", report, "epic-4").startsWith("Created")
    ).toBe(true);
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

  /**
   * Regression: comment targets were derived only from promotions and
   * demotions, so a pass that re-ranked To do and fixed dependency edges
   * posted no comment at all — and the itemised, ticket-linked breakdown the
   * acceptance criteria ask for lives only inside a comment. This is the
   * likely-common path: the prompt re-ranks on every run while promotion is
   * gated on readiness and the agent is told to be conservative.
   */
  it("publishes the breakdown when no ticket changed column", () => {
    const auth = { sessionId, agentType: REFINEMENT_AGENT_TYPE };
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
    recordRefinementChange(
      auth,
      change({
        kind: "dependency_added",
        ticketId: promotedId,
        label: "E-1",
        detail: "now depends on E-3",
        reason: "Needs the schema.",
      })
    );

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.report.promoted).toHaveLength(0);
    expect(published.report.demoted).toHaveLength(0);
    // Exactly one comment, carrying the full itemised list with its links.
    expect(published.commentedTicketIds).toHaveLength(1);

    const body = comments(published.commentedTicketIds[0])[0].content;
    expect(body).toContain("Re-ranked");
    expect(body).toContain("Dependency edges added");
    expect(body).toContain("Unblocked first.");
    expect(body).toContain("Needs the schema.");
    expect(body).toContain(`/projects/${projectId}?ticket=`);
    // No focus block: this ticket did not move column.
    expect(body).not.toContain("Promoted **Backlog → To do**");
  });

  it("still posts nothing when the pass changed nothing at all", () => {
    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });
    expect(published.commentedTicketIds).toEqual([]);
    // The notification still fires — see the no-op case below.
    expect(published.notificationId).toBeTruthy();
  });

  /**
   * A discarded ticket's row is gone by the time the report runs, so it can
   * neither host a comment nor be linked. The fallback host used to be "the
   * first ticket the pass touched at all", which after a discard is a
   * deleted id — the insert then violates the FK, or (with the pragma off)
   * orphans a comment nobody can read.
   */
  it("never posts the recap on a ticket the pass deleted", () => {
    const auth = { sessionId, agentType: REFINEMENT_AGENT_TYPE };
    recordRefinementChange(
      auth,
      change({
        kind: "discarded",
        ticketId: createId(),
        label: "E-9",
        detail: 'deleted — "Legacy exporter"',
        reason: "Removed in 0.3.",
        ticketGone: true,
        snapshot: "**E-9 — Legacy exporter** (feature, priority 0, was in backlog)",
      })
    );
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

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.commentedTicketIds).toEqual([promotedId]);
    // ...and that surviving comment is where the tombstone landed.
    expect(comments(promotedId)[0].content).toContain("Legacy exporter");
  });

  /**
   * The sharp edge of the same rule. With no promotion to host the recap the
   * fallback is "the first ticket the pass touched" — and after a discard
   * that is a deleted id. Inserting against it violates the FK, the insert
   * is swallowed by the report's per-ticket try/catch, and the pass ends up
   * publishing NO breakdown at all: the reordered ticket that could have
   * hosted it is never considered.
   */
  it("falls back to a surviving ticket when the first one it touched is gone", () => {
    const auth = { sessionId, agentType: REFINEMENT_AGENT_TYPE };
    recordRefinementChange(
      auth,
      change({
        kind: "discarded",
        ticketId: createId(),
        label: "E-9",
        detail: 'deleted — "Legacy exporter"',
        reason: "Removed in 0.3.",
        ticketGone: true,
        snapshot: "**E-9 — Legacy exporter** (feature, priority 0, was in backlog)",
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

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.commentedTicketIds).toEqual([reorderedId]);
    const body = comments(reorderedId)[0].content;
    expect(body).toContain("Legacy exporter");
    expect(body).toContain("Re-ranked");
  });

  /**
   * A pass that discarded everything it touched has no ticket of its own to
   * file the record on — and it is exactly the pass whose record the user
   * most needs. `notifications` is not an answer: nothing in the app renders
   * that table (hooks/useNotifications.ts has no consumer; the chrome reads
   * /api/inbox, built from ticket_comments and agent_sessions), so the
   * tombstone would be a permanently deleted ticket with no readable trace.
   * It falls back to a ticket the project still has, and says why.
   */
  it("files a discard-only pass's record on a surviving ticket of the project", () => {
    recordRefinementChange(
      { sessionId, agentType: REFINEMENT_AGENT_TYPE },
      change({
        kind: "discarded",
        ticketId: createId(),
        label: "E-9",
        detail: 'deleted — "Legacy exporter"',
        reason: "Removed in 0.3.",
        ticketGone: true,
        snapshot:
          "**E-9 — Legacy exporter** (feature, priority 0, was in backlog)\n\nExports to the old CSV shape.",
      })
    );

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.commentedTicketIds).toHaveLength(1);
    const body = comments(published.commentedTicketIds[0])[0].content;
    expect(body).toContain("Legacy exporter");
    expect(body).toContain("Exports to the old CSV shape.");
    // ...and it says plainly that this ticket is only the host.
    expect(body).toContain("this ticket was not touched");

    // The notification still carries the duplicate.
    const row = testDb.instance!.db.select().from(notifications).all()[0];
    expect(row.title).toContain("1 ticket discarded");
    expect(row.message).toContain("Discarded E-9: Removed in 0.3.");
  });

  /**
   * The fallback is deterministic — top of the planning columns by board
   * order — so two runs of the same pass do not scatter their records.
   */
  it("picks the top of the planning columns as that host", () => {
    // Unambiguously the top: the other two are seeded in "todo" at 0 and 1,
    // and a tie on `position` would make the id break it — i.e. a flake.
    testDb
      .instance!.db.update(epics)
      .set({ position: 8 })
      .where(eq(epics.id, promotedId))
      .run();
    testDb
      .instance!.db.update(epics)
      .set({ position: 9 })
      .where(eq(epics.id, demotedId))
      .run();
    testDb
      .instance!.db.update(epics)
      .set({ status: "backlog", position: 0 })
      .where(eq(epics.id, reorderedId))
      .run();

    recordRefinementChange(
      { sessionId, agentType: REFINEMENT_AGENT_TYPE },
      change({
        kind: "discarded",
        ticketId: createId(),
        label: "E-9",
        detail: "deleted",
        reason: "Obsolete.",
        ticketGone: true,
        snapshot: "**E-9 — Legacy exporter** (feature, priority 0)",
      })
    );

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });
    expect(published.commentedTicketIds).toEqual([reorderedId]);
  });

  /**
   * Scenario A of the host bug: `ticketGone` is set on the record of the
   * DELETING call and on no other, so a ticket that got an earlier record in
   * the same pass and was retired afterwards still looked alive there. It was
   * put forward as the host, the insert violated the FK, the catch swallowed
   * it, and the pass published its breakdown nowhere.
   */
  it("does not host on a ticket an earlier record named and a later call deleted", () => {
    const auth = { sessionId, agentType: REFINEMENT_AGENT_TYPE };
    const deletedId = createId();
    // The record order a real pass produces: set_priority(A), then
    // discard_ticket(A). Only the second carries ticketGone.
    recordRefinementChange(
      auth,
      change({
        kind: "priority",
        ticketId: deletedId,
        label: "E-9",
        detail: "priority 0 → 2",
        reason: "Looked urgent.",
      })
    );
    recordRefinementChange(
      auth,
      change({
        kind: "discarded",
        ticketId: deletedId,
        label: "E-9",
        detail: "deleted",
        reason: "Then found obsolete.",
        ticketGone: true,
        snapshot: "**E-9 — Legacy exporter** (feature, priority 0)",
      })
    );

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.commentedTicketIds).toHaveLength(1);
    expect(published.commentedTicketIds).not.toContain(deletedId);
    // And the breakdown really was published, not swallowed.
    const body = comments(published.commentedTicketIds[0])[0].content;
    expect(body).toContain("Legacy exporter");
    expect(body).toContain("Priority changes");
  });

  /**
   * Scenario B: the pass promoted A and then merged A into B. `movedTicketIds`
   * held both, A came first and became `fullListTicketId` — so B's comment
   * pointed at a deleted ticket for a breakdown that was never posted.
   */
  it("does not point the breakdown at a ticket a later merge absorbed", () => {
    const auth = { sessionId, agentType: REFINEMENT_AGENT_TYPE };
    const absorbedId = createId();
    recordRefinementChange(
      auth,
      change({
        kind: "promoted",
        ticketId: absorbedId,
        label: "E-9",
        detail: "promoted to To do",
        reason: "Looked ready.",
      })
    );
    recordRefinementChange(
      auth,
      change({
        kind: "merged",
        ticketId: promotedId,
        label: "E-1",
        detail: "absorbed E-9",
        reason: "Same screen.",
      })
    );

    const published = publishRefinementReport({
      projectId,
      sessionId,
      succeeded: true,
    });

    expect(published.commentedTicketIds).toEqual([promotedId]);
    const body = comments(promotedId)[0].content;
    // The surviving ticket carries the full list itself, not a pointer to a
    // ticket that no longer exists.
    expect(body).toContain("Merged together");
    expect(body).not.toContain("Full breakdown of this pass:");
  });

  it("leaves the notification message empty when nothing was discarded", () => {
    seedChanges();
    publishRefinementReport({ projectId, sessionId, succeeded: true });
    expect(
      testDb.instance!.db.select().from(notifications).all()[0].message
    ).toBeNull();
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
