import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import type { ArjiJson, ArjiJsonEpic, ArjiJsonComment } from "@/lib/sync/arji-json";

let testDb: ReturnType<typeof createTestDb>;
let db: BetterSQLite3Database<typeof schema>;
let sqlite: Database.Database;

vi.mock("@/lib/db", () => ({
  get db() {
    return testDb.db;
  },
}));

const PROJECT_ID = "proj-1";

/**
 * Counts the SQL statements the callback actually sends to SQLite. Drizzle
 * prepares one statement per execution, so this is the ground truth for "how
 * many queries did the export issue" — stronger than counting `db.select()`
 * calls, which cannot see raw statements.
 */
async function countStatements(run: () => Promise<void>): Promise<number> {
  const original = sqlite.prepare.bind(sqlite);
  let count = 0;
  const spy = vi
    .spyOn(sqlite, "prepare")
    .mockImplementation(((sql: string) => {
      count += 1;
      return original(sql);
    }) as typeof sqlite.prepare);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return count;
}

/** Captures the payload handed to `writeArjiJson` for one export. */
async function capture(run: () => Promise<void>): Promise<ArjiJson> {
  let captured: ArjiJson | null = null;
  const spy = vi
    .spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson")
    .mockImplementation(async (_path: string, data: ArjiJson) => {
      captured = data;
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  if (captured === null) throw new Error("writeArjiJson was never called");
  return captured;
}

function seedEpic(id: string, over: Partial<typeof schema.epics.$inferInsert> = {}): void {
  db.insert(schema.epics)
    .values({ id, projectId: PROJECT_ID, title: `Epic ${id}`, ...over })
    .run();
}

function seedStory(id: string, epicId: string, over: Partial<typeof schema.userStories.$inferInsert> = {}): void {
  db.insert(schema.userStories)
    .values({ id, epicId, title: `Story ${id}`, ...over })
    .run();
}

function seedComment(id: string, over: Partial<typeof schema.ticketComments.$inferInsert> = {}): void {
  db.insert(schema.ticketComments)
    .values({ id, author: "user", content: `Comment ${id}`, ...over })
    .run();
}

/* ------------------------------------------------------------------ */
/* The pre-rewrite N+1 export, kept as an oracle for byte-identity.     */
/* ------------------------------------------------------------------ */

function legacyExportPayload(projectId: string): ArjiJson | null {
  const toJsonComment = (c: {
    id: string;
    author: string;
    content: string;
    createdAt: string | null;
  }): ArjiJsonComment => ({ id: c.id, author: c.author, content: c.content, createdAt: c.createdAt });

  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project || !project.gitRepoPath) return null;

  const allEpics = db
    .select()
    .from(schema.epics)
    .where(eq(schema.epics.projectId, projectId))
    .orderBy(schema.epics.status, schema.epics.position)
    .all();

  const epicList: ArjiJsonEpic[] = allEpics.map((epic) => {
    const stories = db
      .select()
      .from(schema.userStories)
      .where(eq(schema.userStories.epicId, epic.id))
      .orderBy(schema.userStories.position)
      .all();

    const epicComments = db
      .select()
      .from(schema.ticketComments)
      .where(eq(schema.ticketComments.epicId, epic.id))
      .all();

    return {
      id: epic.id,
      title: epic.title,
      description: epic.description,
      priority: epic.priority ?? 0,
      status: epic.status ?? "backlog",
      position: epic.position ?? 0,
      branchName: epic.branchName,
      type: epic.type ?? "feature",
      user_stories: stories.map((us) => {
        const storyComments = db
          .select()
          .from(schema.ticketComments)
          .where(eq(schema.ticketComments.userStoryId, us.id))
          .all();

        return {
          id: us.id,
          title: us.title,
          description: us.description,
          acceptance_criteria: us.acceptanceCriteria,
          status: us.status ?? "todo",
          position: us.position ?? 0,
          ...(storyComments.length > 0 && { comments: storyComments.map(toJsonComment) }),
        };
      }),
      ...(epicComments.length > 0 && { comments: epicComments.map(toJsonComment) }),
    };
  });

  return {
    version: 1,
    lastSyncedAt: "fixed",
    project: {
      name: project.name,
      description: project.description,
      status: project.status ?? "ideation",
      spec: project.spec,
    },
    epics: epicList,
  };
}

/** The exact bytes `writeArjiJson` puts on disk, minus the moving timestamp. */
function serialize(data: ArjiJson): string {
  return JSON.stringify({ ...data, lastSyncedAt: "fixed" }, null, 2) + "\n";
}

describe("arji.json export query budget", () => {
  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    db.insert(schema.projects)
      .values({ id: PROJECT_ID, name: "Test Project", spec: "spec text", gitRepoPath: "/tmp/test-repo" })
      .run();
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("issues a constant number of queries regardless of epic and story count", async () => {
    const { exportArjiJson } = await import("@/lib/sync/export");

    seedEpic("e0");
    seedStory("s0", "e0");
    seedComment("c0", { epicId: "e0" });

    const small = await countStatements(async () => {
      await capture(() => exportArjiJson(PROJECT_ID));
    });

    // 40 epics × (1 story + 1 epic comment + 1 story comment) — the shape that
    // used to cost ~3 queries per epic.
    for (let i = 1; i <= 40; i += 1) {
      seedEpic(`e${i}`, { position: i, status: i % 2 === 0 ? "todo" : "backlog" });
      seedStory(`s${i}`, `e${i}`, { position: i });
      seedComment(`ce${i}`, { epicId: `e${i}` });
      seedComment(`cs${i}`, { userStoryId: `s${i}` });
    }

    const large = await countStatements(async () => {
      await capture(() => exportArjiJson(PROJECT_ID));
    });

    // Project row + epics + stories + comments.
    expect(small).toBe(4);
    expect(large).toBe(small);

    // The pre-rewrite implementation is what this is guarding against: it
    // cost one stories query and one comments query per epic, plus one
    // comments query per story.
    const legacy = await countStatements(async () => {
      legacyExportPayload(PROJECT_ID);
    });
    expect(legacy).toBeGreaterThan(120);
  });

  it("emits byte-identical output to the pre-rewrite export", async () => {
    // A board with every shape that used to be assembled query-by-query:
    // ordering across status and position, stories tied on position, a NULL
    // position, comments on epics, comments on stories, a comment carrying
    // both keys, an epic with nothing attached, and another project's rows.
    seedEpic("e-review", { status: "review", position: 1 });
    seedEpic("e-backlog", { status: "backlog", position: 5, type: "bug", branchName: "arij/bug" });
    seedEpic("e-empty", { status: "done", position: 0 });
    seedEpic("e-ties", { status: "backlog", position: 5 });

    seedStory("s-b2", "e-backlog", { position: 2, acceptanceCriteria: "- [ ] one" });
    seedStory("s-b1", "e-backlog", { position: 1, status: "review" });
    seedStory("s-b0", "e-backlog", { position: null });
    seedStory("s-t1", "e-ties", { position: 3 });
    seedStory("s-t2", "e-ties", { position: 3 });
    seedStory("s-t3", "e-ties", { position: 3 });
    seedStory("s-r1", "e-review", { position: 0, description: "desc" });

    seedComment("c1", { epicId: "e-backlog" });
    seedComment("c2", { userStoryId: "s-b1" });
    seedComment("c3", { epicId: "e-backlog", author: "agent" });
    // Carries both keys: the old export listed it under the epic AND the story.
    seedComment("c4", { epicId: "e-review", userStoryId: "s-r1" });
    seedComment("c5", { userStoryId: "s-t2" });

    db.insert(schema.projects).values({ id: "proj-2", name: "Other", gitRepoPath: "/tmp/other" }).run();
    seedEpic("e-other", {});
    db.update(schema.epics).set({ projectId: "proj-2" }).where(eq(schema.epics.id, "e-other")).run();
    seedComment("c-other", { epicId: "e-other" });

    const expected = legacyExportPayload(PROJECT_ID);
    expect(expected).not.toBeNull();

    const { exportArjiJson } = await import("@/lib/sync/export");
    const actual = await capture(() => exportArjiJson(PROJECT_ID));

    expect(serialize(actual)).toBe(serialize(expected!));

    // Guard the fixture itself: the comparison would be vacuous on empty data.
    expect(actual.epics).toHaveLength(4);
    expect(actual.epics.find((e) => e.id === "e-review")!.comments).toHaveLength(1);
    expect(
      actual.epics.find((e) => e.id === "e-review")!.user_stories[0].comments,
    ).toHaveLength(1);
    expect(actual.epics.find((e) => e.id === "e-empty")!.user_stories).toEqual([]);
    expect(actual.epics.find((e) => e.id === "e-empty")!.comments).toBeUndefined();
    expect(
      actual.epics.find((e) => e.id === "e-backlog")!.user_stories.map((s) => s.id),
    ).toEqual(["s-b0", "s-b1", "s-b2"]);
    expect(
      actual.epics.find((e) => e.id === "e-ties")!.user_stories.map((s) => s.id),
    ).toEqual(["s-t1", "s-t2", "s-t3"]);
  });

  it("exports nothing when the project has no repository path", async () => {
    db.update(schema.projects).set({ gitRepoPath: null }).where(eq(schema.projects.id, PROJECT_ID)).run();

    const write = vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockResolvedValue();
    const { exportArjiJson } = await import("@/lib/sync/export");
    await exportArjiJson(PROJECT_ID);

    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});

describe("tryExportArjiJson", () => {
  /** The guard is what the wrapper is for; a debounce test has to lift it. */
  async function withoutVitestGuard<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  }

  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    db.insert(schema.projects)
      .values({ id: PROJECT_ID, name: "Test Project", gitRepoPath: "/tmp/test-repo" })
      .run();
    seedEpic("e0");
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("preserves the VITEST early-return guard", async () => {
    const write = vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockResolvedValue();
    const { tryExportArjiJson } = await import("@/lib/sync/export");

    expect(process.env.VITEST).toBeTruthy();
    vi.useFakeTimers();
    tryExportArjiJson(PROJECT_ID);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("coalesces a burst of board writes into a single export", async () => {
    const write = vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockResolvedValue();
    const { tryExportArjiJson } = await import("@/lib/sync/export");

    await withoutVitestGuard(async () => {
      vi.useFakeTimers();

      // A drag emits several board writes back to back.
      for (let i = 0; i < 12; i += 1) {
        tryExportArjiJson(PROJECT_ID);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(write).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(write).toHaveBeenCalledTimes(1);

      // A later, separate write is its own export — the debounce coalesces
      // bursts, it does not swallow subsequent changes.
      tryExportArjiJson(PROJECT_ID);
      await vi.advanceTimersByTimeAsync(500);
      expect(write).toHaveBeenCalledTimes(2);
    });

    write.mockRestore();
  });

  it("still exports under a sustained stream of writes", async () => {
    const write = vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockResolvedValue();
    const { tryExportArjiJson } = await import("@/lib/sync/export");

    await withoutVitestGuard(async () => {
      vi.useFakeTimers();

      // One write every 200 ms for 10 s: a pure sliding debounce would never
      // fire. The max-wait ceiling has to release an export anyway.
      for (let i = 0; i < 50; i += 1) {
        tryExportArjiJson(PROJECT_ID);
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(write.mock.calls.length).toBeGreaterThanOrEqual(4);
      // ...but far fewer than one per write.
      expect(write.mock.calls.length).toBeLessThan(20);
    });

    write.mockRestore();
  });

  it("debounces each project independently", async () => {
    db.insert(schema.projects)
      .values({ id: "proj-2", name: "Second", gitRepoPath: "/tmp/second-repo" })
      .run();

    const write = vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockResolvedValue();
    const { tryExportArjiJson } = await import("@/lib/sync/export");

    await withoutVitestGuard(async () => {
      vi.useFakeTimers();

      tryExportArjiJson(PROJECT_ID);
      tryExportArjiJson("proj-2");
      tryExportArjiJson(PROJECT_ID);
      await vi.advanceTimersByTimeAsync(500);

      expect(write.mock.calls.map((c) => c[0]).sort()).toEqual(["/tmp/second-repo", "/tmp/test-repo"]);
    });

    write.mockRestore();
  });
});
