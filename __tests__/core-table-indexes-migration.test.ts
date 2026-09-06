/**
 * Migration coverage for the core-table foreign-key indexes (0046).
 *
 * Asserts the hand-written journal entry, the six indexes on a freshly
 * migrated database, that the DDL is a genuine no-op on a database that
 * already carries them (which is why it needs no POST_BASELINE_COLUMN_MIGRATIONS
 * entry — see lib/db/init.ts), and that each index actually turns its lookup
 * from a SCAN into a SEARCH.
 */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "@/lib/db/init";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0046_core_table_indexes";
const MIGRATION_WHEN = 1786714300000;

const journal = JSON.parse(
  fs.readFileSync(
    path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
    "utf-8"
  )
) as { entries: { idx: number; when: number; tag: string }[] };

/** Every index this migration creates, with the column order it declares. */
const INDEXES: { name: string; table: string; columns: string[] }[] = [
  {
    name: "epics_project_status_position_idx",
    table: "epics",
    columns: ["project_id", "status", "position"],
  },
  {
    name: "user_stories_epic_position_idx",
    table: "user_stories",
    columns: ["epic_id", "position"],
  },
  {
    name: "agent_sessions_project_created_at_idx",
    table: "agent_sessions",
    columns: ["project_id", "created_at"],
  },
  {
    name: "agent_sessions_epic_idx",
    table: "agent_sessions",
    columns: ["epic_id"],
  },
  {
    name: "ticket_comments_epic_idx",
    table: "ticket_comments",
    columns: ["epic_id"],
  },
  {
    name: "ticket_comments_user_story_idx",
    table: "ticket_comments",
    columns: ["user_story_id"],
  },
];

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-core-indexes-"));
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

/** Index names PRAGMA index_list reports for a table, autoindexes included. */
function indexList(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

/** Indexed column names, in index order. */
function indexColumns(conn: Database.Database, name: string): string[] {
  return (
    conn.prepare(`PRAGMA index_info(${name})`).all() as {
      seqno: number;
      name: string;
    }[]
  )
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => row.name);
}

function queryPlan(conn: Database.Database, sql: string): string {
  return (
    conn.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
  )
    .map((row) => row.detail)
    .join(" | ");
}

