import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, eq } from "drizzle-orm";
import * as schema from "../db/schema";

describe("chatAttachments schema", () => {
  let sqlite: ReturnType<typeof Database>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });

    // Create tables in dependency order
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'ideation',
        git_repo_path TEXT,
        spec TEXT,
        imported INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'brainstorm',
        label TEXT NOT NULL DEFAULT 'Brainstorm',
        status TEXT DEFAULT 'active',
        epic_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE chat_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates an attachment with null chatMessageId (pending upload)", () => {
    db.insert(schema.chatAttachments)
      .values({
        id: "att1",
        chatMessageId: null,
        fileName: "screenshot.png",
        filePath: "data/uploads/proj1/att1-screenshot.png",
        mimeType: "image/png",
        sizeBytes: 12345,
      })
      .run();

    const result = db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, "att1"))
      .get();

    expect(result).toBeDefined();
    expect(result!.chatMessageId).toBeNull();
    expect(result!.fileName).toBe("screenshot.png");
    expect(result!.mimeType).toBe("image/png");
    expect(result!.sizeBytes).toBe(12345);
  });

  it("links attachment to a message", () => {
    // Create project and message first
    db.insert(schema.projects).values({ id: "proj1", name: "Test" }).run();
    db.insert(schema.chatMessages)
      .values({ id: "msg1", projectId: "proj1", role: "user", content: "hello" })
      .run();

    db.insert(schema.chatAttachments)
      .values({
        id: "att1",
        chatMessageId: null,
        fileName: "image.jpg",
        filePath: "data/uploads/proj1/att1-image.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 5000,
      })
      .run();

    // Link to message
    db.update(schema.chatAttachments)
      .set({ chatMessageId: "msg1" })
      .where(eq(schema.chatAttachments.id, "att1"))
      .run();

    const result = db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, "att1"))
      .get();

    expect(result!.chatMessageId).toBe("msg1");
  });

  it("cascade deletes attachments when message is deleted", () => {
    db.insert(schema.projects).values({ id: "proj1", name: "Test" }).run();
    db.insert(schema.chatMessages)
      .values({ id: "msg1", projectId: "proj1", role: "user", content: "hello" })
      .run();
    db.insert(schema.chatAttachments)
      .values({
        id: "att1",
        chatMessageId: "msg1",
        fileName: "img.png",
        filePath: "data/uploads/proj1/att1-img.png",
        mimeType: "image/png",
        sizeBytes: 1000,
      })
      .run();

    // Delete the message
    db.delete(schema.chatMessages).where(eq(schema.chatMessages.id, "msg1")).run();

    // Attachment should be gone
    const result = db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, "att1"))
      .get();

    expect(result).toBeUndefined();
  });

  it("supports multiple attachments per message", () => {
    db.insert(schema.projects).values({ id: "proj1", name: "Test" }).run();
    db.insert(schema.chatMessages)
      .values({ id: "msg1", projectId: "proj1", role: "user", content: "images" })
      .run();

    db.insert(schema.chatAttachments)
      .values([
        {
          id: "att1",
          chatMessageId: "msg1",
          fileName: "a.png",
          filePath: "data/uploads/proj1/att1-a.png",
          mimeType: "image/png",
          sizeBytes: 1000,
        },
        {
          id: "att2",
          chatMessageId: "msg1",
          fileName: "b.jpg",
          filePath: "data/uploads/proj1/att2-b.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 2000,
        },
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
      .values({
        id: "att-test",
        chatMessageId: null,
        fileName: "test.webp",
        filePath: "data/uploads/p/att-test-test.webp",
        mimeType: "image/webp",
        sizeBytes: 99999,
        createdAt: "2024-01-01T00:00:00.000Z",
      })
      .run();

    const result = db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, "att-test"))
      .get();

    expect(result).toMatchObject({
      id: "att-test",
      chatMessageId: null,
      fileName: "test.webp",
      filePath: "data/uploads/p/att-test-test.webp",
      mimeType: "image/webp",
      sizeBytes: 99999,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
  });
});
