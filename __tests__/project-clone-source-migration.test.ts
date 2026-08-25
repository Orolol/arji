/**
 * Migration 0028_project_clone_source: the three provenance columns on
 * `projects` (clone_source / git_remote_url / default_branch), the hand-written
 * journal entry, and the guarantee that existing rows are untouched.
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { projects } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0028_project_clone_source";
const NEW_COLUMNS = ["clone_source", "git_remote_url", "default_branch"];

const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf-8")
) as { entries: { idx: number; when: number; tag: string }[] };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-clone-source-test-"));
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

describe("0028_project_clone_source — migration file", () => {
  it("adds the three columns with ALTER TABLE statements", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8"
    );

    for (const column of NEW_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE projects ADD COLUMN ${column} TEXT`, "i")
      );
    }
  });

  it("is registered in the journal at idx 27, in apply order", () => {
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);

    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(27);
    // Journal order drives apply order: the `when` timestamps must be strictly
    // increasing so 0028 runs after 0027_provider_usage_snapshots.
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });

  it("leaves the drizzle-kit snapshots untouched (generate must not be run)", () => {
    const snapshots = fs
      .readdirSync(path.join(MIGRATIONS_FOLDER, "meta"))
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort();

    // Snapshots stop at 0013 while the journal is far ahead — regenerating
    // them would diff against stale state and emit wrong DDL.
    expect(snapshots).not.toContain("0028_snapshot.json");
    expect(snapshots[snapshots.length - 1]).toBe("0013_snapshot.json");
  });
});

describe("0028_project_clone_source — applied schema", () => {
  it("creates the columns on a fresh database", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      const columns = columnNames(conn, "projects");
      for (const column of NEW_COLUMNS) {
        expect(columns, `missing projects.${column}`).toContain(column);
      }
    });
  });

  it("mirrors the columns in lib/db/schema.ts", () => {
    const declared = Object.values(getTableColumns(projects)).map((c) => c.name);

    expect(declared).toEqual(expect.arrayContaining(NEW_COLUMNS));
  });

  it("declares them nullable, so existing rows keep NULL and still behave", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      // A row written the pre-0028 way: no provenance columns mentioned.
      conn
        .prepare(
          "INSERT INTO projects (id, name, git_repo_path) VALUES (?, ?, ?)"
        )
        .run("p1", "Legacy project", "/home/user/code/legacy");

      const row = conn
        .prepare(
          "SELECT name, git_repo_path, clone_source, git_remote_url, default_branch FROM projects WHERE id = ?"
        )
        .get("p1") as Record<string, unknown>;

      expect(row).toEqual({
        name: "Legacy project",
        git_repo_path: "/home/user/code/legacy",
        clone_source: null,
        git_remote_url: null,
        default_branch: null,
      });
    });
  });

  it("stores clone provenance for an Arij-created directory", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      conn
        .prepare(
          `INSERT INTO projects (id, name, git_repo_path, github_owner_repo, clone_source, git_remote_url, default_branch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "p2",
          "arij",
          "/home/user/arij/projects/Orolol-arij",
          "Orolol/arij",
          "github",
          "https://github.com/Orolol/arij.git",
          "main"
        );

      const row = conn
        .prepare(
          "SELECT clone_source, git_remote_url, default_branch FROM projects WHERE id = ?"
        )
        .get("p2");

      expect(row).toEqual({
        clone_source: "github",
        git_remote_url: "https://github.com/Orolol/arij.git",
        default_branch: "main",
      });
    });
  });

  it("applies cleanly on an existing database that predates it", () => {
    const file = tempDbPath();

    // Build the full schema, then simulate a database that predates 0028 by
    // dropping the columns and un-stamping 0028 *and everything after it* —
    // the migrator replays entries strictly newer than the last stamped one,
    // so a stray later stamp would legitimately mask 0028. The later
    // migrations are safe to replay: 0029 is an idempotent rebuild, and the
    // ADD COLUMN migrations after 0028 (0030, 0031) have their columns dropped
    // here too — replaying an ALTER over an existing column would throw.
    withDb(file, (conn) => {
      initDb(conn);
      for (const column of NEW_COLUMNS) {
        conn.exec(`ALTER TABLE projects DROP COLUMN ${column}`);
      }
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN project_id");
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN epic_id");
      conn.exec("ALTER TABLE review_comments DROP COLUMN agent_session_id");
      const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);
      conn
        .prepare('DELETE FROM "__drizzle_migrations" WHERE created_at >= ?')
        .run(entry?.when);

      conn
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("pre-existing", "Older project");
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      const columns = columnNames(conn, "projects");
      for (const column of NEW_COLUMNS) {
        expect(columns).toContain(column);
      }

      const row = conn
        .prepare("SELECT name, clone_source FROM projects WHERE id = ?")
        .get("pre-existing");
      expect(row).toEqual({ name: "Older project", clone_source: null });
    });
  });

  it("stamps 0028 on a bookkeeping-less database that already has the columns", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);
      // Legacy shape: schema present (including 0028's columns) but no
      // migration bookkeeping — stampLegacyBaseline must recognise it instead
      // of letting migrate() re-run the ALTERs.
      conn.exec('DROP TABLE "__drizzle_migrations"');
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      const stamped = (
        conn
          .prepare('SELECT created_at FROM "__drizzle_migrations"')
          .all() as { created_at: number }[]
      ).map((r) => Number(r.created_at));
      const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);

      expect(stamped).toContain(entry?.when);
    });
  });
});
