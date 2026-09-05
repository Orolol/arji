/**
 * The three refinement tools that create or destroy board rows:
 * merge_tickets, discard_ticket and create_planning_ticket.
 *
 * Real handlers against an isolated in-memory database built from the real
 * migration chain (`foreign_keys = ON`), with real tokens from the MCP token
 * store — the same harness as refinement-mcp-routes.test.ts.
 *
 * What these assert, beyond the shared refinement contract (agent-only,
 * justification required, Backlog/To do only):
 *
 *   1. they are refused for every agent type EXCEPT a refinement pass —
 *      a build session must not be able to delete the board;
 *   2. a delete never destroys agent history, and never silently unblocks a
 *      dependent;
 *   3. a merge carries the absorbed tickets' scope across — stories, the
 *      user's own comments, dependency edges — and leaves their full text
 *      behind before the sources are deleted;
 *   4. a refused merge writes NOTHING, because there is no retry against a
 *      half-absorbed cluster.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";
import {
  agentSessions,
  epics,
  projects,
  ticketActivityLog,
  ticketComments,
  ticketDependencies,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
} from "@/lib/mcp/token-store";
import { and, eq } from "drizzle-orm";

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

// arji.json export touches the filesystem for a repo this test has none of.
vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

// ---- Import route handlers AFTER mocks ----
import { POST as mergeTickets } from "@/app/api/mcp/merge-tickets/route";
import { POST as discardTicket } from "@/app/api/mcp/discard-ticket/route";
import { POST as createPlanningTicket } from "@/app/api/mcp/create-planning-ticket/route";
import { MAX_REFINEMENT_CREATED_TICKETS } from "@/app/api/mcp/create-planning-ticket/route";
import {
  _resetRefinementRegistryForTests,
  peekRefinementChanges,
} from "@/lib/refinement/registry";

type RouteHandler = (request: NextRequest) => Promise<Response>;

let projectId: string;
let otherProjectId: string;
let targetId: string;
let sourceId: string;
let secondSourceId: string;
let todoId: string;
let inProgressId: string;
let foreignId: string;
let sessionId: string;
let token: string;
let chatToken: string;
let buildToken: string;

function call(handler: RouteHandler, body: unknown, bearer?: string) {
  return handler(
    mockNextRequest({
      url: "http://localhost:3000/api/mcp/test",
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
    })
  );
}

function db() {
  return testDb.instance!.db;
}

function epicRow(id: string) {
  return db().select().from(epics).where(eq(epics.id, id)).get();
}

function storiesOf(id: string) {
  return db()
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, id))
    .all()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function commentsOf(id: string) {
  return db().select().from(ticketComments).where(eq(ticketComments.epicId, id)).all();
}

function activityFor(id: string) {
  return db()
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, id))
    .all();
}

function edges() {
  return db()
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .all();
}

function addEdge(ticketId: string, dependsOnTicketId: string) {
  db()
    .insert(ticketDependencies)
    .values({
      id: createId(),
      ticketId,
      dependsOnTicketId,
      projectId,
      scopeType: "project",
      scopeId: projectId,
      createdAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();
  _resetRefinementRegistryForTests();

  projectId = createId();
  otherProjectId = createId();
  targetId = createId();
  sourceId = createId();
  secondSourceId = createId();
  todoId = createId();
  inProgressId = createId();
  foreignId = createId();
  sessionId = createId();

  const now = new Date().toISOString();

  db()
    .insert(projects)
    .values([
      { id: projectId, name: "Main", createdAt: now, updatedAt: now },
      { id: otherProjectId, name: "Other", createdAt: now, updatedAt: now },
    ])
    .run();

  db()
    .insert(epics)
    .values([
      {
        id: targetId,
        projectId,
        title: "Search",
        description: "Search the board",
        readableId: "E-main-001",
        status: "backlog",
        priority: 1,
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: sourceId,
        projectId,
        title: "Search filters",
        description: "Filter the search results",
        readableId: "E-main-002",
        status: "backlog",
        priority: 0,
        position: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: secondSourceId,
        projectId,
        title: "Search sorting",
        readableId: "E-main-003",
        status: "todo",
        priority: 0,
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: todoId,
        projectId,
        title: "Unrelated",
        readableId: "E-main-004",
        status: "todo",
        priority: 0,
        position: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: inProgressId,
        projectId,
        title: "In progress",
        readableId: "E-main-005",
        status: "in_progress",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: foreignId,
        projectId: otherProjectId,
        title: "Foreign",
        readableId: "E-other-001",
        status: "backlog",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  db()
    .insert(userStories)
    .values([
      {
        id: createId(),
        epicId: targetId,
        title: "Target story",
        status: "todo",
        position: 0,
        createdAt: now,
      },
      {
        id: createId(),
        epicId: sourceId,
        title: "Filter by status",
        acceptanceCriteria: "Given a status filter, only matching rows show",
        status: "todo",
        position: 0,
        createdAt: now,
      },
      {
        id: createId(),
        epicId: sourceId,
        title: "Filter by owner",
        status: "todo",
        position: 1,
        createdAt: now,
      },
    ])
    .run();

  db()
    .insert(agentSessions)
    .values({
      id: sessionId,
      projectId,
      status: "running",
      agentType: "refinement",
      createdAt: now,
    })
    .run();

  token = mintMcpToken({ projectId, sessionId, agentType: "refinement" });
  chatToken = mintMcpToken({ projectId, sessionId, agentType: "chat" });
  buildToken = mintMcpToken({ projectId, sessionId, agentType: "build" });
});

describe("availability", () => {
  const cases: Array<[string, RouteHandler, Record<string, unknown>]> = [
    ["merge_tickets", mergeTickets, {}],
    ["discard_ticket", discardTicket, {}],
    ["create_planning_ticket", createPlanningTicket, { title: "New work" }],
  ];

  it.each(cases)("%s rejects a missing token with 401", async (_n, handler) => {
    expect((await call(handler, {})).status).toBe(401);
  });

  it.each(cases)(
    "%s rejects a chat token with 403 AGENT_ONLY",
    async (_n, handler, extra) => {
      const res = await call(
        handler,
        { ticket_id: sourceId, source_ticket_ids: [sourceId], reason: "why", ...extra },
        chatToken
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("AGENT_ONLY");
    }
  );

  /**
   * The boundary that matters here: these three delete and create board rows,
   * so a build or review session is refused even though it is a perfectly
   * valid agent session for every other refinement tool.
   */
  it.each(cases)(
    "%s rejects a build session with 403 REFINEMENT_ONLY",
    async (_n, handler, extra) => {
      const res = await call(
        handler,
        {
          ticket_id: sourceId,
          source_ticket_ids: [sourceId],
          reason: "why",
          ...extra,
        },
        buildToken
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("REFINEMENT_ONLY");
      // And the board is untouched.
      expect(epicRow(sourceId)).toBeDefined();
    }
  );

  it.each(cases)("%s refuses a call with no justification", async (_n, handler, extra) => {
    const res = await call(
      handler,
      { ticket_id: sourceId, source_ticket_ids: [secondSourceId], ...extra },
      token
    );
    expect(res.status).toBe(400);
  });

  it.each(cases)("%s refuses a blank justification", async (_n, handler, extra) => {
    const res = await call(
      handler,
      {
        ticket_id: targetId,
        source_ticket_ids: [sourceId],
        reason: "   ",
        ...extra,
      },
      token
    );
    expect(res.status).toBe(400);
  });
});

