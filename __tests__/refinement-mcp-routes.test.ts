/**
 * Tests for the board-refinement MCP routes: set_priority, reorder_tickets,
 * add_dependency, remove_dependency and promote_ticket.
 *
 * Real handlers against an isolated in-memory database built from the real
 * migration chain, with real tokens from the MCP token store — the same
 * harness as mcp-routes.test.ts.
 *
 * The three contracts under test are the story's acceptance criteria:
 *   1. availability is restricted to non-chat session tokens;
 *   2. every call requires a justification, and it lands in
 *      ticket_activity_log with the agent as actor;
 *   3. writes never reach a column outside Backlog / To do, and the
 *      dependency tools reuse the existing DAG validation (cycles refused).
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
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  _resetMcpTokenStoreForTests,
  mintMcpToken,
} from "@/lib/mcp/token-store";
import { eq } from "drizzle-orm";

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
import { POST as setPriority } from "@/app/api/mcp/set-priority/route";
import { POST as reorderTicketsRoute } from "@/app/api/mcp/reorder-tickets/route";
import { POST as addDependency } from "@/app/api/mcp/add-dependency/route";
import { POST as removeDependency } from "@/app/api/mcp/remove-dependency/route";
import { POST as promoteTicket } from "@/app/api/mcp/promote-ticket/route";

type RouteHandler = (request: NextRequest) => Promise<Response>;

let projectId: string;
let otherProjectId: string;
let backlogA: string;
let backlogB: string;
let todoA: string;
let inProgressId: string;
let doneId: string;
let foreignId: string;
let sessionId: string;
let token: string;
let chatToken: string;

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

function statusOf(id: string): string | null {
  return db().select().from(epics).where(eq(epics.id, id)).get()?.status ?? null;
}

function activityFor(id: string) {
  return db()
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, id))
    .all();
}

beforeEach(() => {
  testDb.instance = createTestDb();
  _resetMcpTokenStoreForTests();

  projectId = createId();
  otherProjectId = createId();
  backlogA = createId();
  backlogB = createId();
  todoA = createId();
  inProgressId = createId();
  doneId = createId();
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
        id: backlogA,
        projectId,
        title: "Backlog A",
        readableId: "E-main-001",
        status: "backlog",
        priority: 0,
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: backlogB,
        projectId,
        title: "Backlog B",
        readableId: "E-main-002",
        status: "backlog",
        priority: 0,
        position: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: todoA,
        projectId,
        title: "Todo A",
        readableId: "E-main-003",
        status: "todo",
        priority: 1,
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: inProgressId,
        projectId,
        title: "In progress",
        readableId: "E-main-004",
        status: "in_progress",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: doneId,
        projectId,
        title: "Shipped",
        readableId: "E-main-005",
        status: "done",
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
  chatToken = mintMcpToken({
    projectId,
    sessionId,
    agentType: "chat",
  });
});

describe("refinement tools — availability", () => {
  const cases: Array<[string, RouteHandler, Record<string, unknown>]> = [
    ["set_priority", setPriority, { priority: 2 }],
    ["reorder_tickets", reorderTicketsRoute, {}],
    ["add_dependency", addDependency, {}],
    ["remove_dependency", removeDependency, {}],
    ["promote_ticket", promoteTicket, { status: "todo" }],
  ];

  it.each(cases)("%s rejects a missing token with 401", async (_n, handler) => {
    const res = await call(handler, {});
    expect(res.status).toBe(401);
  });

  it.each(cases)(
    "%s rejects a chat token with 403 AGENT_ONLY",
    async (_n, handler, extra) => {
      const res = await call(
        handler,
        { ticket_id: backlogA, reason: "why", ...extra },
        chatToken
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("AGENT_ONLY");
    }
  );

  it.each(cases)("%s refuses a call with no justification", async (_n, handler, extra) => {
    const res = await call(
      handler,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: backlogB,
        items: [{ ticket_id: backlogA, position: 0 }],
        ...extra,
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it.each(cases)("%s refuses a blank justification", async (_n, handler, extra) => {
    const res = await call(
      handler,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: backlogB,
        items: [{ ticket_id: backlogA, position: 0 }],
        reason: "   ",
        ...extra,
      },
      token
    );
    expect(res.status).toBe(400);
  });
});

describe("set_priority", () => {
  it("writes the priority and journals the justification as the agent", async () => {
    const res = await call(
      setPriority,
      { ticket_id: backlogA, priority: 3, reason: "Blocks the release" },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      oldPriority: 0,
      priority: 3,
      changed: true,
    });

    const row = db().select().from(epics).where(eq(epics.id, backlogA)).get();
    expect(row?.priority).toBe(3);

    const entries = activityFor(backlogA);
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe("agent");
    expect(entries[0].fromStatus).toBe("backlog");
    expect(entries[0].toStatus).toBe("backlog");
    expect(entries[0].reason).toContain("Blocks the release");
    expect(entries[0].sessionId).toBe(sessionId);
  });

  it("is a no-op when the priority already matches", async () => {
    const res = await call(
      setPriority,
      { ticket_id: backlogA, priority: 0, reason: "Already right" },
      token
    );
    expect((await res.json()).data.changed).toBe(false);
    expect(activityFor(backlogA)).toHaveLength(0);
  });

  it("refuses a ticket outside Backlog / To do", async () => {
    const res = await call(
      setPriority,
      { ticket_id: inProgressId, priority: 3, reason: "Nope" },
      token
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFINEMENT_STATUS_LOCKED");
  });

  it("refuses a ticket from another project", async () => {
    const res = await call(
      setPriority,
      { ticket_id: foreignId, priority: 3, reason: "Nope" },
      token
    );
    expect(res.status).toBe(404);
  });
});

describe("reorder_tickets", () => {
  it("writes positions and journals each moved ticket", async () => {
    const res = await call(
      reorderTicketsRoute,
      {
        items: [
          { ticket_id: backlogB, position: 0 },
          { ticket_id: backlogA, position: 1 },
        ],
        reason: "B unblocks A",
      },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.updated).toBe(2);

    const rows = db().select().from(epics).all();
    expect(rows.find((r) => r.id === backlogB)?.position).toBe(0);
    expect(rows.find((r) => r.id === backlogA)?.position).toBe(1);

    expect(activityFor(backlogA)[0].reason).toContain("B unblocks A");
    expect(activityFor(backlogB)[0].actor).toBe("agent");
  });

  it("refuses the whole batch when one ticket is out of scope", async () => {
    const res = await call(
      reorderTicketsRoute,
      {
        items: [
          { ticket_id: backlogA, position: 0 },
          { ticket_id: inProgressId, position: 1 },
        ],
        reason: "Mixed batch",
      },
      token
    );
    expect(res.status).toBe(409);
    // Nothing was written for the in-scope ticket either.
    expect(activityFor(backlogA)).toHaveLength(0);
    const row = db().select().from(epics).where(eq(epics.id, backlogA)).get();
    expect(row?.position).toBe(0);
  });

  it("refuses a duplicated ticket id", async () => {
    const res = await call(
      reorderTicketsRoute,
      {
        items: [
          { ticket_id: backlogA, position: 0 },
          { ticket_id: backlogA, position: 1 },
        ],
        reason: "Ambiguous",
      },
      token
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DUPLICATE_TICKET");
  });
});

describe("add_dependency / remove_dependency", () => {
  it("creates an edge and journals it on the dependent ticket", async () => {
    const res = await call(
      addDependency,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: backlogB,
        reason: "A needs B's schema",
      },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.created).toBe(true);

    const edges = db().select().from(ticketDependencies).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      ticketId: backlogA,
      dependsOnTicketId: backlogB,
    });

    const entry = activityFor(backlogA)[0];
    expect(entry.actor).toBe("agent");
    expect(entry.reason).toContain("E-main-002");
    expect(entry.reason).toContain("A needs B's schema");
  });

  it("reuses the DAG validation and refuses a cycle", async () => {
    await call(
      addDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogB, reason: "first" },
      token
    );
    const res = await call(
      addDependency,
      { ticket_id: backlogB, depends_on_ticket_id: backlogA, reason: "cycle" },
      token
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DEPENDENCY_CYCLE");
    expect(db().select().from(ticketDependencies).all()).toHaveLength(1);
  });

  it("refuses a self-edge", async () => {
    const res = await call(
      addDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogA, reason: "self" },
      token
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SELF_DEPENDENCY");
  });

  /**
   * The guardrail is about what gets WRITTEN, and only the dependent ticket
   * is written to. "This Backlog ticket builds on the epic already in
   * Review" is the most ordinary dependency there is; refusing it also made
   * an edge to shipped work permanently unprunable.
   */
  it("accepts a prerequisite outside the planning columns", async () => {
    const res = await call(
      addDependency,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: inProgressId,
        reason: "Waits on the in-flight refactor",
      },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.created).toBe(true);

    const edges = db().select().from(ticketDependencies).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      ticketId: backlogA,
      dependsOnTicketId: inProgressId,
    });
    // The activity entry lands on the dependent ticket only.
    expect(activityFor(backlogA)).toHaveLength(1);
    expect(activityFor(inProgressId)).toHaveLength(0);
  });

  it("prunes an edge whose prerequisite has since shipped", async () => {
    await call(
      addDependency,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: doneId,
        reason: "was blocked by it",
      },
      token
    );
    expect(db().select().from(ticketDependencies).all()).toHaveLength(1);

    const res = await call(
      removeDependency,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: doneId,
        reason: "shipped, no longer holds",
      },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
    expect(db().select().from(ticketDependencies).all()).toHaveLength(0);
  });

  it("still refuses when the DEPENDENT ticket is out of scope", async () => {
    const res = await call(
      addDependency,
      {
        ticket_id: inProgressId,
        depends_on_ticket_id: backlogA,
        reason: "writing to in-flight work",
      },
      token
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFINEMENT_STATUS_LOCKED");
    expect(db().select().from(ticketDependencies).all()).toHaveLength(0);
  });

  it("still 404s a prerequisite from another project", async () => {
    const res = await call(
      addDependency,
      {
        ticket_id: backlogA,
        depends_on_ticket_id: foreignId,
        reason: "cross-project",
      },
      token
    );
    expect(res.status).toBe(404);
    expect(db().select().from(ticketDependencies).all()).toHaveLength(0);
  });

  it("does not journal a duplicate edge as a change", async () => {
    await call(
      addDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogB, reason: "first" },
      token
    );
    const res = await call(
      addDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogB, reason: "again" },
      token
    );
    expect((await res.json()).data.created).toBe(false);
    expect(activityFor(backlogA)).toHaveLength(1);
  });

  it("removes an edge and journals it", async () => {
    await call(
      addDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogB, reason: "first" },
      token
    );
    const res = await call(
      removeDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogB, reason: "stale" },
      token
    );
    expect((await res.json()).data.removed).toBe(true);
    expect(db().select().from(ticketDependencies).all()).toHaveLength(0);
    expect(activityFor(backlogA)).toHaveLength(2);
  });

  it("reports a missing edge as a no-op without journalling", async () => {
    const res = await call(
      removeDependency,
      { ticket_id: backlogA, depends_on_ticket_id: backlogB, reason: "stale" },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(false);
    expect(activityFor(backlogA)).toHaveLength(0);
  });
});

