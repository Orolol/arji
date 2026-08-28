/**
 * `GET /api/control-desk` against the real migrated schema.
 *
 * The sibling `control-desk-aggregate.test.ts` covers every derivation from
 * plain objects; this file is the only place the cross-project SQL is actually
 * EXECUTED, which is what proves the relaxed queries parse, that the
 * `epicSessionFactsCte` / `listUnverifiableReviewEpicIds` project-optional
 * overloads still bind, and that the payload the desk polls has the shape the
 * components read.
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
  userStories,
  agentSessions,
  ticketComments,
  ticketDependencies,
  ticketActivityLog,
  settings,
} = await import("@/lib/db/schema");
const { GET } = await import("@/app/api/control-desk/route");
const { buildMergeBlockedReason } = await import("@/lib/workflow/merge-failure");
const { autoModeEnabledSettingKey } = await import("@/lib/auto-mode/constants");
const { CONTROL_DESK_LOOKBACK_DAYS } = await import("@/lib/control-desk/types");

/** Today, so the TODAY roll-up sees these rows. */
function today(minute: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      6,
      minute,
      0,
    ),
  ).toISOString();
}

function longAgo(): string {
  return new Date(
    Date.now() - (CONTROL_DESK_LOOKBACK_DAYS + 5) * 86_400_000,
  ).toISOString();
}

function reset(): void {
  db.delete(ticketDependencies).run();
  db.delete(ticketActivityLog).run();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.delete(settings).run();
}

