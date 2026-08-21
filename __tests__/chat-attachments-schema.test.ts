import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-utils";

/**
 * The three relations that decide how long an uploaded file lives.
 *
 * Built from the real migration chain rather than hand-written DDL: this file
 * used to declare its own `chat_attachments` table, which meant a column added
 * to the schema and the migration could still fail here for having no
 * equivalent in the fixture — the fixture was testing itself.
 */
describe("chatAttachments schema", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = drizzle(sqlite, { schema });

    db.insert(schema.projects).values({ id: "proj1", name: "Test" }).run();
  });

  afterEach(() => {
    sqlite.close();
  });

  function stagedUpload(overrides: Partial<typeof schema.chatAttachments.$inferInsert> = {}) {
    return {
      id: "att1",
      chatMessageId: null,
      projectId: "proj1",
      epicId: null,
      fileName: "screenshot.png",
      filePath: "data/uploads/proj1/att1-screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12345,
      ...overrides,
    };
  }

  function attachment(id: string) {
    return db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, id))
      .get();
  }

  it("creates an attachment owned by a project and claimed by nobody", () => {
    db.insert(schema.chatAttachments).values(stagedUpload()).run();

    const result = attachment("att1");

    expect(result).toBeDefined();
    expect(result!.chatMessageId).toBeNull();
    expect(result!.epicId).toBeNull();
    expect(result!.projectId).toBe("proj1");
    expect(result!.fileName).toBe("screenshot.png");
    expect(result!.mimeType).toBe("image/png");
    expect(result!.sizeBytes).toBe(12345);
  });

  it("links attachment to a message", () => {
    db.insert(schema.chatMessages)
      .values({ id: "msg1", projectId: "proj1", role: "user", content: "hello" })
      .run();
    db.insert(schema.chatAttachments).values(stagedUpload()).run();

    db.update(schema.chatAttachments)
      .set({ chatMessageId: "msg1" })
      .where(eq(schema.chatAttachments.id, "att1"))
      .run();

    expect(attachment("att1")!.chatMessageId).toBe("msg1");
  });

  it("links attachment to a bug ticket", () => {
    db.insert(schema.epics)
      .values({ id: "bug1", projectId: "proj1", title: "Board renders blank" })
      .run();
    db.insert(schema.chatAttachments).values(stagedUpload()).run();

    db.update(schema.chatAttachments)
      .set({ epicId: "bug1" })
      .where(eq(schema.chatAttachments.id, "att1"))
      .run();

    expect(attachment("att1")!.epicId).toBe("bug1");
  });

  it("cascade deletes attachments when message is deleted", () => {
    db.insert(schema.chatMessages)
      .values({ id: "msg1", projectId: "proj1", role: "user", content: "hello" })
      .run();
    db.insert(schema.chatAttachments)
      .values(stagedUpload({ chatMessageId: "msg1" }))
      .run();

    db.delete(schema.chatMessages).where(eq(schema.chatMessages.id, "msg1")).run();

    expect(attachment("att1")).toBeUndefined();
  });

  it("cascade deletes attachments when the bug they belong to is deleted", () => {
    db.insert(schema.epics)
      .values({ id: "bug1", projectId: "proj1", title: "Board renders blank" })
      .run();
    db.insert(schema.chatAttachments)
      .values(stagedUpload({ epicId: "bug1" }))
      .run();

    db.delete(schema.epics).where(eq(schema.epics.id, "bug1")).run();

    expect(attachment("att1")).toBeUndefined();
  });

  it("cascade deletes attachments when the project is deleted", () => {
    // Including one nobody ever submitted: a staged upload has no other owner
    // to take it away, so the project is its only route out of the database.
    db.insert(schema.chatAttachments).values(stagedUpload()).run();

    db.delete(schema.projects).where(eq(schema.projects.id, "proj1")).run();

    expect(attachment("att1")).toBeUndefined();
  });

  it("supports multiple attachments per message", () => {
    db.insert(schema.chatMessages)
      .values({ id: "msg1", projectId: "proj1", role: "user", content: "images" })
      .run();

    db.insert(schema.chatAttachments)
      .values([
        stagedUpload({
          id: "att1",
          chatMessageId: "msg1",
          fileName: "a.png",
          filePath: "data/uploads/proj1/att1-a.png",
        }),
        stagedUpload({
          id: "att2",
          chatMessageId: "msg1",
          fileName: "b.jpg",
          filePath: "data/uploads/proj1/att2-b.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 2000,
        }),
      ])
      .run();

    const results = db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.chatMessageId, "msg1"))
      .all();

    expect(results).toHaveLength(2);
  });

  it("stores all required fields", () => {
    db.insert(schema.chatAttachments)
      .values(
        stagedUpload({
          id: "att-test",
          fileName: "test.webp",
          filePath: "data/uploads/proj1/att-test-test.webp",
          mimeType: "image/webp",
          sizeBytes: 99999,
          createdAt: "2024-01-01T00:00:00.000Z",
        })
      )
      .run();

    expect(attachment("att-test")).toMatchObject({
      id: "att-test",
      chatMessageId: null,
      projectId: "proj1",
      epicId: null,
      fileName: "test.webp",
      filePath: "data/uploads/proj1/att-test-test.webp",
      mimeType: "image/webp",
      sizeBytes: 99999,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("keeps an upload uploaded before ownership existed readable", () => {
    // A row the 0030 backfill could not attribute — its project is gone, or it
    // predates the column. Nothing about reading it may depend on an owner.
    sqlite
      .prepare(
        `INSERT INTO chat_attachments (id, chat_message_id, file_name, file_path, mime_type, size_bytes)
         VALUES ('legacy', NULL, 'old.png', 'data/uploads/proj1/legacy-old.png', 'image/png', 10)`
      )
      .run();

    const result = attachment("legacy");

    expect(result!.projectId).toBeNull();
    expect(result!.epicId).toBeNull();
    expect(result!.filePath).toBe("data/uploads/proj1/legacy-old.png");
  });
});
