/**
 * The shared transactional reorder core (lib/workflow/reorder.ts), which the
 * board drag route and the refinement MCP tool both call.
 *
 * Focus: the `reorderOnly` contract. A caller that is only re-ranking passes
 * the column it believes each ticket is in; a ticket that has moved on is
 * skipped rather than dragged back — and the core has to say WHICH ones it
 * wrote, so callers do not journal a move that never happened.
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

const { epics, projects } = await import("@/lib/db/schema");
const { reorderTickets } = await import("@/lib/workflow/reorder");

let projectId: string;
let a: string;
let b: string;

function db() {
  return testDb.instance!.db;
}

function positionOf(id: string): number | null {
  return db().select().from(epics).where(eq(epics.id, id)).get()?.position ?? null;
}

beforeEach(() => {
  testDb.instance = createTestDb();
  projectId = createId();
  a = createId();
  b = createId();
  const now = new Date().toISOString();

  db()
    .insert(projects)
    .values({ id: projectId, name: "Main", createdAt: now, updatedAt: now })
    .run();
  db()
    .insert(epics)
    .values([
      {
        id: a,
        projectId,
        title: "A",
        readableId: "E-1",
        status: "backlog",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: b,
        projectId,
        title: "B",
        readableId: "E-2",
        status: "backlog",
        position: 1,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
});

describe("reorderTickets — reorderOnly", () => {
  it("reports every written id when nothing has moved", () => {
    const result = reorderTickets(
      projectId,
      [
        { id: b, status: "backlog", position: 0 },
        { id: a, status: "backlog", position: 1 },
      ],
      { actor: "agent", source: "refinement", reorderOnly: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.updatedIds.sort()).toEqual([a, b].sort());
    expect(result.skippedIds).toEqual([]);
    expect(positionOf(b)).toBe(0);
    expect(positionOf(a)).toBe(1);
  });

  it("skips a ticket whose stored column has moved on, and names it", () => {
    // The caller believes both are in backlog; b has since been promoted.
    db().update(epics).set({ status: "todo" }).where(eq(epics.id, b)).run();

    const result = reorderTickets(
      projectId,
      [
        { id: a, status: "backlog", position: 5 },
        { id: b, status: "backlog", position: 6 },
      ],
      { actor: "agent", source: "refinement", reorderOnly: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.updatedIds).toEqual([a]);
    expect(result.skippedIds).toEqual([b]);

    // The skipped ticket keeps its position: it was not written.
    expect(positionOf(a)).toBe(5);
    expect(positionOf(b)).toBe(1);
  });

  it("without reorderOnly a mismatch is a requested move, not a skip", () => {
    const result = reorderTickets(
      projectId,
      [{ id: a, status: "todo", position: 0 }],
      { actor: "user", source: "drag" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(0);
    expect(result.updatedIds).toEqual([a]);
    expect(
      db().select().from(epics).where(eq(epics.id, a)).get()?.status
    ).toBe("todo");
  });
});