describe("0046_core_table_indexes", () => {
  it("is hand-written, with a journal entry whose idx and `when` only increase", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8"
    );

    // Every statement must be IF NOT EXISTS: that is what makes the migration
    // replay-safe and keeps it out of the baseline-stamping list.
    const statements = sql
      .split("--> statement-breakpoint")
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim()
      )
      .filter(Boolean);
    expect(statements).toHaveLength(INDEXES.length);
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE INDEX IF NOT EXISTS/i);
    }
    for (const index of INDEXES) {
      expect(sql).toContain(`\`${index.name}\``);
    }

    const position = journal.entries.findIndex(
      (candidate) => candidate.tag === MIGRATION_TAG
    );
    expect(position).toBeGreaterThanOrEqual(0);
    const entry = journal.entries[position];
    expect(entry).toMatchObject({ when: MIGRATION_WHEN });

    // Appended, never spliced in: drizzle keeps a single high-water mark, so
    // a `when` at or below an earlier entry would be skipped forever.
    for (const earlier of journal.entries.slice(0, position)) {
      expect(earlier.when).toBeLessThan(entry.when);
      expect(earlier.idx).toBeLessThan(entry.idx);
    }
    for (const later of journal.entries.slice(position + 1)) {
      expect(later.when).toBeGreaterThan(entry.when);
      expect(later.idx).toBeGreaterThan(entry.idx);
    }
    expect(
      new Set(journal.entries.map((candidate) => candidate.when)).size
    ).toBe(journal.entries.length);
    expect(journal.entries.map((candidate) => candidate.idx)).toEqual(
      journal.entries.map((_, index) => index)
    );
  });

  it("creates every index, with the declared column order, on a fresh database", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      for (const index of INDEXES) {
        expect(
          indexList(conn, index.table),
          `${index.name} missing from PRAGMA index_list(${index.table})`
        ).toContain(index.name);
        expect(indexColumns(conn, index.name)).toEqual(index.columns);
      }
    });
  });

  it("replays as a no-op on a database that already carries the indexes", () => {
    const file = tempDbPath();

    withDb(file, (conn) => {
      initDb(conn);

      // Drop this migration's bookkeeping row so the migrator's high-water
      // mark falls back below it and the DDL runs a second time — exactly
      // what a renumbering, or a database restored from an older backup of
      // the ledger, produces.
      conn
        .prepare('DELETE FROM "__drizzle_migrations" WHERE created_at >= ?')
        .run(MIGRATION_WHEN);
      // Later ADD COLUMN migrations must be rewound with the ledger.
      conn.exec("ALTER TABLE agent_sessions DROP COLUMN refinement_actions");

      expect(() => initDb(conn)).not.toThrow();

      for (const index of INDEXES) {
        // Still exactly one of each: CREATE INDEX IF NOT EXISTS cannot
        // duplicate, and nothing dropped them.
        expect(
          indexList(conn, index.table).filter((name) => name === index.name)
        ).toEqual([index.name]);
      }
    });
  });

  it("boots a pre-existing bookkeeping-less database without re-running the DDL", () => {
    const file = tempDbPath();

    // A database whose schema came from `drizzle-kit push` plus the old
    // ad-hoc bootstrap: every object present, no __drizzle_migrations.
    withDb(file, (conn) => {
      initDb(conn);
      conn.exec('DROP TABLE "__drizzle_migrations"');
    });

    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();

      const applied = (
        conn
          .prepare('SELECT created_at FROM "__drizzle_migrations"')
          .all() as { created_at: number }[]
      ).map((row) => Number(row.created_at));
      // This migration is post-baseline, so it is applied rather than
      // stamped — and applying it over existing indexes is the no-op above.
      expect(applied).toContain(MIGRATION_WHEN);

      for (const index of INDEXES) {
        expect(indexList(conn, index.table)).toContain(index.name);
      }
    });
  });

  it("turns the project- and epic-scoped lookups into index searches", () => {
    withDb(tempDbPath(), (conn) => {
      initDb(conn);

      // Board read (app/api/projects/[projectId]/epics/route.ts): the ORDER BY
      // still needs a temp b-tree because `status` sits between the two keys,
      // but the table scan is gone.
      expect(
        queryPlan(
          conn,
          "SELECT id FROM epics WHERE project_id = 'p' ORDER BY position"
        )
      ).toContain(
        "SEARCH epics USING INDEX epics_project_status_position_idx (project_id=?)"
      );
      // Next-position probe on epic creation: fully covered, all three keys.
      expect(
        queryPlan(
          conn,
          "SELECT COALESCE(MAX(position), -1) FROM epics WHERE project_id = 'p' AND status = 'todo'"
        )
      ).toContain(
        "SEARCH epics USING COVERING INDEX epics_project_status_position_idx (project_id=? AND status=?)"
      );
      expect(
        queryPlan(
          conn,
          "SELECT id FROM user_stories WHERE epic_id = 'e' ORDER BY position"
        )
      ).toContain(
        "SEARCH user_stories USING INDEX user_stories_epic_position_idx (epic_id=?)"
      );
      // Sessions list keyset page (app/api/projects/[projectId]/sessions).
      expect(
        queryPlan(
          conn,
          `SELECT id FROM agent_sessions WHERE project_id = 'p'
             AND (coalesce(created_at, '') < 'x'
                  OR (coalesce(created_at, '') = 'x' AND id > 'y'))
           ORDER BY coalesce(created_at, '') DESC, id ASC LIMIT 51`
        )
      ).toContain(
        "SEARCH agent_sessions USING INDEX agent_sessions_project_created_at_idx (project_id=?)"
      );
      expect(
        queryPlan(conn, "SELECT id FROM agent_sessions WHERE epic_id = 'e'")
      ).toContain(
        "SEARCH agent_sessions USING INDEX agent_sessions_epic_idx (epic_id=?)"
      );
      expect(
        queryPlan(conn, "SELECT id FROM ticket_comments WHERE epic_id = 'e'")
      ).toContain(
        "SEARCH ticket_comments USING INDEX ticket_comments_epic_idx (epic_id=?)"
      );
      expect(
        queryPlan(
          conn,
          "SELECT id FROM ticket_comments WHERE user_story_id = 's'"
        )
      ).toContain(
        "SEARCH ticket_comments USING INDEX ticket_comments_user_story_idx (user_story_id=?)"
      );
    });
  });
});
