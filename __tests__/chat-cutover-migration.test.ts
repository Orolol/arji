import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  resetUnifiedChatCutoverMigrationStateForTests,
  runUnifiedChatCutoverMigration,
  runUnifiedChatCutoverMigrationOnce,
} from "@/lib/chat/unified-cutover-migration";

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE chat_conversations (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      type text,
      label text,
      status text,
      epic_id text,
      provider text,
      created_at text
    );

    CREATE TABLE chat_messages (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      conversation_id text,
      role text NOT NULL,
      content text NOT NULL,
      metadata text,
      created_at text
    );

    CREATE TABLE chat_attachments (
      id text PRIMARY KEY NOT NULL,
      chat_message_id text,
      file_name text NOT NULL,
      file_path text NOT NULL,
      mime_type text NOT NULL,
      size_bytes integer NOT NULL,
      created_at text
    );
  `);
}

describe("unified chat cutover migration", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-chat-cutover-"));
    db = new Database(":memory:");
    createSchema(db);
    resetUnifiedChatCutoverMigrationStateForTests();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetUnifiedChatCutoverMigrationStateForTests();
  });

  it("reassigns orphan messages without changing existing IDs and writes backup/report", () => {
    db.prepare(
      `INSERT INTO chat_conversations (id, project_id, type, label, status, epic_id, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "conv-existing",
      "proj-1",
      "brainstorm",
      "Brainstorm",
      "active",
      null,
      "claude-code",
      "2026-02-12T10:00:00.000Z",
    );

    db.prepare(
      `INSERT INTO chat_messages (id, project_id, conversation_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg-existing",
      "proj-1",
      "conv-existing",
      "user",
      "hello",
      null,
      "2026-02-12T10:00:01.000Z",
    );

    db.prepare(
      `INSERT INTO chat_messages (id, project_id, conversation_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg-orphan",
      "proj-1",
      null,
      "assistant",
      "reply",
      null,
      "2026-02-12T10:00:02.000Z",
    );

    db.prepare(
      `INSERT INTO chat_attachments (id, chat_message_id, file_name, file_path, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "att-1",
      "msg-existing",
      "file.png",
      "/tmp/file.png",
      "image/png",
      123,
      "2026-02-12T10:00:03.000Z",
    );

    const logger = { info: vi.fn(), error: vi.fn() };
    const report = runUnifiedChatCutoverMigration("proj-1", {
      sqlite: db,
      dataDir: tmpDir,
      createId: () => "conv-fallback",
      now: () => new Date("2026-02-13T12:00:00.000Z"),
      logger,
    });

    expect(report.before).toMatchObject({
      conversations: 1,
      messages: 2,
      attachments: 1,
      orphanMessages: 1,
    });
    expect(report.actions).toMatchObject({
      createdFallbackConversation: false,
      fallbackConversationId: "conv-existing",
      messagesReassigned: 1,
    });
    expect(report.after).toMatchObject({
      conversations: 1,
      messages: 2,
      attachments: 1,
      orphanMessages: 0,
    });
    expect(report.integrity).toMatchObject({
      missingConversationReferences: 0,
      duplicateConversationIds: 0,
      duplicateMessageIds: 0,
      zeroMissingConversations: true,
      zeroDuplicateConversations: true,
      zeroDuplicateMessages: true,
    });

    const reassigned = db
      .prepare(`SELECT conversation_id AS conversationId FROM chat_messages WHERE id = ?`)
      .get("msg-orphan") as { conversationId: string };
    expect(reassigned.conversationId).toBe("conv-existing");

    const idsAfter = db
      .prepare(`SELECT id FROM chat_messages WHERE project_id = ? ORDER BY id ASC`)
      .all("proj-1") as Array<{ id: string }>;
    expect(idsAfter.map((row) => row.id)).toEqual(["msg-existing", "msg-orphan"]);

    const backupRaw = fs.readFileSync(report.backupPath, "utf-8");
    const backup = JSON.parse(backupRaw) as {
      snapshot: {
        messages: Array<{ id: string; conversation_id: string | null }>;
      };
    };
    expect(
      backup.snapshot.messages.find((message) => message.id === "msg-orphan")
        ?.conversation_id,
    ).toBeNull();

    const reportOnDisk = JSON.parse(
      fs.readFileSync(report.reportPath, "utf-8"),
    ) as { projectId: string };
    expect(reportOnDisk.projectId).toBe("proj-1");
    expect(logger.info).toHaveBeenCalled();
  });

  it("creates a fallback conversation when only orphan messages exist", () => {
    db.prepare(
      `INSERT INTO chat_messages (id, project_id, conversation_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg-orphan",
      "proj-2",
      null,
      "user",
      "hello",
      null,
      "2026-02-12T08:00:00.000Z",
    );

    const report = runUnifiedChatCutoverMigration("proj-2", {
      sqlite: db,
      dataDir: tmpDir,
      createId: () => "conv-fallback",
      now: () => new Date("2026-02-13T13:00:00.000Z"),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(report.actions).toMatchObject({
      createdFallbackConversation: true,
      fallbackConversationId: "conv-fallback",
      messagesReassigned: 1,
    });

    const conversation = db
      .prepare(`SELECT id, created_at AS createdAt FROM chat_conversations WHERE project_id = ?`)
      .get("proj-2") as { id: string; createdAt: string };
    expect(conversation.id).toBe("conv-fallback");
    expect(conversation.createdAt).toBe("2026-02-12T08:00:00.000Z");

    const message = db
      .prepare(`SELECT conversation_id AS conversationId FROM chat_messages WHERE id = ?`)
      .get("msg-orphan") as { conversationId: string };
    expect(message.conversationId).toBe("conv-fallback");
  });

  it("runs once per project when using the one-shot helper", () => {
    db.prepare(
      `INSERT INTO chat_messages (id, project_id, conversation_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg-orphan",
      "proj-once",
      null,
      "assistant",
      "reply",
      null,
      "2026-02-12T09:00:00.000Z",
    );

    const first = runUnifiedChatCutoverMigrationOnce("proj-once", {
      sqlite: db,
      dataDir: tmpDir,
      createId: () => "conv-once",
      now: () => new Date("2026-02-13T14:00:00.000Z"),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    const second = runUnifiedChatCutoverMigrationOnce("proj-once", {
      sqlite: db,
      dataDir: tmpDir,
      createId: () => "conv-once-2",
      now: () => new Date("2026-02-13T15:00:00.000Z"),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