describe("discard_ticket", () => {
  it("deletes the ticket and its stories, and records the tombstone", async () => {
    const res = await call(
      discardTicket,
      { ticket_id: sourceId, reason: "Search filters shipped with the table rewrite" },
      token
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      ticketId: sourceId,
      ticket: "E-main-002",
      deleted: true,
      storiesDeleted: 2,
    });

    expect(epicRow(sourceId)).toBeUndefined();
    expect(storiesOf(sourceId)).toHaveLength(0);

    const [change] = peekRefinementChanges(sessionId);
    expect(change).toMatchObject({
      kind: "discarded",
      ticketId: sourceId,
      label: "E-main-002",
      ticketGone: true,
    });
    // The tombstone carries what the delete destroyed, verbatim enough to
    // retype the ticket from.
    expect(change.snapshot).toContain("Search filters");
    expect(change.snapshot).toContain("Filter by status");
    expect(change.snapshot).toContain(
      "Given a status filter, only matching rows show"
    );
  });

  it("refuses a ticket outside the planning columns", async () => {
    const res = await call(
      discardTicket,
      { ticket_id: inProgressId, reason: "obsolete" },
      token
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFINEMENT_STATUS_LOCKED");
    expect(epicRow(inProgressId)).toBeDefined();
  });

  it("refuses a ticket from another project", async () => {
    const res = await call(
      discardTicket,
      { ticket_id: foreignId, reason: "obsolete" },
      token
    );
    expect(res.status).toBe(404);
    expect(epicRow(foreignId)).toBeDefined();
  });

  /**
   * `deleteEpicPermanently` deletes the ticket's agent_sessions rows and
   * their comments. That history is the user's record of what an agent did
   * and cannot be reconstructed, so a planning pass may not spend it.
   */
  it("refuses a ticket that carries agent session history", async () => {
    db()
      .insert(agentSessions)
      .values({
        id: createId(),
        projectId,
        epicId: sourceId,
        status: "completed",
        agentType: "build",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await call(
      discardTicket,
      { ticket_id: sourceId, reason: "obsolete" },
      token
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TICKET_HAS_SESSIONS");
    expect(epicRow(sourceId)).toBeDefined();
  });

  it("refuses a ticket whose session hangs off one of its stories", async () => {
    const story = storiesOf(sourceId)[0];
    db()
      .insert(agentSessions)
      .values({
        id: createId(),
        projectId,
        userStoryId: story.id,
        status: "completed",
        agentType: "build",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await call(
      discardTicket,
      { ticket_id: sourceId, reason: "obsolete" },
      token
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TICKET_HAS_SESSIONS");
  });

  /**
   * Deleting a prerequisite drops the edge with it, which would silently
   * unblock a dependent whose prerequisite never happened. The agent has to
   * make that unblocking explicit with remove_dependency first.
   */
  it("refuses while another ticket still depends on it", async () => {
    addEdge(todoId, sourceId);

    const res = await call(
      discardTicket,
      { ticket_id: sourceId, reason: "obsolete" },
      token
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("TICKET_HAS_DEPENDENTS");
    expect(body.error).toContain("E-main-004");
    expect(epicRow(sourceId)).toBeDefined();
  });

  it("removes the edges the discarded ticket itself owned", async () => {
    addEdge(sourceId, todoId);
    expect(edges()).toHaveLength(1);

    const res = await call(
      discardTicket,
      { ticket_id: sourceId, reason: "obsolete" },
      token
    );

    expect(res.status).toBe(200);
    expect(edges()).toHaveLength(0);
  });
});

describe("merge_tickets", () => {
  it("carries stories, user comments and edges across, then deletes the sources", async () => {
    const userComment = createId();
    const agentComment = createId();
    db()
      .insert(ticketComments)
      .values([
        {
          id: userComment,
          epicId: sourceId,
          author: "user",
          content: "Only filter on statuses the user can see",
          createdAt: new Date().toISOString(),
        },
        {
          id: agentComment,
          epicId: sourceId,
          author: "agent",
          content: "Build failed on the filter query",
          createdAt: new Date().toISOString(),
        },
      ])
      .run();

    addEdge(sourceId, todoId);
    addEdge(inProgressId, sourceId);

    const res = await call(
      mergeTickets,
      {
        ticket_id: targetId,
        source_ticket_ids: [sourceId],
        reason: "Filters are one screen with the search itself",
        title: "Search with filters",
        description: "Search the board, with status and owner filters",
      },
      token
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      ticketId: targetId,
      storiesMoved: 2,
      commentsMoved: 1,
      dependencyEdgesRepointed: 2,
    });

    // The source is gone; its scope is not.
    expect(epicRow(sourceId)).toBeUndefined();
    const stories = storiesOf(targetId);
    expect(stories.map((s) => s.title)).toEqual([
      "Target story",
      "Filter by status",
      "Filter by owner",
    ]);
    expect(stories.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(stories[1].acceptanceCriteria).toBe(
      "Given a status filter, only matching rows show"
    );

    // The user's comment moved; the agent's narration of a dead ticket did not.
    const targetComments = commentsOf(targetId);
    expect(targetComments.map((c) => c.id)).toContain(userComment);
    expect(targetComments.map((c) => c.id)).not.toContain(agentComment);

    // Edges point at the survivor in both directions.
    expect(edges()).toEqual(
      expect.arrayContaining([
        { ticketId: targetId, dependsOnTicketId: todoId },
        { ticketId: inProgressId, dependsOnTicketId: targetId },
      ])
    );
    expect(edges()).toHaveLength(2);

    // The merged ticket describes the merged scope.
    const target = epicRow(targetId);
    expect(target?.title).toBe("Search with filters");
    expect(target?.description).toBe(
      "Search the board, with status and owner filters"
    );

    // And the absorbed ticket's full text survives on the survivor.
    const absorption = targetComments.find((c) => c.id !== userComment);
    expect(absorption?.content).toContain("E-main-002");
    expect(absorption?.content).toContain("Filters are one screen");
    expect(absorption?.content).toContain(
      "Given a status filter, only matching rows show"
    );
    expect(absorption?.agentSessionId).toBe(sessionId);

    const activity = activityFor(targetId);
    expect(activity).toHaveLength(1);
    expect(activity[0].actor).toBe("agent");
    expect(activity[0].reason).toContain("Absorbed E-main-002");
    expect(activity[0].reason).toContain("Filters are one screen");

    const [change] = peekRefinementChanges(sessionId);
    expect(change).toMatchObject({ kind: "merged", ticketId: targetId });
    expect(change.ticketGone).toBeUndefined();
  });

  it("leaves the target's own text alone when no rewrite is given", async () => {
    const res = await call(
      mergeTickets,
      {
        ticket_id: targetId,
        source_ticket_ids: [secondSourceId],
        reason: "Sorting belongs with search",
      },
      token
    );

    expect(res.status).toBe(200);
    expect(epicRow(targetId)?.title).toBe("Search");
    expect(epicRow(targetId)?.description).toBe("Search the board");
  });

  it("refuses merging a ticket into itself", async () => {
    const res = await call(
      mergeTickets,
      { ticket_id: targetId, source_ticket_ids: [targetId], reason: "why" },
      token
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SELF_MERGE");
    expect(epicRow(targetId)).toBeDefined();
  });

  /**
   * The pre-flight loop resolves and guards EVERY source before the first
   * write. Without it a three-way merge that trips on its third source has
   * already destroyed the first two, and there is nothing to retry against.
   */
  it("writes nothing when one source of several is out of scope", async () => {
    const res = await call(
      mergeTickets,
      {
        ticket_id: targetId,
        source_ticket_ids: [sourceId, inProgressId],
        reason: "one cluster",
      },
      token
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFINEMENT_STATUS_LOCKED");
    expect(epicRow(sourceId)).toBeDefined();
    expect(storiesOf(sourceId)).toHaveLength(2);
    expect(storiesOf(targetId)).toHaveLength(1);
    expect(commentsOf(targetId)).toHaveLength(0);
    expect(activityFor(targetId)).toHaveLength(0);
  });

  it("writes nothing when a source carries agent session history", async () => {
    db()
      .insert(agentSessions)
      .values({
        id: createId(),
        projectId,
        epicId: secondSourceId,
        status: "failed",
        agentType: "build",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await call(
      mergeTickets,
      {
        ticket_id: targetId,
        source_ticket_ids: [sourceId, secondSourceId],
        reason: "one cluster",
      },
      token
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TICKET_HAS_SESSIONS");
    expect(epicRow(sourceId)).toBeDefined();
    expect(epicRow(secondSourceId)).toBeDefined();
    expect(storiesOf(targetId)).toHaveLength(1);
  });

  /**
   * Re-pointing can close a cycle the original pair did not: the target
   * already depends on the ticket that depended on the source. The merge is
   * otherwise sound, so the edge is dropped and named rather than the whole
   * call failing.
   */
  it("skips a re-pointed edge that would create a cycle, and names it", async () => {
    addEdge(targetId, todoId);
    addEdge(todoId, sourceId);

    const res = await call(
      mergeTickets,
      {
        ticket_id: targetId,
        source_ticket_ids: [sourceId],
        reason: "one cluster",
      },
      token
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skippedEdges).toHaveLength(1);
    expect(body.data.skippedEdges[0]).toContain("cycle");
    expect(epicRow(sourceId)).toBeUndefined();
    // The pre-existing edge survives; no cycle was written.
    expect(edges()).toEqual([{ ticketId: targetId, dependsOnTicketId: todoId }]);
    // And the user still learns which edge was dropped.
    expect(commentsOf(targetId)[0].content).toContain("not carried over");
  });

  it("merges several sources in one call", async () => {
    const res = await call(
      mergeTickets,
      {
        ticket_id: targetId,
        source_ticket_ids: [sourceId, secondSourceId],
        reason: "one search epic",
      },
      token
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.absorbed.map((a: { ticket: string }) => a.ticket)).toEqual([
      "E-main-002",
      "E-main-003",
    ]);
    expect(epicRow(sourceId)).toBeUndefined();
    expect(epicRow(secondSourceId)).toBeUndefined();
    expect(commentsOf(targetId)[0].content).toContain("E-main-003");
  });
});

describe("create_planning_ticket", () => {
  it("creates a Backlog ticket with a readable id, stories and the reason", async () => {
    const res = await call(
      createPlanningTicket,
      {
        title: "Backfill the search index",
        description: "Existing rows are not indexed",
        user_stories: [
          {
            title: "Backfill job",
            acceptance_criteria: "Every pre-existing row is searchable",
          },
        ],
        priority: 2,
        reason: "The search epic only covers new rows",
      },
      token
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({
      title: "Backfill the search index",
      type: "feature",
      status: "backlog",
      priority: 2,
      userStoriesCreated: 1,
    });
    expect(body.data.ticket).toMatch(/^E-main-\d{3}$/);

    const created = epicRow(body.data.ticketId);
    expect(created?.status).toBe("backlog");
    // Appended below the Backlog tickets that are already ranked.
    expect(created?.position).toBe(2);
    expect(storiesOf(body.data.ticketId)[0].acceptanceCriteria).toBe(
      "Every pre-existing row is searchable"
    );

    const activity = activityFor(body.data.ticketId);
    expect(activity).toHaveLength(1);
    expect(activity[0].actor).toBe("agent");
    expect(activity[0].sessionId).toBe(sessionId);
    expect(activity[0].reason).toContain("The search epic only covers new rows");

    const [change] = peekRefinementChanges(sessionId);
    expect(change).toMatchObject({ kind: "created", label: body.data.ticket });
  });

  it("can create straight into To do", async () => {
    const res = await call(
      createPlanningTicket,
      { title: "Ready work", status: "todo", reason: "unblocked and specified" },
      token
    );
    expect(res.status).toBe(201);
    expect(epicRow((await res.json()).data.ticketId)?.status).toBe("todo");
  });

  it("refuses a column refinement does not own", async () => {
    const res = await call(
      createPlanningTicket,
      { title: "Sneaky", status: "in_progress", reason: "why" },
      token
    );
    expect(res.status).toBe(400);
  });

  /** "Missing" is a claim about the board — so it is checked against it. */
  it("refuses a title an undelivered ticket already carries", async () => {
    const res = await call(
      createPlanningTicket,
      { title: "  search   FILTERS!  ", reason: "looks missing" },
      token
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DUPLICATE_TICKET");
    expect(body.existing_ticket.readable_id).toBe("E-main-002");
  });

  it("allows the same title once the original has shipped", async () => {
    db()
      .update(epics)
      .set({ status: "done" })
      .where(eq(epics.id, sourceId))
      .run();

    const res = await call(
      createPlanningTicket,
      { title: "Search filters", reason: "the follow-up half" },
      token
    );
    expect(res.status).toBe(201);
  });

  it("stops at the per-pass cap", async () => {
    for (let i = 0; i < MAX_REFINEMENT_CREATED_TICKETS; i++) {
      const res = await call(
        createPlanningTicket,
        { title: `Gap ${i}`, reason: "missing" },
        token
      );
      expect(res.status).toBe(201);
    }

    const res = await call(
      createPlanningTicket,
      { title: "One gap too many", reason: "missing" },
      token
    );
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("CREATION_LIMIT_REACHED");
    expect(
      db()
        .select()
        .from(epics)
        .where(and(eq(epics.projectId, projectId), eq(epics.title, "One gap too many")))
        .all()
    ).toHaveLength(0);
  });
});
