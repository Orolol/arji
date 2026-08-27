/** Migration coverage for agent_sessions estimated prompt tokens (0045). */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { agentSessions } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0045_agent_session_estimated_tokens";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-estimated-tokens-"));
  tempDirs.push(dir);
  const conn = new Database(path.join(dir, "arij.db"));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

describe("0045_agent_session_estimated_tokens", () => {
  it("is a hand-written journal migration with a unique increasing timestamp", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8"
    );
    expect(sql).toMatch(
      /ALTER TABLE agent_sessions ADD COLUMN estimated_prompt_tokens INTEGER;/i
    );
    expect(sql).toMatch(
      /ALTER TABLE agent_sessions ADD COLUMN estimated_prompt_breakdown TEXT;/i
    );

    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION_TAG);
    expect(entry).toMatchObject({ idx: 44, when: 1786714200000 });
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

  it("adds the nullable estimated prompt tokens and breakdown columns and preserves rows", () => {
    withDb((conn) => {
      initDb(conn);
      const columns = Object.values(getTableColumns(agentSessions)).map(
        (column) => column.name
      );
      expect(columns).toContain("estimated_prompt_tokens");
      expect(columns).toContain("estimated_prompt_breakdown");

      conn.pragma("foreign_keys = ON");
      conn
        .prepare(
          "INSERT INTO projects (id, name) VALUES (?, ?)"
        )
        .run("proj-1", "Project 1");

      conn
        .prepare(
          `INSERT INTO agent_sessions (
            id, project_id, status, mode, provider, estimated_prompt_tokens, estimated_prompt_breakdown
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "sess-1",
          "proj-1",
          "queued",
          "code",
          "claude-code",
          12500,
          JSON.stringify({ spec: 4000, memory: 1000, ticket: 2000, comments: 1500, findings: 2000, documents: 2000 })
        );

      const row = conn
        .prepare(
          "SELECT estimated_prompt_tokens, estimated_prompt_breakdown FROM agent_sessions WHERE id = ?"
        )
        .get("sess-1") as {
        estimated_prompt_tokens: number;
        estimated_prompt_breakdown: string;
      };

      expect(row.estimated_prompt_tokens).toBe(12500);
      const breakdown = JSON.parse(row.estimated_prompt_breakdown);
      expect(breakdown.spec).toBe(4000);
      expect(breakdown.memory).toBe(1000);
    });
  });
});
