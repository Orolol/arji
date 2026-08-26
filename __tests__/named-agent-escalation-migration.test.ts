/** Migration coverage for named_agents.escalates_to (0039). */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { namedAgents } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0039_named_agent_escalation";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-agent-escalation-"));
  tempDirs.push(dir);
  const conn = new Database(path.join(dir, "arij.db"));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

describe("0039_named_agent_escalation", () => {
  it("is a hand-written journal migration with a unique increasing timestamp", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8"
    );
    expect(sql).toMatch(
      /ALTER TABLE named_agents ADD COLUMN escalates_to text REFERENCES named_agents\(id\) ON DELETE SET NULL/i
    );

    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION_TAG);
    expect(entry).toMatchObject({ idx: 38, when: 1786713600000 });
    // Appended, never spliced in: every entry recorded after it must carry a
    // strictly later timestamp, or drizzle would skip one of them.
    const position = journal.entries.findIndex(
      (candidate) => candidate.tag === MIGRATION_TAG
    );
    for (const later of journal.entries.slice(position + 1)) {
      expect(later.when).toBeGreaterThan(entry!.when);
    }
    expect(new Set(journal.entries.map((candidate) => candidate.when)).size).toBe(
      journal.entries.length
    );
  });

  it("adds the nullable self-reference and preserves legacy rows", () => {
    withDb((conn) => {
      initDb(conn);
      const columns = Object.values(getTableColumns(namedAgents)).map(
        (column) => column.name
      );
      expect(columns).toContain("escalates_to");

      conn.pragma("foreign_keys = ON");
      conn
        .prepare(
          "INSERT INTO named_agents (id, name, provider, model) VALUES (?, ?, ?, ?)"
        )
        .run("base", "Base", "claude-code", "sonnet");
      conn
        .prepare(
          "INSERT INTO named_agents (id, name, provider, model) VALUES (?, ?, ?, ?)"
        )
        .run("strong", "Strong", "claude-code", "opus");

      expect(
        conn.prepare("SELECT escalates_to FROM named_agents WHERE id = 'base'").get()
      ).toEqual({ escalates_to: null });
      conn
        .prepare("UPDATE named_agents SET escalates_to = ? WHERE id = ?")
        .run("strong", "base");
      conn.prepare("DELETE FROM named_agents WHERE id = ?").run("strong");
      expect(
        conn.prepare("SELECT escalates_to FROM named_agents WHERE id = 'base'").get()
      ).toEqual({ escalates_to: null });
    });
  });

  it("participates in bookkeeping-less ADD COLUMN recovery", () => {
    const initSource = fs.readFileSync(
      path.join(process.cwd(), "lib", "db", "init.ts"),
      "utf-8"
    );
    expect(initSource).toMatch(
      /folderMillis:\s*1786713600000,\s*table:\s*"named_agents",\s*column:\s*"escalates_to"/
    );
  });
});
