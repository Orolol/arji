/**
 * POST /api/projects/[projectId]/epics/reorder — the `reorderOnly` contract.
 *
 * Every item in a reorder payload carries the status the CLIENT believes the
 * ticket has, and the route reads a mismatch as a requested move. That is
 * right for drag-and-drop, which really does move a card between columns.
 * It is wrong for "Sort by priority", a whole-column action the user never
 * aimed at any particular card: on a board the server has moved on from, the
 * same payload shape would either fail the entire sort on a refused
 * transition or silently demote a ticket out of Full Auto's queue.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const { db } = await import("@/lib/db");
const { projects, epics } = await import("@/lib/db/schema");
const { POST } = await import(
  "@/app/api/projects/[projectId]/epics/reorder/route"
);

const PROJECT_ID = "proj-reorder";

function params() {
  return { params: Promise.resolve({ projectId: PROJECT_ID }) };
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}

function addEpic(id: string, status: string, position: number): void {
  db.insert(epics)
    .values({
      id,
      projectId: PROJECT_ID,
      title: id,
      status,
      priority: 0,
      position,
      createdAt: "2026-08-26T09:00:00.000Z",
      updatedAt: "2026-08-26T09:00:00.000Z",
    })
    .run();
}

function readEpic(id: string) {
  return db.select().from(epics).all().find((row) => row.id === id)!;
}

beforeEach(() => {
  db.delete(epics).run();
  db.delete(projects).run();
  db.insert(projects)
    .values({ id: PROJECT_ID, name: "Reorder", gitRepoPath: "/repos/reorder" })
    .run();
});

describe("reorder route — default (drag-and-drop) behaviour", () => {
  it("treats a status mismatch as a requested move", async () => {
    addEpic("e1", "todo", 0);

    const res = await POST(
      postRequest({ items: [{ id: "e1", status: "backlog", position: 0 }] }),
      params()
    );

    expect(res.status).toBe(200);
    // Dragging a card to Backlog is a real move, and must stay one.
    expect(readEpic("e1").status).toBe("backlog");
  });
});

describe("reorder route — reorderOnly", () => {
  it("leaves a ticket the client has a stale column for exactly where it is", async () => {
    // Full Auto promoted e1 to in_progress; the board still shows it in To Do
    // and the user clicks "Sort by priority" on that column.
    addEpic("e1", "in_progress", 0);
    addEpic("e2", "todo", 1);

    const res = await POST(
      postRequest({
        items: [
          { id: "e1", status: "todo", position: 0 },
          { id: "e2", status: "todo", position: 1 },
        ],
        reorderOnly: true,
      }),
      params()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 1, skipped: 1 } });
    // No demotion, and no 400 that would have discarded the whole sort.
    expect(readEpic("e1").status).toBe("in_progress");
    expect(readEpic("e2").status).toBe("todo");
  });

  it("still rewrites the positions of the items that match", async () => {
    addEpic("stale", "in_progress", 0);
    addEpic("a", "todo", 1);
    addEpic("b", "todo", 2);

    await POST(
      postRequest({
        items: [
          { id: "b", status: "todo", position: 0 },
          { id: "stale", status: "todo", position: 1 },
          { id: "a", status: "todo", position: 2 },
        ],
        reorderOnly: true,
      }),
      params()
    );

    expect(readEpic("b").position).toBe(0);
    expect(readEpic("a").position).toBe(2);
    // Untouched: its index meant nothing in a column it is not in.
    expect(readEpic("stale").position).toBe(0);
  });

  it("reports nothing skipped when the board is fresh", async () => {
    addEpic("a", "todo", 0);
    addEpic("b", "todo", 1);

    const res = await POST(
      postRequest({
        items: [
          { id: "b", status: "todo", position: 0 },
          { id: "a", status: "todo", position: 1 },
        ],
        reorderOnly: true,
      }),
      params()
    );

    expect(await res.json()).toEqual({ data: { updated: 2, skipped: 0 } });
    expect(readEpic("b").position).toBe(0);
    expect(readEpic("a").position).toBe(1);
  });

  it("skips a released ticket instead of refusing the whole request", async () => {
    addEpic("shipped", "released", 0);
    addEpic("a", "backlog", 1);

    const res = await POST(
      postRequest({
        items: [
          { id: "shipped", status: "backlog", position: 0 },
          { id: "a", status: "backlog", position: 1 },
        ],
        reorderOnly: true,
      }),
      params()
    );

    expect(res.status).toBe(200);
    expect(readEpic("shipped").status).toBe("released");
    expect(readEpic("a").position).toBe(1);
  });
});
