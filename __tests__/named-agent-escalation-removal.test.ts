/**
 * Migration coverage for 0054_drop_named_agent_escalation — the DEMOLITION of
 * the same-provider effort escalation added by 0039.
 *
 * This file replaces `named-agent-escalation-migration.test.ts`, which pinned
 * the column's existence. The mechanism it protected was unreachable by
 * default (it fired at pipeline attempt 3 while DEFAULT_PIPELINE_MAX_ATTEMPTS
 * is 2) and composite agents replace it with one ordered fallback list per
 * agent.
 *
 * Two halves, and both are needed: the SCHEMA no longer carries the column,
 * and no LIVE CODE still reads it. A schema-only assertion would stay green
 * against a resolver still selecting a column that has quietly become NULL.
 */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { namedAgents } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0054_drop_named_agent_escalation";
const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf-8")
) as { entries: { idx: number; when: number; tag: string }[] };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function withDb<T>(fn: (conn: Database.Database) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-escalation-removal-"));
  tempDirs.push(dir);
  const conn = new Database(path.join(dir, "arij.db"));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

describe("0054_drop_named_agent_escalation", () => {
  it("is a hand-written journal migration with a unique increasing timestamp", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8"
    );
    expect(sql).toMatch(/ALTER TABLE named_agents DROP COLUMN escalates_to/i);

    const entry = journal.entries.find(
      (candidate) => candidate.tag === MIGRATION_TAG
    );
    expect(entry).toBeDefined();

    // Appended, never spliced in: every entry recorded after it must carry a
    // strictly later timestamp, or drizzle would skip one of them.
    const position = journal.entries.findIndex(
      (candidate) => candidate.tag === MIGRATION_TAG
    );
    for (const later of journal.entries.slice(position + 1)) {
      expect(later.when).toBeGreaterThan(entry!.when);
    }
    expect(
      new Set(journal.entries.map((candidate) => candidate.when)).size
    ).toBe(journal.entries.length);

    // It must land AFTER the migration that created the column, or the chain
    // would drop something that does not exist yet.
    const added = journal.entries.findIndex(
      (candidate) => candidate.tag === "0039_named_agent_escalation"
    );
    expect(added).toBeGreaterThanOrEqual(0);
    expect(position).toBeGreaterThan(added);
  });

  it("leaves a migrated database with no escalation column", () => {
    withDb((conn) => {
      initDb(conn);

      const schemaColumns = Object.values(getTableColumns(namedAgents)).map(
        (column) => column.name
      );
      expect(schemaColumns).not.toContain("escalates_to");

      const live = (
        conn.prepare("PRAGMA table_info(named_agents)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      expect(live).not.toContain("escalates_to");
      // The replacement, on the same row: a composite is a named_agents row.
      expect(live).toContain("kind");

      // The chain is re-runnable: a second boot must not try the DROP again.
      expect(() => initDb(conn)).not.toThrow();
    });
  });

  it("leaves no live reader of the escalation column or its ladder rungs", () => {
    // Source scan rather than a behavioural assertion, because the failure it
    // guards against is a SURVIVING CALL SITE — a helper nothing deleted that
    // still selects a column now gone, or a pipeline rung still traced. The
    // roots are the directories that held the mechanism.
    const roots = ["lib", "app", "components", "hooks"];
    // Migration BOOKKEEPING is the second legitimate home of the string, next
    // to the migration files themselves: POST_BASELINE_COLUMN_MIGRATIONS must
    // keep probing for the column so a legacy bookkeeping-less database that
    // still carries it stamps 0039 instead of re-running its ALTER.
    const exempt = new Set([path.join(process.cwd(), "lib", "db", "init.ts")]);
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Historical migrations are the one legitimate home of the string:
          // 0039 created the column and 0054 drops it, and neither may be
          // rewritten after the fact.
          if (full.includes(path.join("db", "migrations"))) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (exempt.has(full)) continue;
        const source = fs.readFileSync(full, "utf-8");
        if (/escalates_to|escalatesTo|effortEscalation/.test(source)) {
          offenders.push(full);
        }
      }
    };

    for (const root of roots) walk(path.join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });
});
