import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import type { ArjiJson } from "@/lib/sync/arji-json";

let testDb: ReturnType<typeof createTestDb>;
let db: BetterSQLite3Database<typeof schema>;
let sqlite: Database.Database;
const emitTicketMoved = vi.hoisted(() => vi.fn());

// Mock the db module to use our test database
vi.mock("@/lib/db", () => ({
  get db() {
    return testDb.db;
  },
}));

vi.mock("@/lib/events/emit", () => ({ emitTicketMoved }));

describe("arji.json sync roundtrip", () => {
  beforeEach(() => {
    vi.resetModules();
    testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitTicketMoved.mockReset();

    // Seed a project
    db.insert(schema.projects)
      .values({ id: "proj-1", name: "Test Project", gitRepoPath: "/tmp/test-repo" })
      .run();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("epic type preservation", () => {
    it("exports the type field for feature epics", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Feature Epic", type: "feature" })
        .run();

      const { exportArjiJson } = await import("@/lib/sync/export");

      // Mock writeArjiJson to capture the data
      let capturedData: ArjiJson | null = null;
      vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockImplementation(
        async (_path: string, data: ArjiJson) => {
          capturedData = data;
        }
      );

      await exportArjiJson("proj-1");

      expect(capturedData).not.toBeNull();
      expect(capturedData!.epics[0].type).toBe("feature");
    });

    it("exports the type field for bug epics", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Bug Epic", type: "bug" })
        .run();

      let capturedData: ArjiJson | null = null;
      vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockImplementation(
        async (_path: string, data: ArjiJson) => {
          capturedData = data;
        }
      );

      const { exportArjiJson } = await import("@/lib/sync/export");
      await exportArjiJson("proj-1");

      expect(capturedData!.epics[0].type).toBe("bug");
    });

    it("imports the type field for bug epics", async () => {
      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "Bug Epic",
            description: "A bug",
            priority: 2,
            status: "todo",
            position: 0,
            branchName: null,
            type: "bug",
            user_stories: [],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      await importArjiJson("proj-1");

      const epic = db.select().from(schema.epics).all()[0];
      expect(epic.type).toBe("bug");
    });

    it("preserves bug type on update (existing epic)", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Old Title", type: "bug" })
        .run();

      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "Updated Bug",
            description: null,
            priority: 1,
            status: "in_progress",
            position: 0,
            branchName: null,
            type: "bug",
            user_stories: [],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      await importArjiJson("proj-1");

      const epic = db.select().from(schema.epics).all()[0];
      expect(epic.type).toBe("bug");
      expect(epic.title).toBe("Updated Bug");
    });

    it("defaults to feature when type is not specified in JSON", async () => {
      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "No Type",
            description: null,
            priority: 0,
            status: "backlog",
            position: 0,
            branchName: null,
            user_stories: [],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      await importArjiJson("proj-1");

      const epic = db.select().from(schema.epics).all()[0];
      expect(epic.type).toBe("feature");
    });
  });

  describe("comments preservation", () => {
    it("exports epic comments", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Epic 1" })
        .run();
      db.insert(schema.ticketComments)
        .values({ id: "c1", epicId: "e1", author: "user", content: "Looks good!" })
        .run();
      db.insert(schema.ticketComments)
        .values({ id: "c2", epicId: "e1", author: "agent", content: "Fixed it." })
        .run();

      let capturedData: ArjiJson | null = null;
      vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockImplementation(
        async (_path: string, data: ArjiJson) => {
          capturedData = data;
        }
      );

      const { exportArjiJson } = await import("@/lib/sync/export");
      await exportArjiJson("proj-1");

      expect(capturedData!.epics[0].comments).toHaveLength(2);
      expect(capturedData!.epics[0].comments![0]).toMatchObject({
        id: "c1",
        author: "user",
        content: "Looks good!",
      });
      expect(capturedData!.epics[0].comments![1]).toMatchObject({
        id: "c2",
        author: "agent",
        content: "Fixed it.",
      });
    });

    it("exports user story comments", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Epic 1" })
        .run();
      db.insert(schema.userStories)
        .values({ id: "us1", epicId: "e1", title: "Story 1" })
        .run();
      db.insert(schema.ticketComments)
        .values({ id: "c1", userStoryId: "us1", author: "user", content: "Story comment" })
        .run();

      let capturedData: ArjiJson | null = null;
      vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockImplementation(
        async (_path: string, data: ArjiJson) => {
          capturedData = data;
        }
      );

      const { exportArjiJson } = await import("@/lib/sync/export");
      await exportArjiJson("proj-1");

      expect(capturedData!.epics[0].user_stories[0].comments).toHaveLength(1);
      expect(capturedData!.epics[0].user_stories[0].comments![0]).toMatchObject({
        id: "c1",
        author: "user",
        content: "Story comment",
      });
    });

    it("omits comments array when there are no comments", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Epic 1" })
        .run();
      db.insert(schema.userStories)
        .values({ id: "us1", epicId: "e1", title: "Story 1" })
        .run();

      let capturedData: ArjiJson | null = null;
      vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockImplementation(
        async (_path: string, data: ArjiJson) => {
          capturedData = data;
        }
      );

      const { exportArjiJson } = await import("@/lib/sync/export");
      await exportArjiJson("proj-1");

      expect(capturedData!.epics[0].comments).toBeUndefined();
      expect(capturedData!.epics[0].user_stories[0].comments).toBeUndefined();
    });

    it("imports epic comments (insert)", async () => {
      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "Epic 1",
            description: null,
            priority: 0,
            status: "backlog",
            position: 0,
            branchName: null,
            user_stories: [],
            comments: [
              { id: "c1", author: "user", content: "Nice!", createdAt: "2026-01-01T00:00:00Z" },
            ],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      const result = await importArjiJson("proj-1");

      expect(result.commentsUpserted).toBe(1);

      const comments = db.select().from(schema.ticketComments).all();
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        id: "c1",
        epicId: "e1",
        author: "user",
        content: "Nice!",
      });
    });

    it("imports story comments (insert)", async () => {
      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "Epic 1",
            description: null,
            priority: 0,
            status: "backlog",
            position: 0,
            branchName: null,
            user_stories: [
              {
                id: "us1",
                title: "Story 1",
                description: null,
                acceptance_criteria: null,
                status: "todo",
                position: 0,
                comments: [
                  { id: "c1", author: "agent", content: "Done", createdAt: "2026-01-01T00:00:00Z" },
                ],
              },
            ],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      const result = await importArjiJson("proj-1");

      expect(result.commentsUpserted).toBe(1);

      const comments = db.select().from(schema.ticketComments).all();
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        id: "c1",
        userStoryId: "us1",
        author: "agent",
        content: "Done",
      });
    });

    it("updates existing comments on import", async () => {
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Epic 1" })
        .run();
      db.insert(schema.ticketComments)
        .values({ id: "c1", epicId: "e1", author: "user", content: "Old content" })
        .run();

      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "Epic 1",
            description: null,
            priority: 0,
            status: "backlog",
            position: 0,
            branchName: null,
            user_stories: [],
            comments: [
              { id: "c1", author: "user", content: "Updated content", createdAt: "2026-01-01T00:00:00Z" },
            ],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      await importArjiJson("proj-1");

      const comments = db.select().from(schema.ticketComments).all();
      expect(comments).toHaveLength(1);
      expect(comments[0].content).toBe("Updated content");
    });

    it("handles import with no comments gracefully", async () => {
      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e1",
            title: "Epic 1",
            description: null,
            priority: 0,
            status: "backlog",
            position: 0,
            branchName: null,
            user_stories: [],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      const result = await importArjiJson("proj-1");

      expect(result.commentsUpserted).toBe(0);
      const comments = db.select().from(schema.ticketComments).all();
      expect(comments).toHaveLength(0);
    });
  });

  describe("full roundtrip", () => {
    it("roundtrips bug epics with comments through export → import", async () => {
      // Setup: a bug epic with comments on epic and story
      db.insert(schema.epics)
        .values({ id: "e1", projectId: "proj-1", title: "Bug Report", type: "bug", status: "todo" })
        .run();
      db.insert(schema.userStories)
        .values({ id: "us1", epicId: "e1", title: "Repro steps" })
        .run();
      db.insert(schema.ticketComments)
        .values({ id: "c1", epicId: "e1", author: "user", content: "Epic comment" })
        .run();
      db.insert(schema.ticketComments)
        .values({ id: "c2", userStoryId: "us1", author: "agent", content: "Story comment" })
        .run();

      // Export
      let capturedData: ArjiJson | null = null;
      vi.spyOn(await import("@/lib/sync/arji-json"), "writeArjiJson").mockImplementation(
        async (_path: string, data: ArjiJson) => {
          capturedData = data;
        }
      );

      const { exportArjiJson } = await import("@/lib/sync/export");
      await exportArjiJson("proj-1");

      // Verify export
      expect(capturedData!.epics[0].type).toBe("bug");
      expect(capturedData!.epics[0].comments).toHaveLength(1);
      expect(capturedData!.epics[0].user_stories[0].comments).toHaveLength(1);

      // Clear DB and reimport
      sqlite.exec("DELETE FROM ticket_comments");
      sqlite.exec("DELETE FROM user_stories");
      sqlite.exec("DELETE FROM epics");

      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue(capturedData!);

      const { importArjiJson } = await import("@/lib/sync/import");
      const result = await importArjiJson("proj-1");

      // Verify import
      expect(result.commentsUpserted).toBe(2);

      const epics = db.select().from(schema.epics).all();
      expect(epics).toHaveLength(1);
      expect(epics[0].type).toBe("bug");

      const comments = db.select().from(schema.ticketComments).all();
      expect(comments).toHaveLength(2);

      const epicComment = comments.find((c) => c.epicId === "e1");
      expect(epicComment).toMatchObject({ id: "c1", author: "user", content: "Epic comment" });

      const storyComment = comments.find((c) => c.userStoryId === "us1");
      expect(storyComment).toMatchObject({ id: "c2", author: "agent", content: "Story comment" });
    });
  });

  describe("guarded status reconciliation", () => {
    it("skips refused done statuses while importing the remaining content", async () => {
      db.insert(schema.epics)
        .values({
          id: "e-guarded",
          projectId: "proj-1",
          title: "Old epic title",
          status: "review",
        })
        .run();
      db.insert(schema.userStories)
        .values({
          id: "s-guarded",
          epicId: "e-guarded",
          title: "Old story title",
          status: "in_progress",
        })
        .run();
      db.insert(schema.agentSessions)
        .values({
          id: "completed-review",
          projectId: "proj-1",
          epicId: "e-guarded",
          status: "completed",
          agentType: "review_code",
          // A completed, verdict-bearing review. review → done is refused
          // STRUCTURALLY now (the edge is review → to_merge → done and only
          // the merge reaches done), so this seed proves the skip is not for
          // lack of a review — even a fully reviewed epic cannot be imported
          // straight to done.
          reviewVerdict: "approved",
          mode: "plan",
        })
        .run();

      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Updated project", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e-guarded",
            title: "Updated epic title",
            description: null,
            priority: 0,
            status: "done",
            position: 0,
            branchName: null,
            user_stories: [
              {
                id: "s-guarded",
                title: "Updated story title",
                description: null,
                acceptance_criteria: null,
                status: "done",
                position: 0,
              },
            ],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      const result = await importArjiJson("proj-1");

      expect(result).toMatchObject({
        epicsUpserted: 1,
        storiesUpserted: 1,
        statusesSkipped: [
          {
            target: "epic",
            epicId: "e-guarded",
            fromStatus: "review",
            toStatus: "done",
            reason: expect.stringContaining(
              'cannot move from "review" to "done"'
            ),
          },
          {
            target: "story",
            epicId: "e-guarded",
            userStoryId: "s-guarded",
            fromStatus: "in_progress",
            toStatus: "done",
            reason: expect.stringContaining("Invalid transition"),
          },
        ],
      });
      expect(
        db.select().from(schema.epics).where(eq(schema.epics.id, "e-guarded")).get()
      ).toMatchObject({ title: "Updated epic title", status: "review" });
      expect(
        db
          .select()
          .from(schema.userStories)
          .where(eq(schema.userStories.id, "s-guarded"))
          .get()
      ).toMatchObject({ title: "Updated story title", status: "in_progress" });
      expect(
        db
          .select()
          .from(schema.ticketActivityLog)
          .where(eq(schema.ticketActivityLog.epicId, "e-guarded"))
          .all()
          .filter((entry) => entry.reason?.includes("refused"))
      ).toHaveLength(2);
      expect(emitTicketMoved).not.toHaveBeenCalled();
    });

    it("does not emit a valid move when a later import write rolls back", async () => {
      db.insert(schema.epics)
        .values({
          id: "e-rollback",
          projectId: "proj-1",
          title: "Rollback epic",
          status: "backlog",
        })
        .run();
      sqlite.exec(`
        CREATE TRIGGER reject_import_story
        BEFORE INSERT ON user_stories
        WHEN NEW.id = 'story-that-fails'
        BEGIN
          SELECT RAISE(ABORT, 'forced import rollback');
        END;
      `);

      vi.spyOn(await import("@/lib/sync/arji-json"), "readArjiJson").mockResolvedValue({
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        project: { name: "Test", description: null, status: "active", spec: null },
        epics: [
          {
            id: "e-rollback",
            title: "Rollback epic",
            description: null,
            priority: 0,
            status: "todo",
            position: 0,
            branchName: null,
            user_stories: [
              {
                id: "story-that-fails",
                title: "Force rollback",
                description: null,
                acceptance_criteria: null,
                status: "todo",
                position: 0,
              },
            ],
          },
        ],
      });

      const { importArjiJson } = await import("@/lib/sync/import");
      await expect(importArjiJson("proj-1")).rejects.toThrow("forced import rollback");

      expect(
        db.select().from(schema.epics).where(eq(schema.epics.id, "e-rollback")).get()
          ?.status
      ).toBe("backlog");
      expect(
        db
          .select()
          .from(schema.ticketActivityLog)
          .where(eq(schema.ticketActivityLog.epicId, "e-rollback"))
          .all()
      ).toHaveLength(0);
      expect(emitTicketMoved).not.toHaveBeenCalled();
    });
  });
});