describe("promote_ticket", () => {
  it("promotes backlog → todo and journals the move as the agent", async () => {
    const res = await call(
      promoteTicket,
      { ticket_id: backlogA, status: "todo", reason: "Spec is settled" },
      token
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      fromStatus: "backlog",
      status: "todo",
      changed: true,
    });
    expect(statusOf(backlogA)).toBe("todo");

    const entry = activityFor(backlogA).at(-1)!;
    expect(entry.actor).toBe("agent");
    expect(entry.fromStatus).toBe("backlog");
    expect(entry.toStatus).toBe("todo");
    expect(entry.reason).toContain("Spec is settled");
  });

  /**
   * Regression: `position` is a per-column 0-based index and the transition
   * service never touches it, so a ticket promoted from Backlog index 0
   * used to land in To do still holding 0 — tying with whatever sat there.
   * The board breaks that tie by fetch order and the execution queue is
   * derived from it, so a promoted ticket could silently take rank #1.
   */
  it("appends the promoted ticket to the bottom of To do", async () => {
    // todoA already occupies To do position 0; backlogA holds Backlog 0.
    const res = await call(
      promoteTicket,
      { ticket_id: backlogA, status: "todo", reason: "Ready now" },
      token
    );
    expect(res.status).toBe(200);

    const promoted = db()
      .select()
      .from(epics)
      .where(eq(epics.id, backlogA))
      .get();
    const incumbent = db().select().from(epics).where(eq(epics.id, todoA)).get();

    expect(incumbent!.position).toBe(0);
    expect(promoted!.position).toBe(1);
    // No collision: the promoted ticket cannot take the incumbent's rank.
    expect(promoted!.position!).toBeGreaterThan(incumbent!.position!);
  });

  it("appends a demoted ticket to the bottom of Backlog", async () => {
    // Backlog already holds positions 0 and 1.
    await call(
      promoteTicket,
      {
        ticket_id: todoA,
        status: "backlog",
        reason: "Not ready",
        question: "Which provider?",
      },
      token
    );

    const demoted = db().select().from(epics).where(eq(epics.id, todoA)).get();
    expect(demoted!.status).toBe("backlog");
    expect(demoted!.position).toBe(2);
  });

  it("gives position 0 when the destination column is empty", async () => {
    // Empty To do first.
    await call(
      promoteTicket,
      {
        ticket_id: todoA,
        status: "backlog",
        reason: "clear the column",
        question: "Which provider?",
      },
      token
    );

    await call(
      promoteTicket,
      { ticket_id: backlogA, status: "todo", reason: "first in" },
      token
    );
    const promoted = db()
      .select()
      .from(epics)
      .where(eq(epics.id, backlogA))
      .get();
    expect(promoted!.position).toBe(0);
  });

  it("requires the missing question when demoting", async () => {
    const res = await call(
      promoteTicket,
      { ticket_id: todoA, status: "backlog", reason: "Not ready" },
      token
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MISSING_QUESTION");
    expect(statusOf(todoA)).toBe("todo");
  });

  it("demotes with the question posted on the ticket", async () => {
    const res = await call(
      promoteTicket,
      {
        ticket_id: todoA,
        status: "backlog",
        reason: "Acceptance criteria are ambiguous",
        question: "Which auth provider should this use?",
      },
      token
    );
    expect(res.status).toBe(200);
    expect(statusOf(todoA)).toBe("backlog");

    const comments = db()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, todoA))
      .all();
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("agent");
    expect(comments[0].agentSessionId).toBe(sessionId);
    expect(comments[0].content).toContain("Which auth provider should this use?");
  });

  it("cannot reach a column outside Backlog / To do", async () => {
    const res = await call(
      promoteTicket,
      { ticket_id: backlogA, status: "in_progress", reason: "nope" },
      token
    );
    // Rejected by the schema — in_progress is not an accepted target.
    expect(res.status).toBe(400);
    expect(statusOf(backlogA)).toBe("backlog");
  });

  it("cannot move a ticket that is already outside those columns", async () => {
    const res = await call(
      promoteTicket,
      { ticket_id: inProgressId, status: "todo", reason: "nope" },
      token
    );
    expect(res.status).toBe(409);
    expect(statusOf(inProgressId)).toBe("in_progress");
  });

  it("is a reported no-op when the ticket is already in the target column", async () => {
    const res = await call(
      promoteTicket,
      { ticket_id: todoA, status: "todo", reason: "already there" },
      token
    );
    expect((await res.json()).data.changed).toBe(false);
    expect(activityFor(todoA)).toHaveLength(0);
  });
});
