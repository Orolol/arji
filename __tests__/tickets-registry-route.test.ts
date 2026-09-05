/**
 * `GET /api/tickets` against the real migrated schema.
 *
 * The sibling `tickets-registry-aggregate.test.ts` covers every derivation
 * from plain objects; this file is the only place the cross-project SQL is
 * actually EXECUTED, which is what proves the queries parse and bind, that the
 * `epicSessionFactsCte` / `blocksMergeSql` project-optional overloads still
 * accept an id scope, and — the highest-value assertion in the file — that the
 * WINDOW and the COUNTS are computed by two different queries, so a windowed
 * group still reports its true total.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db, sqlite } = await import("@/lib/db");
const {
  projects,
  epics,
  userStories,
  agentSessions,
  ticketComments,
  ticketDependencies,
  ticketActivityLog,
  releases,
  reviewComments,
} = await import("@/lib/db/schema");
const { GET } = await import("@/app/api/tickets/route");
const { buildMergeBlockedReason } = await import("@/lib/workflow/merge-failure");
const { REGISTRY_COST_WINDOW_DAYS } = await import("@/lib/tickets-registry/types");
import type { TicketsRegistryPayload } from "@/lib/tickets-registry/types";

function reset(): void {
  db.delete(ticketDependencies).run();
  db.delete(ticketActivityLog).run();
  db.delete(reviewComments).run();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(releases).run();
  db.delete(projects).run();
}

function seedProjects(): void {
  db.insert(projects)
    .values([
      {
        id: "p1",
        name: "Arij",
        gitRepoPath: "/tmp/a",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "p2",
        name: "Ledger",
        gitRepoPath: "/tmp/l",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ])
    .run();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function payload(query = ""): Promise<TicketsRegistryPayload> {
  const res = await GET(new Request(`http://localhost/api/tickets${query}`));
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return body.data as TicketsRegistryPayload;
}

function byId(data: TicketsRegistryPayload) {
  return new Map(data.rows.map((row) => [row.epicId, row]));
}

beforeEach(() => {
  reset();
  seedProjects();
});

describe("the seven statuses", () => {
  it("puts each one in the right group", async () => {
    db.insert(epics)
      .values([
        { id: "e-backlog", projectId: "p1", title: "Backlog one", status: "backlog", position: 0 },
        { id: "e-todo", projectId: "p1", title: "Todo one", status: "todo", position: 1 },
        { id: "e-prog", projectId: "p1", title: "In progress", status: "in_progress", position: 2 },
        { id: "e-review", projectId: "p1", title: "In review", status: "review", position: 3 },
        {
          id: "e-merge",
          projectId: "p1",
          title: "To merge",
          status: "to_merge",
          position: 4,
          branchName: "epic/merge",
        },
        { id: "e-done", projectId: "p1", title: "Done one", status: "done", position: 5 },
        {
          id: "e-rel",
          projectId: "p1",
          title: "Released one",
          status: "released",
          position: 6,
        },
      ])
      .run();

    const data = await payload();
    const rows = byId(data);
    expect(rows.get("e-backlog")!.group).toBe("waiting");
    expect(rows.get("e-todo")!.group).toBe("waiting");
    expect(rows.get("e-prog")!.group).toBe("waiting");
    expect(rows.get("e-review")!.group).toBe("waiting");
    expect(rows.get("e-merge")!.group).toBe("done");
    expect(rows.get("e-merge")!.mergeReady).toBe(true);
    expect(rows.get("e-done")!.group).toBe("done");
    expect(rows.get("e-rel")!.group).toBe("released");

    expect(data.counts.all).toBe(7);
    expect(data.counts.open).toBe(4);
    expect(data.counts.done).toBe(2);
    expect(data.counts.released).toBe(1);
    expect(data.totals.tickets).toBe(7);
    expect(data.totals.projects).toBe(2);
  });

  it("promotes a running session to ACTIVE and an unanswered question to YOUR TURN", async () => {
    db.insert(epics)
      .values([
        { id: "e1", projectId: "p1", title: "Live", status: "in_progress", position: 0 },
        { id: "e2", projectId: "p1", title: "Asked", status: "review", position: 1 },
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
          startedAt: daysAgo(0),
          createdAt: daysAgo(0),
          lastNonEmptyText: "editing lib/sse/stream.ts",
        },
        {
          id: "s2",
          projectId: "p1",
          epicId: "e2",
          status: "completed",
          agentType: "build",
          outcome: "asked_question",
          endedAt: daysAgo(1),
          createdAt: daysAgo(1),
        },
      ])
      .run();

    const rows = byId(await payload());
    expect(rows.get("e1")!.group).toBe("active");
    expect(rows.get("e1")!.taskType).toBe("BUILD");
    expect(rows.get("e1")!.activity).toBe("› editing lib/sse/stream.ts");
    expect(rows.get("e2")!.group).toBe("your_turn");
    expect(rows.get("e2")!.yourTurnKind).toBe("asks");
  });

  it("routes a live merge conflict on a to_merge epic to YOUR TURN", async () => {
    db.insert(epics)
      .values({
        id: "e1",
        projectId: "p1",
        title: "Tax export",
        status: "to_merge",
        position: 0,
        branchName: "epic/tax",
      })
      .run();
    db.insert(ticketActivityLog)
      .values({
        id: "a1",
        projectId: "p1",
        epicId: "e1",
        fromStatus: "to_merge",
        toStatus: "to_merge",
        actor: "agent",
        reason: buildMergeBlockedReason({
          branchName: "epic/tax",
          error: "CONFLICT (content): Merge conflict in lib/x.ts",
        }),
        createdAt: daysAgo(1),
      })
      .run();

    const rows = byId(await payload());
    expect(rows.get("e1")!.group).toBe("your_turn");
    expect(rows.get("e1")!.yourTurnKind).toBe("conflict");
    expect(rows.get("e1")!.activity).toContain("epic/tax · ");
  });
});

describe("the window and the counts are two different queries", () => {
  beforeEach(() => {
    db.insert(epics)
      .values(
        Array.from({ length: 5 }, (_, index) => ({
          id: `d${index}`,
          projectId: "p1",
          title: `Done ${index}`,
          status: "done",
          position: index,
          updatedAt: `2026-08-2${index}T00:00:00.000Z`,
        })),
      )
      .run();
  });

  it("doneLimit=1 ships one row while groupTotals.done reports the truth", async () => {
    const data = await payload("?doneLimit=1");
    expect(data.groupLoaded.done).toBe(1);
    expect(data.groupTotals.done).toBe(5);
    expect(data.counts.done).toBe(5);
    // The window is ordered by recency, so the default sort is exact.
    expect(data.rows[0].epicId).toBe("d4");
  });

  it("raising the window ships the rest", async () => {
    const data = await payload("?doneLimit=500");
    expect(data.groupLoaded.done).toBe(5);
    expect(data.groupTotals.done).toBe(5);
  });

  it("clamps a hostile limit", async () => {
    const low = await payload("?doneLimit=0");
    expect(low.groupLoaded.done).toBe(1);
    const high = await payload("?doneLimit=99999");
    expect(high.groupLoaded.done).toBe(5);
    const nonsense = await payload("?doneLimit=abc");
    expect(nonsense.groupLoaded.done).toBe(5);
  });
});

describe("released rows", () => {
  it("carry their release version, or null when release_id is null", async () => {
    db.insert(releases)
      .values({ id: "r1", projectId: "p1", version: "v0.4.2", createdAt: daysAgo(4) })
      .run();
    db.insert(epics)
      .values([
        {
          id: "e1",
          projectId: "p1",
          title: "Dashboard band counters",
          status: "released",
          position: 0,
          releaseId: "r1",
          updatedAt: daysAgo(4),
        },
        {
          id: "e2",
          projectId: "p1",
          title: "Session artifact gallery",
          status: "released",
          position: 1,
          updatedAt: daysAgo(5),
        },
      ])
      .run();

    const rows = byId(await payload());
    expect(rows.get("e1")!.releaseVersion).toBe("v0.4.2");
    expect(rows.get("e2")!.releaseVersion).toBeNull();
  });
});

describe("cost", () => {
  it("reaches the row, and an epic with no session carries null — never 0", async () => {
    db.insert(epics)
      .values([
        { id: "e1", projectId: "p1", title: "Billed", status: "todo", position: 0 },
        { id: "e2", projectId: "p1", title: "Unbilled", status: "todo", position: 1 },
      ])
      .run();
    db.insert(agentSessions)
      .values([
        {
          id: "s1",
          projectId: "p1",
          epicId: "e1",
          status: "completed",
          agentType: "build",
          totalCostUsd: 0.5,
          createdAt: daysAgo(1),
        },
        {
          id: "s2",
          projectId: "p1",
          epicId: "e1",
          status: "completed",
          agentType: "build",
          totalCostUsd: 0.34,
          createdAt: daysAgo(2),
        },
      ])
      .run();

    const rows = byId(await payload());
    expect(rows.get("e1")!.costUsd).toBeCloseTo(0.84, 5);
    expect(rows.get("e2")!.costUsd).toBeNull();
  });

  it("the 30-day total is null on a quiet month and a number when something billed", async () => {
    db.insert(epics)
      .values({ id: "e1", projectId: "p1", title: "T", status: "todo", position: 0 })
      .run();
    expect((await payload()).totals.cost30dUsd).toBeNull();

    db.insert(agentSessions)
      .values({
        id: "s-old",
        projectId: "p1",
        epicId: "e1",
        status: "completed",
        agentType: "build",
        totalCostUsd: 9.99,
        createdAt: daysAgo(REGISTRY_COST_WINDOW_DAYS + 5),
      })
      .run();
    expect((await payload()).totals.cost30dUsd).toBeNull();

    db.insert(agentSessions)
      .values({
        id: "s-new",
        projectId: "p1",
        epicId: "e1",
        status: "completed",
        agentType: "build",
        totalCostUsd: 1.25,
        createdAt: daysAgo(2),
      })
      .run();
    expect((await payload()).totals.cost30dUsd).toBeCloseTo(1.25, 5);
  });
});

describe("query parameters", () => {
  beforeEach(() => {
    db.insert(epics)
      .values([
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `r${index}`,
          projectId: "p1",
          title: `Recent released ${index}`,
          readableId: `ARJ-${index}`,
          status: "released",
          position: index,
          updatedAt: `2026-08-2${index + 5}T00:00:00.000Z`,
        })),
        {
          id: "r-old",
          projectId: "p1",
          title: "OFX parser rewrite",
          readableId: "ARJ-9",
          status: "released",
          position: 9,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        { id: "l1", projectId: "p2", title: "Ledger todo", status: "todo", position: 0 },
      ])
      .run();
  });

  it("?q= reaches a released ticket outside the default window", async () => {
    const windowed = await payload("?releasedLimit=1");
    expect(windowed.rows.map((row) => row.epicId)).not.toContain("r-old");

    const searched = await payload("?releasedLimit=1&q=OFX");
    expect(searched.rows.map((row) => row.epicId)).toContain("r-old");
  });

  it("?q= treats % and _ as literals", async () => {
    const data = await payload("?q=%25");
    expect(data.rows.filter((row) => row.status === "released")).toHaveLength(0);
  });

  it("?project= narrows every group and the counts", async () => {
    const all = await payload();
    expect(all.counts.all).toBe(5);
    expect(all.totals.projects).toBe(2);

    const scoped = await payload("?project=p2");
    expect(scoped.rows.map((row) => row.epicId)).toEqual(["l1"]);
    expect(scoped.counts.all).toBe(1);
    expect(scoped.counts.released).toBe(0);
    expect(scoped.totals.projects).toBe(1);
    // The project list stays whole: colorIndex is a position in creation
    // order, so narrowing it would repaint the ticket chips.
    expect(scoped.projects.map((project) => project.id)).toEqual(["p1", "p2"]);
  });
});

describe("story counts", () => {
  it("reach the row without inventing a 0/0", async () => {
    db.insert(epics)
      .values([
        { id: "e1", projectId: "p1", title: "With stories", status: "todo", position: 0 },
        { id: "e2", projectId: "p1", title: "No stories", status: "todo", position: 1 },
      ])
      .run();
    db.insert(userStories)
      .values([
        { id: "u1", epicId: "e1", title: "one", status: "done", position: 0 },
        { id: "u2", epicId: "e1", title: "two", status: "todo", position: 1 },
      ])
      .run();

    const rows = byId(await payload());
    expect(rows.get("e1")!.usDone).toBe(1);
    expect(rows.get("e1")!.usCount).toBe(2);
    expect(rows.get("e2")!.usCount).toBe(0);
  });
});

describe("dependency edges", () => {
  it("resolve blocked-by to readable labels", async () => {
    db.insert(epics)
      .values([
        {
          id: "e1",
          projectId: "p1",
          title: "Prerequisite",
          readableId: "ARJ-128",
          status: "todo",
          position: 0,
        },
        {
          id: "e2",
          projectId: "p1",
          title: "Dependent",
          readableId: "ARJ-125",
          status: "todo",
          position: 1,
        },
      ])
      .run();
    db.insert(ticketDependencies)
      .values({
        id: "d1",
        projectId: "p1",
        ticketId: "e2",
        dependsOnTicketId: "e1",
        scopeType: "project",
        scopeId: "p1",
      })
      .run();

    const rows = byId(await payload());
    expect(rows.get("e2")!.blockedBy).toEqual(["ARJ-128"]);
    expect(rows.get("e1")!.queueRank).toBe(1);
    expect(rows.get("e2")!.queueRank).toBeNull();
  });
});

describe("scan-discipline regression guards", () => {
  it("never selects agent_sessions.prompt or epics.description", async () => {
    const statements: string[] = [];
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(function (
      this: typeof sqlite,
      source: string,
      ...rest: unknown[]
    ) {
      statements.push(source);
      return (
        Object.getPrototypeOf(sqlite).prepare as (
          this: typeof sqlite,
          source: string,
          ...rest: unknown[]
        ) => unknown
      ).call(this, source, ...rest);
    } as never);

    try {
      db.insert(epics)
        .values({
          id: "e1",
          projectId: "p1",
          title: "T",
          description: "a very long agent-written markdown body",
          status: "to_merge",
          position: 0,
          branchName: "epic/e1",
        })
        .run();
      statements.length = 0;
      await payload();
    } finally {
      spy.mockRestore();
    }

    expect(statements.length).toBeGreaterThan(0);
    for (const source of statements) {
      expect(source).not.toMatch(/"prompt"/);
      expect(source).not.toMatch(/"description"/);
    }
  });

  /**
   * `agent_sessions` has exactly two secondary indexes. Every scan of it must
   * carry the leading key of ONE of them: `project_id` for the time-bounded
   * cross-project reads, or `epic_id` for the per-epic facts (which is what
   * `epicSessionFactsCte(db, null, { epicIds })` supplies, and the only reason
   * a null project is safe there). A scan carrying neither is the full-table
   * read on the shared synchronous connection this rule exists to prevent.
   */
  it("bounds every agent_sessions scan by an index leading key", async () => {
    const statements: string[] = [];
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(function (
      this: typeof sqlite,
      source: string,
      ...rest: unknown[]
    ) {
      statements.push(source);
      return (
        Object.getPrototypeOf(sqlite).prepare as (
          this: typeof sqlite,
          source: string,
          ...rest: unknown[]
        ) => unknown
      ).call(this, source, ...rest);
    } as never);

    try {
      db.insert(epics)
        .values({ id: "e1", projectId: "p1", title: "T", status: "todo", position: 0 })
        .run();
      statements.length = 0;
      await payload();
    } finally {
      spy.mockRestore();
    }

    const sessionScans = statements.filter((source) =>
      source.includes('from "agent_sessions"'),
    );
    expect(sessionScans.length).toBeGreaterThan(0);
    for (const source of sessionScans) {
      expect(source).toMatch(/"(project_id|epic_id)" in \(/);
    }
  });
});

