/**
 * Migration 0032_agent_session_review_verdict: the `review_verdict` column on
 * `agent_sessions` (the structured verdict submit_findings persists), the
 * hand-written journal entry, its POST_BASELINE_COLUMN_MIGRATIONS
 * registration, and the guarantee that existing sessions keep a NULL verdict
 * — which is exactly what selects the prose fallback.
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { agentSessions } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0032_agent_session_review_verdict";
const MIGRATION_WHEN = 1786712900000;

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
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "arij-review-verdict-test-")
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

describe("0032_agent_session_review_verdict — migration file", () => {
  it("adds the column with an ALTER TABLE statement", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8"
    );

    expect(sql).toMatch(
      /ALTER TABLE agent_sessions ADD COLUMN review_verdict text/i
    );
  });

  it("is registered in the journal at idx 31, in apply order", () => {
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);

    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(31);
    expect(entry?.when).toBe(MIGRATION_WHEN);
    // Journal order drives apply order: drizzle only applies a migration whose
    // `when` exceeds the last one recorded, so the timestamps must increase.
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries[31]?.tag).toBe(MIGRATION_TAG);
  });

  it("is listed in POST_BASELINE_COLUMN_MIGRATIONS for bookkeeping-less recovery", () => {
    const initSource = fs.readFileSync(
      path.join(process.cwd(), "lib", "db", "init.ts"),
      "utf-8"
    );
    expect(initSource).toMatch(
      /folderMillis:\s*1786712900000,\s*table:\s*"agent_sessions",\s*column:\s*"review_verdict"/
    );
  });

  it("leaves the drizzle-kit snapshots untouched (generate must not be run)", () => {
    const snapshots = fs
      .readdirSync(path.join(MIGRATIONS_FOLDER, "meta"))
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort();

    // The snapshots stop at 0013 while the journal runs far ahead;
    // regenerating them would diff against stale state and emit wrong DDL.
    expect(snapshots).not.toContain("0032_snapshot.json");
    expect(snapshots[snapshots.length - 1]).toBe("0013_snapshot.json");
  });
});

describe("0032_agent_session_review_verdict — applied schema", () => {
  it("creates the column on a fresh database", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      expect(columnNames(conn, "agent_sessions")).toContain("review_verdict");
    });
  });

  it("mirrors the column in lib/db/schema.ts", () => {
    const declared = Object.values(getTableColumns(agentSessions)).map(
      (c) => c.name
    );

    expect(declared).toEqual(expect.arrayContaining(["review_verdict"]));
  });

  it("leaves existing sessions with a NULL verdict (the prose-fallback selector)", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      conn
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("p1", "Project One");
      conn
        .prepare(
          "INSERT INTO agent_sessions (id, project_id, status, agent_type) VALUES (?, ?, ?, ?)"
        )
        .run("s1", "p1", "completed", "review_code");

      const row = conn
        .prepare("SELECT status, review_verdict FROM agent_sessions WHERE id = ?")
        .get("s1") as Record<string, unknown>;

      expect(row).toEqual({ status: "completed", review_verdict: null });
    });
  });

  it("stores each verdict of the submit_findings enum verbatim", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      conn
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("p1", "Project One");
      const verdicts = [
        "approved",
        "approved_with_minor_issues",
        "changes_requested",
      ];
      for (const [index, verdict] of verdicts.entries()) {
        conn
          .prepare(
            "INSERT INTO agent_sessions (id, project_id, status, review_verdict) VALUES (?, ?, ?, ?)"
          )
          .run(`s-${index}`, "p1", "completed", verdict);
      }

      const stored = (
        conn
          .prepare(
            "SELECT review_verdict FROM agent_sessions ORDER BY id"
          )
          .all() as { review_verdict: string }[]
      ).map((row) => row.review_verdict);

      expect(stored).toEqual(verdicts);
    });
  });

  it("applies cleanly on an existing database that predates it", () => {
    const file = tempDbPath();

    // Build the full schema, then simulate a database that predates 0032 by
    // dropping the column and un-stamping the migration — the migrator
    // replays entries strictly newer than the last stamped one.
    withDb(file, (conn) => {
      initDb(conn);
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
          "INSERT INTO agent_sessions (id, project_id, status) VALUES (?, ?, ?)"
        )
        .run("old-session", "p1", "completed");
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      expect(columnNames(conn, "agent_sessions")).toContain("review_verdict");
      const row = conn
        .prepare("SELECT status, review_verdict FROM agent_sessions WHERE id = ?")
        .get("old-session") as Record<string, unknown>;
      expect(row).toEqual({ status: "completed", review_verdict: null });
    });
  });

  it("stamps 0032 on a bookkeeping-less database that already has the column", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);
      conn.exec('DROP TABLE "__drizzle_migrations"');
    });

    withDb(file, (conn) => {
      // Re-running the ALTER would throw; the stamping path must recognise
      // the existing column instead.
      expect(() => initDb(conn)).not.toThrow();
      expect(columnNames(conn, "agent_sessions")).toContain("review_verdict");

      const applied = (
        conn
          .prepare('SELECT created_at FROM "__drizzle_migrations"')
          .all() as { created_at: number }[]
      ).map((row) => row.created_at);
      expect(applied).toContain(MIGRATION_WHEN);
    });
  });
});