function seedProjects(): void {
  db.insert(projects)
    .values([
      { id: "p1", name: "Arij", gitRepoPath: "/tmp/a", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p2", name: "Ledger", gitRepoPath: "/tmp/l", createdAt: "2026-01-02T00:00:00.000Z" },
    ])
    .run();
}

async function payload() {
  const res = await GET();
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return body.data;
}

describe("GET /api/control-desk", () => {
  beforeEach(() => {
    reset();
    seedProjects();
  });

  it("returns every project with a stable colour slot and a Full Auto flag", async () => {
    db.insert(settings)
      .values({ key: autoModeEnabledSettingKey("p2"), value: "true" })
      .run();

    const data = await payload();
    expect(data.projects.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);
    expect(data.projects[0].shortName).toBe("ARIJ");
    expect(data.projects[0].colorIndex).toBe(0);
    expect(data.projects[0].autoModeEnabled).toBe(false);
    expect(data.projects[1].autoModeEnabled).toBe(true);
  });

  it("joins running and queued sessions across projects, with a clipped log line", async () => {
    db.insert(epics)
      .values([
        { id: "e1", projectId: "p1", title: "SSE stream", readableId: "ARJ-122", status: "in_progress" },
        { id: "e2", projectId: "p2", title: "OFX import", readableId: "LDG-84", status: "todo" },
      ])
      .run();
    db.insert(agentSessions)
      .values([
        {
          id: "s1",
          projectId: "p1",
          epicId: "e1",
          status: "running",
          agentType: "build",
          namedAgentName: "Opus Builder",
          startedAt: today(1),
          createdAt: today(1),
          // Uncapped at the write side: the route must substring it.
          lastNonEmptyText: "x".repeat(5000),
        },
        {
          id: "s2",
          projectId: "p2",
          epicId: "e2",
          status: "queued",
          agentType: "build",
          createdAt: today(2),
        },
      ])
      .run();

    const data = await payload();
    expect(data.working).toHaveLength(1);
    expect(data.working[0].readableId).toBe("ARJ-122");
    expect(data.working[0].agentName).toBe("Opus Builder");
    expect(data.working[0].lastLogLine!.length).toBeLessThanOrEqual(200);
    expect(data.queued).toHaveLength(1);
    expect(data.queued[0].readableId).toBe("LDG-84");
  });

  // The dispatch role must not come from the prompt. It is the biggest column
  // in the database (77 KB average, 5 MB seen) on a route polled every 4 s,
  // AND the substring test it fed was wrong: every prompt carries the project
  // spec, so a spec that mentions merge conflicts turned every build into a
  // MERGE card. Fails with the pre-fix `prompt.includes("merge conflict")`.
  it("reads no prompt: a build whose spec mentions merge conflicts stays a BUILD", async () => {
    db.insert(epics)
      .values({ id: "e1", projectId: "p1", title: "SSE stream", readableId: "ARJ-122", status: "in_progress" })
      .run();
    db.insert(agentSessions)
      .values({
        id: "s1",
        projectId: "p1",
        epicId: "e1",
        status: "running",
        agentType: "ticket_build",
        mode: "code",
        orchestrationMode: "solo",
        prompt: `${"spec filler ".repeat(4000)}- hard parking after unresolved merge conflicts.`,
        startedAt: today(1),
        createdAt: today(1),
      })
      .run();

    const data = await payload();
    expect(data.working).toHaveLength(1);
    expect(data.working[0].taskType).toBe("BUILD");
  });

  it("rolls up today's shipped tickets, cost and session counts", async () => {
    db.insert(epics)
      .values({ id: "e1", projectId: "p1", title: "T", status: "done" })
      .run();
    db.insert(ticketActivityLog)
      .values([
        {
          id: "l1",
          projectId: "p1",
          epicId: "e1",
          fromStatus: "to_merge",
          toStatus: "done",
          actor: "agent",
          createdAt: today(3),
        },
        {
          id: "l2",
          projectId: "p1",
          epicId: "e1",
          fromStatus: "review",
          toStatus: "to_merge",
          actor: "agent",
          createdAt: today(4),
        },
      ])
      .run();
    db.insert(agentSessions)
      .values([
        { id: "s1", projectId: "p1", epicId: "e1", status: "completed", totalCostUsd: 1.25, createdAt: today(5) },
        { id: "s2", projectId: "p2", status: "failed", totalCostUsd: 0.15, createdAt: today(6) },
      ])
      .run();

    const data = await payload();
    expect(data.today.ticketsShipped).toBe(1);
    expect(data.today.failedSessions).toBe(1);
    expect(data.today.costUsd).toBeCloseTo(1.4);
    expect(data.today.projects).toBe(2);
    expect(data.today.sessions).toBe(2);
  });

  it("reports an em-dash-able null when nothing reported a cost", async () => {
    db.insert(agentSessions)
      .values({ id: "s1", projectId: "p1", status: "completed", createdAt: today(7) })
      .run();
    const data = await payload();
    // SUM() over rows with no cost answers NULL, and NULL must reach the tile.
    expect(data.today.costUsd).toBeNull();
    expect(data.today.sessions).toBe(1);
  });

  it("answers 0 failures on a quiet day, not an em-dash", async () => {
    // COUNT over an empty range is 0 but a bare SUM is NULL, and the tile
    // renders NULL as an em-dash. "— failed" beside "0 sessions" is a figure
    // the desk HAS, printed as one it does not.
    const empty = await payload();
    expect(empty.today.sessions).toBe(0);
    expect(empty.today.failedSessions).toBe(0);

    db.insert(agentSessions)
      .values({ id: "s1", projectId: "p1", status: "completed", createdAt: today(8) })
      .run();
    const quiet = await payload();
    expect(quiet.today.sessions).toBe(1);
    expect(quiet.today.failedSessions).toBe(0);
  });

  // The latest-comment and latest-session facts used to be ROW_NUMBER windows
  // over whole tables (`ORDER BY created_at DESC, id DESC`). They are now
  // MAX(created_at) per epic joined back, with the `id DESC` half applied in
  // JS — so the same-timestamp tie must still resolve the same way.
  it("breaks a same-timestamp tie on the id, as the window did", async () => {
    db.insert(epics)
      .values({ id: "e1", projectId: "p1", title: "Renderer", readableId: "ARJ-24", status: "review" })
      .run();
    db.insert(agentSessions)
      .values([
        // Same createdAt; "s-a" < "s-b", so the question must lose to the
        // clean run and the ticket must NOT read as awaiting a reply.
        {
          id: "s-a",
          projectId: "p1",
          epicId: "e1",
          status: "completed",
          outcome: "asked_question",
          endedAt: today(8),
          createdAt: today(8),
        },
        {
          id: "s-b",
          projectId: "p1",
          epicId: "e1",
          status: "completed",
          outcome: "delivered",
          endedAt: today(8),
          createdAt: today(8),
        },
      ])
      .run();
    db.insert(ticketComments)
      .values([
        { id: "c-a", epicId: "e1", author: "agent", content: "older", createdAt: today(9) },
        { id: "c-b", epicId: "e1", author: "agent", content: "newer", createdAt: today(9) },
      ])
      .run();

    const data = await payload();
    expect(data.yourTurn.awaitingReply).toHaveLength(0);

    // And the comment tie goes the same way: "c-b" wins.
    db.delete(agentSessions).run();
    db.insert(agentSessions)
      .values({
        id: "s-c",
        projectId: "p1",
        epicId: "e1",
        status: "completed",
        outcome: "asked_question",
        endedAt: today(8),
        createdAt: today(8),
      })
      .run();
    const asked = await payload();
    expect(asked.yourTurn.awaitingReply).toHaveLength(1);
    expect(asked.yourTurn.awaitingReply[0].question).toBe("newer");
  });

  it("puts an unanswered agent question in YOUR TURN, across projects", async () => {
    db.insert(epics)
      .values({ id: "e1", projectId: "p2", title: "Renderer", readableId: "LDG-24", status: "review" })
      .run();
    db.insert(agentSessions)
      .values({
        id: "s1",
        projectId: "p2",
        epicId: "e1",
        status: "completed",
        outcome: "asked_question",
        endedAt: today(8),
        createdAt: today(8),
      })
      .run();
    db.insert(ticketComments)
      .values({
        id: "c1",
        epicId: "e1",
        author: "agent",
        content: "Flag ou suppression ?",
        createdAt: today(8),
      })
      .run();

    const data = await payload();
    expect(data.yourTurn.awaitingReply).toHaveLength(1);
    expect(data.yourTurn.awaitingReply[0].projectId).toBe("p2");
    expect(data.yourTurn.awaitingReply[0].question).toBe("Flag ou suppression ?");
    expect(data.yourTurn.awaitingReply[0].unreadAi).toBe(true);
  });

  it("badges the latest failure and forgets one older than the lookback", async () => {
    db.insert(epics)
      .values([
        { id: "e1", projectId: "p1", title: "Recent", status: "todo" },
        { id: "e2", projectId: "p1", title: "Ancient", status: "todo" },
      ])
      .run();
    db.insert(agentSessions)
      .values([
        {
          id: "s1",
          projectId: "p1",
          epicId: "e1",
          status: "failed",
          agentType: "build",
          error: "exit 1",
          createdAt: today(9),
          endedAt: today(9),
        },
        {
          id: "s2",
          projectId: "p1",
          epicId: "e2",
          status: "failed",
          agentType: "build",
          error: "ancient history",
          createdAt: longAgo(),
          endedAt: longAgo(),
        },
      ])
      .run();

    const data = await payload();
    expect(data.yourTurn.failed.map((f: { epicId: string }) => f.epicId)).toEqual(["e1"]);
    expect(data.yourTurn.failed[0].error).toBe("exit 1");
  });

  it("lists a ready branch and holds back a conflicted one", async () => {
    db.insert(epics)
      .values([
        {
          id: "e1",
          projectId: "p1",
          title: "Rail",
          readableId: "ARJ-107",
          status: "to_merge",
          branchName: "epic/arj-107",
          prNumber: 218,
        },
        {
          id: "e2",
          projectId: "p2",
          title: "Tax",
          readableId: "LDG-71",
          status: "to_merge",
          branchName: "epic/ldg-71",
        },
      ])
      .run();
    db.insert(userStories)
      .values([
        { id: "u1", epicId: "e1", title: "s", status: "done" },
        { id: "u2", epicId: "e1", title: "s", status: "done" },
      ])
      .run();
    // A merge failure writes no column: this same-state log row is the trace.
    db.insert(ticketActivityLog)
      .values({
        id: "l1",
        projectId: "p2",
        epicId: "e2",
        fromStatus: "to_merge",
        toStatus: "to_merge",
        actor: "system",
        reason: buildMergeBlockedReason({
          branchName: "epic/ldg-71",
          error: "CONFLICT in lib/tax/export.ts",
        }),
        createdAt: today(10),
      })
      .run();

    const data = await payload();
    expect(data.readyToLand.map((r: { epicId: string }) => r.epicId)).toEqual(["e1"]);
    expect(data.readyToLand[0].prNumber).toBe(218);
    expect(data.readyToLand[0].usDone).toBe(2);
    expect(data.readyToLand[0].usCount).toBe(2);
    expect(data.heldBackCount).toBe(1);
    expect(data.yourTurn.conflicts).toHaveLength(1);
    expect(data.yourTurn.conflicts[0].blocker).toBe("merge_conflict");
    expect(data.yourTurn.conflicts[0].branchName).toBe("epic/ldg-71");
  });

  it("withholds the Land affordance while a queued session owns the ticket", async () => {
    db.insert(epics)
      .values({
        id: "e1",
        projectId: "p1",
        title: "Rail",
        status: "to_merge",
        branchName: "epic/arj-107",
      })
      .run();
    db.insert(agentSessions)
      .values({ id: "s1", projectId: "p1", epicId: "e1", status: "queued", createdAt: today(11) })
      .run();

    const data = await payload();
    expect(data.readyToLand[0].agentBusy).toBe(true);
  });

  it("ranks UP NEXT per project, in the supervisor's own order", async () => {
    db.insert(epics)
      .values([
        { id: "a", projectId: "p1", title: "A", readableId: "ARJ-1", status: "todo", position: 0 },
        { id: "b", projectId: "p1", title: "B", readableId: "ARJ-2", status: "in_progress", position: 5 },
        { id: "c", projectId: "p1", title: "C", readableId: "ARJ-3", status: "todo", position: 1 },
        { id: "d", projectId: "p2", title: "D", readableId: "LDG-1", status: "todo", position: 0 },
      ])
      .run();
    // Edges never cross projects, so per-project sets union safely.
    db.insert(ticketDependencies)
      .values({
        id: "dep1",
        ticketId: "a",
        dependsOnTicketId: "c",
        projectId: "p1",
        scopeId: "p1",
      })
      .run();

    const data = await payload();
    const arij = data.upNext.find((row: { projectId: string }) => row.projectId === "p1");
    expect(arij.tickets.map((t: { epicId: string }) => t.epicId)).toEqual(["b", "a", "c"]);
    // In Progress first, then the blocked one loses its rank, then To Do.
    expect(arij.tickets.map((t: { rank: number | null }) => t.rank)).toEqual([1, null, 2]);
    expect(arij.tickets[1].blockedBy).toEqual(["ARJ-3"]);

    const ledger = data.upNext.find((row: { projectId: string }) => row.projectId === "p2");
    expect(ledger.tickets.map((t: { epicId: string }) => t.epicId)).toEqual(["d"]);
  });

  it("answers with empty strata rather than failing on an empty database", async () => {
    reset();
    const data = await payload();
    expect(data.projects).toEqual([]);
    expect(data.working).toEqual([]);
    expect(data.readyToLand).toEqual([]);
    expect(data.upNext).toEqual([]);
    expect(data.today.ticketsShipped).toBe(0);
    expect(typeof data.generatedAt).toBe("string");
  });
});
