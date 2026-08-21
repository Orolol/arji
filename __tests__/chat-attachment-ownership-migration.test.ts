import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { createTestDb } from "@/lib/db/test-utils";

/**
 * The backfill half of `0030_chat_attachment_ownership`.
 *
 * The ALTERs are covered wherever the columns are used; this is about the two
 * UPDATEs, which decide whether uploads made *before* the migration ever get
 * an owner. Without them, every screenshot on every ticket filed to date stays
 * exactly as unreachable as the migration was written to stop.
 *
 * Run by re-applying the real SQL file to a database whose columns have been
 * removed again — the same shape `lib/db/init.ts` recovers from — so what is
 * asserted is the statement that ships, not a copy of it.
 */
describe("0030 chat attachment ownership backfill", () => {
  let sqlite: Database.Database;

  function applyMigration() {
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "lib",
        "db",
        "migrations",
        "0030_chat_attachment_ownership.sql"
      ),
      "utf-8"
    );

    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) sqlite.exec(statement);
    }
  }

  function insertLegacyAttachment(id: string, filePath: string) {
    sqlite
      .prepare(
        `INSERT INTO chat_attachments (id, chat_message_id, file_name, file_path, mime_type, size_bytes)
         VALUES (?, NULL, 'shot.png', ?, 'image/png', 9)`
      )
      .run(id, filePath);
  }

  function ownerOf(id: string) {
    return sqlite
      .prepare("SELECT project_id, epic_id FROM chat_attachments WHERE id = ?")
      .get(id) as { project_id: string | null; epic_id: string | null };
  }

  beforeEach(() => {
    sqlite = createTestDb().sqlite;

    // Back to the pre-0030 shape.
    sqlite.exec("ALTER TABLE chat_attachments DROP COLUMN project_id");
    sqlite.exec("ALTER TABLE chat_attachments DROP COLUMN epic_id");

    sqlite.exec(`
      INSERT INTO projects (id, name)
      VALUES ('proj-1', 'One'), ('proj_1', 'Underscore'), ('proja1', 'Letter');
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("attributes an upload to the project whose directory holds it", () => {
    insertLegacyAttachment("att-1", "data/uploads/proj-1/att-1-shot.png");

    applyMigration();

    expect(ownerOf("att-1")).toEqual({ project_id: "proj-1", epic_id: null });
  });

  it("does not let a project id containing `_` swallow another's uploads", () => {
    // `_` is a single-character wildcard to LIKE, so `data/uploads/proj_1/%`
    // would also match `data/uploads/proja1/…` and hand one project's
    // screenshots — and their deletion — to the other.
    //
    // `proja1` rather than `proj-1` because a matched-two-rows subquery
    // answers with whichever id the primary key index reaches first, and
    // `proj_1` (0x5F) sorts before `proja1` (0x61) but after `proj-1` (0x2D).
    // With a dash the wrong answer would be unreachable and the wildcard could
    // go unnoticed.
    insertLegacyAttachment("att-letter", "data/uploads/proja1/att-letter-shot.png");
    insertLegacyAttachment("att-underscore", "data/uploads/proj_1/att-underscore-shot.png");

    applyMigration();

    expect(ownerOf("att-letter").project_id).toBe("proja1");
    expect(ownerOf("att-underscore").project_id).toBe("proj_1");
  });

  it("leaves an upload of a project that no longer exists unattributed", () => {
    insertLegacyAttachment("att-1", "data/uploads/gone/att-1-shot.png");

    applyMigration();

    expect(ownerOf("att-1")).toEqual({ project_id: null, epic_id: null });
  });

  it("hands a screenshot to the bug whose images column names it", () => {
    const filePath = "data/uploads/proj-1/att-1-shot.png";
    sqlite
      .prepare(
        "INSERT INTO epics (id, project_id, title, type, images) VALUES ('bug-1', 'proj-1', 'Blank', 'bug', ?)"
      )
      .run(JSON.stringify([filePath]));
    insertLegacyAttachment("att-1", filePath);

    applyMigration();

    expect(ownerOf("att-1")).toEqual({ project_id: "proj-1", epic_id: "bug-1" });
  });

  it("leaves a screenshot no ticket references staged", () => {
    insertLegacyAttachment("att-1", "data/uploads/proj-1/att-1-shot.png");
    sqlite
      .prepare(
        "INSERT INTO epics (id, project_id, title, type, images) VALUES ('bug-1', 'proj-1', 'Blank', 'bug', ?)"
      )
      .run(JSON.stringify(["data/uploads/proj-1/att-other-shot.png"]));

    applyMigration();

    expect(ownerOf("att-1").epic_id).toBeNull();
  });

  it.each([
    ["malformed JSON", "not json at all"],
    ["a bare string", '"data/uploads/proj-1/att-1-shot.png"'],
    ["null", null],
    ["an empty string", ""],
  ])("survives an images column holding %s", (_label, images) => {
    // `epics.images` is free-form text written from a request body. A value
    // json_each() cannot read must not abort the migration for every database
    // that has one.
    sqlite
      .prepare(
        "INSERT INTO epics (id, project_id, title, type, images) VALUES ('bug-1', 'proj-1', 'Blank', 'bug', ?)"
      )
      .run(images);
    insertLegacyAttachment("att-1", "data/uploads/proj-1/att-1-shot.png");

    expect(() => applyMigration()).not.toThrow();
    expect(ownerOf("att-1").project_id).toBe("proj-1");
  });

  it("keeps a ticket with no screenshots at all untouched", () => {
    sqlite
      .prepare(
        "INSERT INTO epics (id, project_id, title, type) VALUES ('bug-1', 'proj-1', 'No shots', 'bug')"
      )
      .run();

    expect(() => applyMigration()).not.toThrow();
    expect(
      sqlite.prepare("SELECT images FROM epics WHERE id = 'bug-1'").get()
    ).toEqual({ images: null });
  });
});
