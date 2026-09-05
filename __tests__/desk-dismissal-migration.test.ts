/** Migration coverage for the desk_dismissals table (0050). */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { initDb, defaultMigrationsFolder } from "@/lib/db/init";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0050_desk_dismissals";
const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf-8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/**
 * A fresh migrated database in its own mkdtemp directory.
 *
 * NOT a hardcoded path: two concurrent vitest workers would collide on one
 * file on this shared machine, and a fixed directory only exists on the
 * machine that happened to create it — which is how the first version of this
 * file passed locally and failed in CI.
 */
function withDb<T>(fn: (conn: Database.Database) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-desk-dismissals-"));
  tempDirs.push(dir);
  const conn = new Database(path.join(dir, "arij.db"));
  try {
    initDb(conn, { migrationsFolder: defaultMigrationsFolder() });
    return fn(conn);
  } finally {
    conn.close();
  }
}

function tableInfo(db: Database.Database) {
  return db.prepare("PRAGMA table_info(desk_dismissals)").all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
}

describe("0050_desk_dismissals", () => {
  it("is a hand-written journal migration with a unique increasing timestamp", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8",
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `desk_dismissals`/i);

    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION_TAG);
    expect(entry).toBeDefined();
    // `when` is the half that governs whether the migration runs at all, so it
    // is pinned to a literal. `idx` is asserted as contiguity below instead:
    // drizzle never reads it, and merging main renumbers this entry every time
    // one of main's own migrations lands ahead of it. A literal `idx` would
    // then fail the merge rather than the defect this file exists to pin.
    expect(entry!.when).toBe(1786714700000);

    // The regression this file exists to pin: main took `when` 1786714500000
    // (0048_mcp_servers) and 1786714600000 (0049_mcp_servers_scope_unique)
    // while this branch was in review. Drizzle applies a migration only when
    // its `when` EXCEEDS the last recorded one, so an equal `when` is silently
    // skipped and the table is never created.
    expect(entry!.when).toBeGreaterThan(1786714600000);

    // Appended, never spliced in.
    const position = journal.entries.findIndex(
      (candidate) => candidate.tag === MIGRATION_TAG,
    );
    for (const earlier of journal.entries.slice(0, position)) {
      expect(earlier.when).toBeLessThan(entry!.when);
    }
    // The sibling migration tests' invariant: idx IS the array index.
    expect(entry!.idx).toBe(position);
    expect(new Set(journal.entries.map((candidate) => candidate.when)).size).toBe(
      journal.entries.length,
    );

    // Every journal tag must have its file, or drizzle throws on read.
    for (const candidate of journal.entries) {
      expect(fs.existsSync(path.join(MIGRATIONS_FOLDER, `${candidate.tag}.sql`))).toBe(
        true,
      );
    }
  });

  it("applies on a fresh database", () => {
    withDb((conn) => {
      const cols = tableInfo(conn);
      expect(cols.map((c) => c.name)).toEqual([
        "epic_id",
        "kind",
        "signal_at",
        "dismissed_at",
      ]);
      // Composite PK on (epic_id, kind).
      expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
        "epic_id",
        "kind",
      ]);
      // signal_at is the only nullable column.
      expect(cols.filter((c) => c.notnull === 0).map((c) => c.name)).toEqual([
        "signal_at",
      ]);
    });
  });

  it("keeps the route's upsert to one row per (epic, kind)", () => {
    withDb((conn) => {
      const upsert = conn.prepare(
        "INSERT INTO desk_dismissals (epic_id, kind, signal_at, dismissed_at) VALUES (?,?,?,?) " +
          "ON CONFLICT(epic_id, kind) DO UPDATE SET signal_at=excluded.signal_at, dismissed_at=excluded.dismissed_at",
      );
      upsert.run("e1", "asks", "2026-08-31T09:00:00.000Z", "2026-08-31T09:00:01.000Z");
      upsert.run("e1", "asks", "2026-08-31T10:00:00.000Z", "2026-08-31T10:00:01.000Z");
      // Same epic, different family: a separate row, not a replacement.
      upsert.run("e1", "failed", "2026-08-31T11:00:00.000Z", "2026-08-31T11:00:01.000Z");

      const rows = conn
        .prepare("SELECT epic_id, kind, signal_at FROM desk_dismissals ORDER BY kind")
        .all() as { epic_id: string; kind: string; signal_at: string }[];
      expect(rows).toEqual([
        { epic_id: "e1", kind: "asks", signal_at: "2026-08-31T10:00:00.000Z" },
        { epic_id: "e1", kind: "failed", signal_at: "2026-08-31T11:00:00.000Z" },
      ]);
    });
  });
});
