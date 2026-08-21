/**
 * Atomicity of `POST /api/projects/[projectId]/epics` against REAL SQLite.
 *
 * `epics-route.test.ts` already covers this route, but through a hand-written
 * drizzle double whose `transaction()` implements rollback by construction: it
 * stages inserts in a local array and only publishes them if the callback
 * returns. That double can assert the route *calls* `db.transaction`; it cannot
 * assert that a mid-way failure leaves nothing behind, because it is the double
 * — not SQLite — deciding what "behind" means.
 *
 * This file runs the same handler against `createTestDb()`: an in-memory
 * database built from the real migration chain, with foreign keys on. The
 * rollback assertions are `SELECT COUNT(*)` on real tables after a real
 * constraint violation, so they hold only if BEGIN/ROLLBACK actually ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

/**
 * Ids come from a queue so a test can hand out a duplicate on purpose and blow
 * the `user_stories` primary key mid-insert. Empty queue falls back to the real
 * generator, keeping every other test on production behaviour.
 */
const idState = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/utils/nanoid", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils/nanoid")>("@/lib/utils/nanoid");
  return {
    ...actual,
    createId: vi.fn(() => idState.queue.shift() ?? actual.createId()),
  };
});

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const { sqlite } = await import("@/lib/db");
const { POST } = await import("@/app/api/projects/[projectId]/epics/route");

const PROJECT_ID = "proj-atomic";

function countRows(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function ticketCounter(): number {
  return (
    sqlite
      .prepare("SELECT ticket_counter AS n FROM projects WHERE id = ?")
      .get(PROJECT_ID) as { n: number }
  ).n;
}

function post(body: unknown) {
  return POST(mockJsonRequest(body), mockRouteContext({ projectId: PROJECT_ID }));
}

beforeEach(() => {
  idState.queue = [];
  sqlite.exec("DELETE FROM user_stories; DELETE FROM epics; DELETE FROM projects;");
  sqlite
    .prepare(
      "INSERT INTO projects (id, name, ticket_counter) VALUES (?, 'Atomic Project', 0)"
    )
    .run(PROJECT_ID);
});

describe("POST /api/projects/[projectId]/epics — atomicity on real SQLite", () => {
  it("commits the epic and every story it was sent, in order", async () => {
    const response = await post({
      title: "Manual epic",
      description: "Written by hand",
      userStories: [
        { title: "As a user, I want one", acceptanceCriteria: "- [ ] first" },
        { title: "As a user, I want two", description: "second" },
      ],
    });

    const json = await response.json();
    expect(response.status).toBe(201);
    expect(json.error).toBeUndefined();
    expect(json.data.userStoriesCreated).toBe(2);

    const epicRows = sqlite
      .prepare("SELECT id, title, status, position FROM epics")
      .all() as Array<{ id: string; title: string; status: string; position: number }>;
    expect(epicRows).toHaveLength(1);
    expect(epicRows[0].id).toBe(json.data.id);
    expect(epicRows[0].status).toBe("backlog");

    const storyRows = sqlite
      .prepare("SELECT epic_id, title, position FROM user_stories ORDER BY position")
      .all() as Array<{ epic_id: string; title: string; position: number }>;
    expect(storyRows.map((s) => s.position)).toEqual([0, 1]);
    expect(storyRows.every((s) => s.epic_id === epicRows[0].id)).toBe(true);
    expect(storyRows.map((s) => s.title)).toEqual([
      "As a user, I want one",
      "As a user, I want two",
    ]);
  });

  it("leaves no epic behind when a story insert fails mid-transaction", async () => {
    // First id is the epic's, the next two collide -> the multi-row story
    // INSERT violates user_stories' primary key partway through.
    idState.queue = ["epic-rollback", "story-dup", "story-dup"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post({
      title: "Doomed epic",
      userStories: [
        { title: "As a user, I want the first story" },
        { title: "As a user, I want the second story" },
      ],
    });

    const json = await response.json();
    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to create epic");
    expect(json.data).toBeUndefined();

    // The point of the story: no orphan parent, on real SQLite.
    expect(countRows("epics")).toBe(0);
    expect(countRows("user_stories")).toBe(0);

    errorSpy.mockRestore();
  });

  it("gives back the ticket number a rolled-back epic consumed", async () => {
    idState.queue = ["epic-rollback", "story-dup", "story-dup"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await post({
      title: "Doomed epic",
      userStories: [{ title: "story one" }, { title: "story two" }],
    });
    errorSpy.mockRestore();

    // `generateReadableId` bumps projects.ticket_counter. Run outside the
    // transaction it would survive the rollback and burn a readable id on an
    // epic that never existed, leaving a gap in E-<slug>-NNN.
    expect(ticketCounter()).toBe(0);

    const response = await post({ title: "The retry" });
    const json = await response.json();
    expect(response.status).toBe(201);
    expect(json.data.readableId).toBe("E-atomic-project-001");
    expect(ticketCounter()).toBe(1);
  });

  it("persists nothing at all when validation rejects the request", async () => {
    const response = await post({
      title: "Epic with a blank story",
      userStories: [{ title: "As a user, I want a real story" }, { title: "   " }],
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeDefined();
    expect(countRows("epics")).toBe(0);
    expect(countRows("user_stories")).toBe(0);
    expect(ticketCounter()).toBe(0);
  });

  /**
   * An over-cap story is rejected whole rather than stored: the story edit
   * routes cap titles at 500 and prose at 10 000, so a story past that would be
   * written here and then be un-editable for good.
   */
  it("refuses an over-cap story instead of storing one that can't be edited", async () => {
    const response = await post({
      title: "Epic with a novel for a story title",
      userStories: [
        { title: "As a user, I want a real story" },
        { title: "T".repeat(501) },
      ],
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeDefined();
    expect(countRows("epics")).toBe(0);
    expect(countRows("user_stories")).toBe(0);
    expect(ticketCounter()).toBe(0);
  });

  it("stores a story sitting exactly on the caps", async () => {
    const title = "S".repeat(500);
    const prose = "p".repeat(10000);

    const response = await post({
      title: "Epic at the boundary",
      userStories: [{ title, description: prose, acceptanceCriteria: prose }],
    });

    expect(response.status).toBe(201);

    const stored = sqlite
      .prepare("SELECT title, description, acceptance_criteria FROM user_stories")
      .all() as Array<{ title: string; description: string; acceptance_criteria: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe(title);
    expect(stored[0].description).toBe(prose);
    expect(stored[0].acceptance_criteria).toBe(prose);
  });
});