describe("an empty board", () => {
  it("answers zeros for counts and an em-dash-able null for cost", async () => {
    const data = await payload();
    expect(data.rows).toEqual([]);
    expect(data.counts.all).toBe(0);
    expect(data.totals.cost30dUsd).toBeNull();
  });

  it("answers an empty payload when no project exists at all", async () => {
    db.delete(projects).run();
    const data = await payload();
    expect(data.projects).toEqual([]);
    expect(data.totals.projects).toBe(0);
  });
});

describe("column sorting before terminal pagination", () => {
  it.each(["done", "released"] as const)("finds older %s tickets outside the recency window", async (status) => {
    db.insert(epics).values([
      { id: "old", projectId: "p1", title: "Alpha", readableId: "ARJ-001", status, priority: 3, updatedAt: daysAgo(30) },
      { id: "new", projectId: "p1", title: "Zulu", readableId: "ARJ-002", status, priority: 1, updatedAt: daysAgo(1) },
      { id: "foreign", projectId: "p2", title: "Aardvark", status, priority: 3 },
    ]).run();
    db.insert(userStories).values({ id: "us", epicId: "old", title: "Story" }).run();
    db.insert(agentSessions).values({ id: "cost", projectId: "p1", epicId: "old", agentType: "build", status: "completed", totalCostUsd: 9 }).run();
    const query = `?project=p1&${status}Limit=1`;
    for (const [sort, direction] of [["ticket", "asc"], ["titre", "asc"], ["priorite", "desc"], ["stories", "desc"], ["cout", "desc"], ["activite", "asc"]]) {
      const data = await payload(`${query}&sort=${sort}&direction=${direction}`);
      expect(data.rows.map((row) => row.epicId), sort).toEqual(["old"]);
      expect(data.groupTotals[status]).toBe(2);
    }
    for (const [sort, direction] of [["ticket", "desc"], ["titre", "desc"], ["priorite", "asc"], ["stories", "asc"], ["activite", "desc"]]) {
      expect((await payload(`${query}&sort=${sort}&direction=${direction}`)).rows.map((row) => row.epicId), sort).toEqual(["new"]);
    }
    // Unknown query values keep the default recency order.
    expect((await payload(`${query}&sort=invalid&direction=invalid`)).rows[0].epicId).toBe("new");
  });
});

it("filters exact status before counting, and preserves terminal pagination", async () => {
  db.insert(epics).values([
    { id: "ready", projectId: "p1", title: "Ready", status: "to_merge" },
    ...Array.from({ length: 45 }, (_, index) => ({ id: `done-${index}`, projectId: "p1", title: `Done ${index}`, status: "done" })),
    { id: "other", projectId: "p2", title: "Other", status: "done" },
  ]).run();
  const first = await payload("?project=p1&status=done");
  expect(first.rows).toHaveLength(40);
  expect(first.rows.every((row) => row.status === "done")).toBe(true);
  expect(first.groupTotals.done).toBe(45);
  expect(first.counts.all).toBe(45);
  expect((await payload("?project=p1&status=done&doneLimit=45")).rows).toHaveLength(45);
  const ready = await payload("?project=p1&status=to_merge");
  expect(ready.rows.map((row) => row.epicId)).toEqual(["ready"]);
  expect(ready.counts.all).toBe(1);
  expect((await payload("?project=p1&status=released")).counts.all).toBe(0);
});
