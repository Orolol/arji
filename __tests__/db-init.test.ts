/**
 * Tests for explicit database initialization (lib/db/init.ts) and the
 * side-effect-free lazy connection module (lib/db/index.ts).
 *
 * Covers the three database states initDb() must handle:
 *  - fresh file                      -> full migration chain
 *  - legacy push-created database    -> baseline stamping, no re-migration
 *  - ad-hoc-bootstrapped database    -> chain applies around existing objects
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  DEFAULT_NAMED_AGENT_MODEL,
  DEFAULT_NAMED_AGENT_NAME,
  DEFAULT_NAMED_AGENT_PROVIDER,
  LEGACY_BASELINE_MS,
  initDb,
} from "@/lib/db/init";
import * as schema from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");

const journal = JSON.parse(
  fs.readFileSync(
    path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
    "utf-8",
  ),
) as { entries: { when: number; tag: string }[] };

const TOTAL_MIGRATIONS = journal.entries.length;

/** SQL tables declared in schema.ts. */
const schemaTables = (Object.values(schema) as unknown[]).filter(
  (value): value is SQLiteTable => is(value, SQLiteTable),
);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-init-test-"));
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

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function columnNames(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function appliedMigrationTimestamps(conn: Database.Database): number[] {
  return (
    conn
      .prepare(
        'SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at',
      )
      .all() as { created_at: number }[]
  ).map((row) => Number(row.created_at));
}

function seedRows(conn: Database.Database) {
  return conn
    .prepare("SELECT name, provider, model FROM named_agents WHERE name = ?")
    .all(DEFAULT_NAMED_AGENT_NAME) as {
    name: string;
    provider: string;
    model: string;
  }[];
}

function expectFullSchema(conn: Database.Database): void {
  const tables = tableNames(conn);
  for (const table of schemaTables) {
    const sqlName = getTableName(table);
    expect(tables, `missing table ${sqlName}`).toContain(sqlName);
    const dbColumns = columnNames(conn, sqlName);
    for (const column of Object.values(getTableColumns(table))) {
      expect(dbColumns, `missing column ${sqlName}.${column.name}`).toContain(
        column.name,
      );
    }
  }
}

/**
 * The exact bootstrap DDL the old lib/db/index.ts ran at import time.
 * Reproduces the state of a database that only ever saw that code path
 * (three tables, no core schema, no seed).
 */
function applyLegacyAdHocDdl(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS ticket_activity_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  conn.exec(
    `CREATE INDEX IF NOT EXISTS ticket_activity_log_epic_idx ON ticket_activity_log(epic_id)`,
  );
  conn.exec(
    `CREATE INDEX IF NOT EXISTS ticket_activity_log_project_idx ON ticket_activity_log(project_id)`,
  );
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      project_name TEXT NOT NULL,
      session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
      agent_type TEXT,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      target_url TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  conn.exec(
    `CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications(created_at)`,
  );
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notification_read_cursor (
      id INTEGER PRIMARY KEY,
      read_at TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// initDb() scenarios
// ---------------------------------------------------------------------------

describe("initDb", () => {
  it("builds the full schema on a fresh database", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);

      expectFullSchema(conn);

      const applied = appliedMigrationTimestamps(conn);
      expect(applied).toHaveLength(TOTAL_MIGRATIONS);
      // The two runtime migrations that replaced the ad-hoc bootstrap DDL.
      expect(applied).toContain(1786711800000);
      expect(applied).toContain(1786711900000);

      const seeds = seedRows(conn);
      expect(seeds).toHaveLength(1);
      expect(seeds[0]).toEqual({
        name: DEFAULT_NAMED_AGENT_NAME,
        provider: DEFAULT_NAMED_AGENT_PROVIDER,
        model: DEFAULT_NAMED_AGENT_MODEL,
      });
    });
  });

  it("is idempotent when run repeatedly on the same database", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);
      initDb(conn);
      initDb(conn);

      expect(appliedMigrationTimestamps(conn)).toHaveLength(TOTAL_MIGRATIONS);
      expect(seedRows(conn)).toHaveLength(1);
    });
  });

  it("baseline-stamps a legacy push-created database instead of re-running migrations", () => {
    const file = tempDbPath();

    // Build a complete database, then erase drizzle's bookkeeping to simulate
    // a database whose schema came from `drizzle-kit push` + the old ad-hoc
    // DDL (all tables + seed present, no __drizzle_migrations).
    withDb(file, (conn) => {
      initDb(conn);
      conn.exec('DROP TABLE "__drizzle_migrations"');
    });

    withDb(file, (conn) => {
      // Plain CREATE TABLE statements in the early chain would throw here if
      // the chain were actually re-executed.
      expect(() => initDb(conn)).not.toThrow();

      const applied = appliedMigrationTimestamps(conn);
      expect(applied).toHaveLength(TOTAL_MIGRATIONS);
      // Baseline rows were stamped, post-baseline migrations actually ran.
      expect(applied.filter((ms) => ms <= LEGACY_BASELINE_MS)).toHaveLength(
        journal.entries.filter((entry) => entry.when <= LEGACY_BASELINE_MS)
          .length,
      );

      expectFullSchema(conn);
      expect(seedRows(conn)).toHaveLength(1);
    });
  });

  it("runs column-adding migrations on legacy databases that lack the columns", () => {
    const file = tempDbPath();

    // Simulate a push-created database from before 0023: full schema minus
    // bookkeeping, with every post-baseline column removed again. (All of
    // them must go — leaving a newer column in place would legitimately
    // raise the stamp ceiling past the older column migrations.)
    withDb(file, (conn) => {
      initDb(conn);
      conn.exec('DROP TABLE "__drizzle_migrations"');
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN outcome");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN input_tokens");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN output_tokens");
      // 0047 covers this column, and SQLite refuses to drop a column an
      // index still references. The replay re-creates the index.
      conn.exec("DROP INDEX IF EXISTS agent_sessions_named_agent_activity_idx");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN total_cost_usd");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN batch_run_id");
      conn.exec("ALTER TABLE projects DROP COLUMN clone_source");
      conn.exec("ALTER TABLE projects DROP COLUMN git_remote_url");
      conn.exec("ALTER TABLE projects DROP COLUMN default_branch");
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN project_id");
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN epic_id");
      conn.exec("ALTER TABLE notifications DROP COLUMN message");
      // 0042 indexes this column, and SQLite refuses to drop a column an
      // index still references. The replay re-creates the index.
      conn.exec("DROP INDEX IF EXISTS review_comments_session_idx");
      conn.exec("ALTER TABLE review_comments DROP COLUMN agent_session_id");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN review_verdict");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN mcp_channel");
      conn.exec("ALTER TABLE named_agents DROP COLUMN options");
      conn.exec("ALTER TABLE named_agents DROP COLUMN persona_prompt");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN cli_options");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN estimated_prompt_tokens");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN estimated_prompt_breakdown");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN refinement_actions");
      // 0053/0055 (composite agents). Dropped for the same reason as every
      // column above: the replay re-adds them, and an ADD COLUMN is not a
      // no-op the second time.
      conn.exec("ALTER TABLE named_agents DROP COLUMN kind");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN composite_agent_id");
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      // The column migrations were not stamped away — they actually ran.
      expect(columnNames(conn, "agent_sessions")).toContain("outcome");
      expect(columnNames(conn, "agent_sessions")).toContain("input_tokens");
      expect(columnNames(conn, "agent_sessions")).toContain("output_tokens");
      expect(columnNames(conn, "agent_sessions")).toContain("total_cost_usd");
      expect(columnNames(conn, "agent_sessions")).toContain("batch_run_id");
      expect(columnNames(conn, "review_comments")).toContain(
        "agent_session_id",
      );
      expect(columnNames(conn, "projects")).toContain("clone_source");
      expect(columnNames(conn, "projects")).toContain("git_remote_url");
      expect(columnNames(conn, "projects")).toContain("default_branch");
      expect(columnNames(conn, "chat_attachments")).toContain("project_id");
      expect(columnNames(conn, "chat_attachments")).toContain("epic_id");
      expect(columnNames(conn, "notifications")).toContain("message");
      expect(columnNames(conn, "agent_sessions")).toContain("review_verdict");
      expect(columnNames(conn, "named_agents")).toContain("options");
      expect(columnNames(conn, "named_agents")).toContain("persona_prompt");
      expect(columnNames(conn, "agent_sessions")).toContain("cli_options");
      expect(appliedMigrationTimestamps(conn)).toHaveLength(TOTAL_MIGRATIONS);
      expectFullSchema(conn);
    });
  });

  it("leaves git_sync_log.project_id nullable so pre-project clones can be audited", () => {
    // A first-time import clones before the project row exists. 0029 rebuilds
    // the table to allow that; the insert is the assertion, since a NOT NULL
    // left in place would reject it.
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);

      expect(() =>
        conn
          .prepare(
            `INSERT INTO git_sync_log (id, project_id, operation, status, detail)
             VALUES (?, NULL, 'clone', 'success', ?)`,
          )
          .run("log_1", JSON.stringify({ ownerRepo: "owner/repo" })),
      ).not.toThrow();

      const row = conn
        .prepare("SELECT project_id, operation FROM git_sync_log WHERE id = ?")
        .get("log_1") as { project_id: string | null; operation: string };

      expect(row.project_id).toBeNull();
      expect(row.operation).toBe("clone");

      // The cascade to projects has to survive the rebuild.
      const foreignKeys = conn
        .prepare("PRAGMA foreign_key_list(git_sync_log)")
        .all() as Array<{ table: string; on_delete: string }>;
      expect(foreignKeys).toHaveLength(1);
      expect(foreignKeys[0].table).toBe("projects");
      expect(foreignKeys[0].on_delete.toUpperCase()).toBe("CASCADE");
    });
  });

  it("stamps up to the newest present column and runs the rest (legacy DB at 0023)", () => {
    const file = tempDbPath();

    // Simulate a bookkeeping-less database whose schema stops at 0023:
    // outcome exists; the 0024 usage columns, the 0025 table, the 0026
    // batch_run_id column, the 0028 clone columns, the 0030 attachment
    // ownership columns, 0032 finding attribution, and the 0033 review
    // verdict do not.
    withDb(file, (conn) => {
      initDb(conn);
      conn.exec('DROP TABLE "__drizzle_migrations"');
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN input_tokens");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN output_tokens");
      // 0047 covers this column, and SQLite refuses to drop a column an
      // index still references. The replay re-creates the index.
      conn.exec("DROP INDEX IF EXISTS agent_sessions_named_agent_activity_idx");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN total_cost_usd");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN batch_run_id");
      conn.exec("ALTER TABLE projects DROP COLUMN clone_source");
      conn.exec("ALTER TABLE projects DROP COLUMN git_remote_url");
      conn.exec("ALTER TABLE projects DROP COLUMN default_branch");
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN project_id");
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN epic_id");
      conn.exec("ALTER TABLE notifications DROP COLUMN message");
      // 0042 indexes this column, and SQLite refuses to drop a column an
      // index still references. The replay re-creates the index.
      conn.exec("DROP INDEX IF EXISTS review_comments_session_idx");
      conn.exec("ALTER TABLE review_comments DROP COLUMN agent_session_id");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN review_verdict");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN mcp_channel");
      conn.exec("ALTER TABLE named_agents DROP COLUMN options");
      conn.exec("ALTER TABLE named_agents DROP COLUMN persona_prompt");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN cli_options");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN estimated_prompt_tokens");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN estimated_prompt_breakdown");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN refinement_actions");
      // 0053/0055 (composite agents). Dropped for the same reason as every
      // column above: the replay re-adds them, and an ADD COLUMN is not a
      // no-op the second time.
      conn.exec("ALTER TABLE named_agents DROP COLUMN kind");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN composite_agent_id");
      conn.exec("DROP TABLE ticket_read_cursors");
    });

    withDb(file, (conn) => {
      // 0023's ALTER must be stamped (outcome exists — re-running would
      // throw) while 0024/0025/0026/0028 actually run.
      expect(() => initDb(conn)).not.toThrow();

      expect(columnNames(conn, "agent_sessions")).toContain("input_tokens");
      expect(columnNames(conn, "agent_sessions")).toContain("output_tokens");
      expect(columnNames(conn, "agent_sessions")).toContain("total_cost_usd");
      expect(columnNames(conn, "agent_sessions")).toContain("batch_run_id");
      expect(columnNames(conn, "review_comments")).toContain(
        "agent_session_id",
      );
      expect(columnNames(conn, "projects")).toContain("clone_source");
      expect(columnNames(conn, "projects")).toContain("git_remote_url");
      expect(columnNames(conn, "projects")).toContain("default_branch");
      expect(columnNames(conn, "agent_sessions")).toContain("review_verdict");
      expect(columnNames(conn, "named_agents")).toContain("options");
      expect(columnNames(conn, "named_agents")).toContain("persona_prompt");
      expect(columnNames(conn, "agent_sessions")).toContain("cli_options");
      expect(tableNames(conn)).toContain("ticket_read_cursors");
      expect(appliedMigrationTimestamps(conn)).toHaveLength(TOTAL_MIGRATIONS);
      expectFullSchema(conn);
    });
  });

  it("migrates a database bootstrapped only by the old ad-hoc DDL (pre-refactor data/arij.db state)", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      applyLegacyAdHocDdl(conn);
      expect(tableNames(conn)).toEqual([
        "notification_read_cursor",
        "notifications",
        "ticket_activity_log",
      ]);

      initDb(conn);

      expectFullSchema(conn);
      expect(appliedMigrationTimestamps(conn)).toHaveLength(TOTAL_MIGRATIONS);
      expect(seedRows(conn)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Journal integrity
// ---------------------------------------------------------------------------

/**
 * Drizzle's migrator keeps ONE high-water mark — the greatest `created_at` in
 * `__drizzle_migrations` — and skips every journal entry at or below it. A
 * migration inserted with a `when` below an already-applied one is therefore
 * never applied, on any database that is already up to date, forever. These
 * tests make that mistake fail in CI instead of in someone's data directory.
 */
describe("migration journal", () => {
  const entries = journal.entries;

  it("orders migrations by a strictly increasing `when`", () => {
    const backdated = entries.filter(
      (entry, index) => index > 0 && entry.when <= entries[index - 1].when,
    );

    expect(
      backdated.map((entry) => entry.tag),
      "a migration must be appended with a `when` above every earlier one, never backdated",
    ).toEqual([]);
  });

  it("gives every migration a unique tag, timestamp and file", () => {
    expect(new Set(entries.map((entry) => entry.tag)).size).toBe(
      entries.length,
    );
    expect(new Set(entries.map((entry) => entry.when)).size).toBe(
      entries.length,
    );

    for (const entry of entries) {
      expect(
        fs.existsSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`)),
        `${entry.tag}.sql is referenced by the journal but missing on disk`,
      ).toBe(true);
    }
  });

  it("re-applies the git_sync_log rebuild without losing rows", () => {
    // That migration was renumbered (0027 -> 0028 -> 0029) after it had
    // shipped on a branch, so an early database can legitimately run the
    // rebuild twice.
    const entry = entries.find(
      (candidate) => candidate.tag === "0029_git_sync_log_nullable_project",
    );
    expect(entry).toBeDefined();

    const file = tempDbPath();
    withDb(file, (conn) => {
      initDb(conn);
      conn
        .prepare(
          "INSERT INTO git_sync_log (id, project_id, operation, status) VALUES ('g1', NULL, 'clone', 'success')",
        )
        .run();

      // Drop this row and every later one so the migrator's high-water mark
      // falls back below it, exactly as it does when the entry moves up the
      // journal. The tail re-runs with it, so every column the later
      // migrations add has to go back too — an ADD COLUMN is not a no-op the
      // second time.
      conn
        .prepare('DELETE FROM "__drizzle_migrations" WHERE created_at >= ?')
        .run(entry!.when);
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN project_id");
      conn.exec("ALTER TABLE chat_attachments DROP COLUMN epic_id");
      conn.exec("ALTER TABLE notifications DROP COLUMN message");
      // 0042 indexes this column, and SQLite refuses to drop a column an
      // index still references. The replay re-creates the index.
      conn.exec("DROP INDEX IF EXISTS review_comments_session_idx");
      conn.exec("ALTER TABLE review_comments DROP COLUMN agent_session_id");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN review_verdict");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN mcp_channel");
      conn.exec("ALTER TABLE named_agents DROP COLUMN options");
      conn.exec("ALTER TABLE named_agents DROP COLUMN persona_prompt");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN cli_options");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN estimated_prompt_tokens");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN estimated_prompt_breakdown");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN refinement_actions");
      // 0053/0055 (composite agents). Dropped for the same reason as every
      // column above: the replay re-adds them, and an ADD COLUMN is not a
      // no-op the second time.
      conn.exec("ALTER TABLE named_agents DROP COLUMN kind");
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN composite_agent_id");

      expect(() => initDb(conn)).not.toThrow();

      expect(appliedMigrationTimestamps(conn)).toContain(entry!.when);
      expect(conn.prepare("SELECT id FROM git_sync_log").all()).toHaveLength(1);
      // Still nullable afterwards.
      expect(() =>
        conn
          .prepare(
            "INSERT INTO git_sync_log (id, project_id, operation, status) VALUES ('g2', NULL, 'clone', 'success')",
          )
          .run(),
      ).not.toThrow();
    });
  });

  it("keeps the journal and the migration files in step", () => {
    const onDisk = fs
      .readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();

    expect(onDisk).toEqual(entries.map((entry) => entry.tag).sort());
  });
});

// ---------------------------------------------------------------------------
// lib/db/index.ts import behavior
// ---------------------------------------------------------------------------

describe("lib/db module import", () => {
  it("does not open a database or create the data directory at import time", async () => {
    const originalCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-import-test-"));
    tempDirs.push(dir);

    vi.resetModules();
    try {
      process.chdir(dir);
      await import("@/lib/db");
      expect(fs.existsSync(path.join(dir, "data"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      vi.resetModules();
    }
  });
});
