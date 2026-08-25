/**
 * Migration 0031_notification_message: the `message` column on
 * `notifications` (full error text behind a failed-session notification),
 * the hand-written journal entry, and the guarantee that existing rows are
 * untouched.
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { notifications } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0031_notification_message";

const journal = JSON.parse(
  fs.readFileSync(
    path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
    "utf-8",
  ),
) as { entries: { idx: number; when: number; tag: string }[] };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "arij-notification-message-test-"),
  );
  tempDirs.push(dir);
  return path.join(dir, "arij.db");
}

function withDb<T>(file: string, fn: (conn: Database.Database) => T): T {
  const conn = new Database(file);
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

function columnNames(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
      name: string;
    }[]
  ).map((row) => row.name);
}

describe("0031_notification_message — migration file", () => {
  it("adds the column with an ALTER TABLE statement", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8",
    );

    expect(sql).toMatch(/ALTER TABLE notifications ADD COLUMN message TEXT/i);
  });

  it("is registered in the journal at idx 30, in apply order", () => {
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);

    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(30);
    // Journal order drives apply order: the `when` timestamps must be strictly
    // increasing so 0031 runs after 0030_chat_attachment_ownership.
    const whens = journal.entries.map((e) => e.when);
    expect(
      whens.every((when, index) => index === 0 || when > whens[index - 1]),
    ).toBe(true);
    // Pinned to its NEIGHBOURS, not to the end of the journal: this migration
    // is no longer the newest one and later work must not have to edit this
    // assertion. What matters is that nothing was inserted between 0030 and
    // it, and that its slot is exclusively its own — 0032 was renumbered off
    // this exact `when` for that reason.
    const tags = journal.entries.map((e) => e.tag);
    expect(tags[tags.indexOf(MIGRATION_TAG) - 1]).toBe(
      "0030_chat_attachment_ownership",
    );
    expect(
      journal.entries.filter((e) => e.when === entry?.when).map((e) => e.tag),
    ).toEqual([MIGRATION_TAG]);
  });

  it("is listed in POST_BASELINE_COLUMN_MIGRATIONS for bookkeeping-less recovery", () => {
    const initSource = fs.readFileSync(
      path.join(process.cwd(), "lib", "db", "init.ts"),
      "utf-8",
    );
    expect(initSource).toMatch(
      /folderMillis:\s*1786712800000,\s*table:\s*"notifications",\s*column:\s*"message"/,
    );
  });

  it("leaves the drizzle-kit snapshots untouched (generate must not be run)", () => {
    const snapshots = fs
      .readdirSync(path.join(MIGRATIONS_FOLDER, "meta"))
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort();

    // Snapshots stop at 0013 while the journal is far ahead — regenerating
    // them would diff against stale state and emit wrong DDL.
    expect(snapshots).not.toContain("0031_snapshot.json");
    expect(snapshots[snapshots.length - 1]).toBe("0013_snapshot.json");
  });
});

describe("0031_notification_message — applied schema", () => {
  it("creates the column on a fresh database", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      expect(columnNames(conn, "notifications")).toContain("message");
    });
  });

  it("mirrors the column in lib/db/schema.ts", () => {
    const declared = Object.values(getTableColumns(notifications)).map(
      (c) => c.name,
    );

    expect(declared).toEqual(expect.arrayContaining(["message"]));
  });

  it("keeps existing notification rows with a NULL message", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      conn
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("p1", "Project One");
      conn
        .prepare(
          `INSERT INTO notifications (id, project_id, project_name, status, title, target_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "n1",
          "p1",
          "Project One",
          "failed",
          "Build failed — E-proj-001: Login",
          "/projects/p1/sessions/s1",
          "2026-02-12 00:00:00",
        );

      const row = conn
        .prepare("SELECT title, message FROM notifications WHERE id = ?")
        .get("n1") as Record<string, unknown>;

      expect(row).toEqual({
        title: "Build failed — E-proj-001: Login",
        message: null,
      });
    });
  });

  it("stores the full failure message for a failed notification", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      conn
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("p1", "Project One");
      conn
        .prepare(
          "INSERT INTO agent_sessions (id, project_id, status) VALUES (?, ?, ?)",
        )
        .run("s2", "p1", "failed");
      conn
        .prepare(
          `INSERT INTO notifications (id, project_id, project_name, session_id, status, title, message, target_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "n2",
          "p1",
          "Project One",
          "s2",
          "failed",
          "Build failed — E-proj-001: Login",
          "The agent session failed without any error message and without any output — the process exited (or was lost) without writing stderr or text. The full process capture is at /app/data/sessions/s2/logs.json.",
          "/projects/p1/sessions/s2",
          "2026-02-12 00:00:00",
        );

      const row = conn
        .prepare("SELECT message FROM notifications WHERE id = ?")
        .get("n2") as { message: string };

      expect(row.message).toContain("without any output");
      expect(row.message).toContain("/app/data/sessions/s2/logs.json");
    });
  });

  it("applies cleanly on an existing database that predates it", () => {
    const file = tempDbPath();

    // Build the full schema, then simulate a database that predates 0031 by
    // dropping the column and un-stamping 0031 — the migrator replays entries
    // strictly newer than the last stamped one, so the columns the later
    // migrations add are dropped here too (an ADD COLUMN is not a no-op the
    // second time).
    withDb(file, (conn) => {
      initDb(conn);
      conn.exec("ALTER TABLE notifications DROP COLUMN message");
      // Un-stamping from 0031 replays every LATER migration too, and an ADD
      // COLUMN is not a no-op the second time — so 0032/0033's columns have
      // to go back as well.
      conn.exec("ALTER TABLE review_comments DROP COLUMN agent_session_id");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN review_verdict");
      const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);
      conn
        .prepare('DELETE FROM "__drizzle_migrations" WHERE created_at >= ?')
        .run(entry?.when);

      conn
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("p1", "Project One");
      conn
        .prepare(
          `INSERT INTO notifications (id, project_id, project_name, status, title, target_url)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "n3",
          "p1",
          "Project One",
          "failed",
          "Old failure",
          "/projects/p1",
        );
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      expect(columnNames(conn, "notifications")).toContain("message");

      const row = conn
        .prepare("SELECT title, message FROM notifications WHERE id = ?")
        .get("n3") as { title: string; message: null };
      expect(row).toEqual({ title: "Old failure", message: null });
    });
  });

  it("stamps 0031 on a bookkeeping-less database that already has the column", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);
      // Legacy shape: schema present (including 0031's column) but no
      // migration bookkeeping — stampLegacyBaseline must recognise it instead
      // of letting migrate() re-run the ALTER.
      conn.exec('DROP TABLE "__drizzle_migrations"');
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      const stamped = (
        conn.prepare('SELECT created_at FROM "__drizzle_migrations"').all() as {
          created_at: number;
        }[]
      ).map((r) => Number(r.created_at));
      const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);

      expect(stamped).toContain(entry?.when);
    });
  });
});
