/**
 * Migration coverage for 0041_named_agent_options: `named_agents.options`,
 * `named_agents.persona_prompt` and `agent_sessions.cli_options`.
 *
 * The property that matters beyond "the columns exist" is that an agent that
 * predates the migration comes out of it unchanged: `{}` options (every CLI
 * flag at its default) and a NULL persona (nothing injected into its prompts).
 */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { initDb } from "@/lib/db/init";
import { agentSessions, namedAgents } from "@/lib/db/schema";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0041_named_agent_options";
const MIGRATION_WHEN = 1786713800000;

const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf-8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-agent-options-"));
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

describe("0041_named_agent_options — migration file", () => {
  it("is hand-written, with a journal entry whose timestamp only increases", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8",
    );
    expect(sql).toMatch(
      /ALTER TABLE named_agents ADD COLUMN options text NOT NULL DEFAULT '\{\}'/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE named_agents ADD COLUMN persona_prompt text/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE agent_sessions ADD COLUMN cli_options text/i,
    );
    // No DEFAULT on persona_prompt: a default would backfill every existing
    // agent and silently rewrite the prompts they already produce.
    expect(sql).not.toMatch(/persona_prompt text[^\n]*DEFAULT/i);

    const entry = journal.entries.find(
      (candidate) => candidate.tag === MIGRATION_TAG,
    );
    expect(entry).toMatchObject({ when: MIGRATION_WHEN });

    const position = journal.entries.findIndex(
      (candidate) => candidate.tag === MIGRATION_TAG,
    );
    for (const earlier of journal.entries.slice(0, position)) {
      expect(earlier.when).toBeLessThan(MIGRATION_WHEN);
    }
    for (const later of journal.entries.slice(position + 1)) {
      expect(later.when).toBeGreaterThan(MIGRATION_WHEN);
    }
    expect(
      new Set(journal.entries.map((candidate) => candidate.when)).size,
    ).toBe(journal.entries.length);
    expect(journal.entries.map((candidate) => candidate.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  it("registers all three columns for bookkeeping-less ADD COLUMN recovery", () => {
    // Without this a legacy (push-created) database re-runs the ALTERs on
    // startup and the app fails to boot.
    const initSource = fs.readFileSync(
      path.join(process.cwd(), "lib", "db", "init.ts"),
      "utf-8",
    );
    for (const [table, column] of [
      ["named_agents", "options"],
      ["named_agents", "persona_prompt"],
      ["agent_sessions", "cli_options"],
    ]) {
      expect(initSource).toMatch(
        new RegExp(
          `folderMillis:\\s*${MIGRATION_WHEN},\\s*table:\\s*"${table}",\\s*column:\\s*"${column}"`,
        ),
      );
    }
  });
});

describe("0041_named_agent_options — applied", () => {
  it("adds the columns on a virgin database", () => {
    withDb(tempDbFile(), (conn) => {
      initDb(conn);

      expect(
        Object.values(getTableColumns(namedAgents)).map((c) => c.name),
      ).toEqual(expect.arrayContaining(["options", "persona_prompt"]));
      expect(
        Object.values(getTableColumns(agentSessions)).map((c) => c.name),
      ).toContain("cli_options");

      expect(columnNames(conn, "named_agents")).toEqual(
        expect.arrayContaining(["options", "persona_prompt"]),
      );
      expect(columnNames(conn, "agent_sessions")).toContain("cli_options");
    });
  });

  it("leaves a pre-existing agent at CLI defaults with no persona", () => {
    const file = tempDbFile();

    withDb(file, (conn) => {
      initDb(conn);
      // Simulate a row written before the migration existed by clearing what
      // the columns would have been given.
      conn
        .prepare(
          "INSERT INTO named_agents (id, name, provider, model) VALUES (?, ?, ?, ?)",
        )
        .run("legacy", "Legacy", "claude-code", "sonnet");
    });

    withDb(file, (conn) => {
      const row = conn
        .prepare(
          "SELECT options, persona_prompt FROM named_agents WHERE id = 'legacy'",
        )
        .get() as { options: string; persona_prompt: string | null };

      expect(row.options).toBe("{}");
      expect(row.persona_prompt).toBeNull();
    });
  });

  it("is idempotent across restarts of an already-migrated database", () => {
    const file = tempDbFile();

    withDb(file, (conn) => {
      initDb(conn);
      conn
        .prepare(
          "INSERT INTO named_agents (id, name, provider, model, options, persona_prompt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "kept",
          "Kept",
          "codex",
          "gpt-5.5",
          '{"reasoning_effort":"high"}',
          "You are a careful reviewer",
        );
    });

    // Second boot: migrate() must not try to re-apply the ALTERs.
    withDb(file, (conn) => {
      expect(() => initDb(conn)).not.toThrow();
      const row = conn
        .prepare(
          "SELECT options, persona_prompt FROM named_agents WHERE id = 'kept'",
        )
        .get() as { options: string; persona_prompt: string | null };
      expect(row.options).toBe('{"reasoning_effort":"high"}');
      expect(row.persona_prompt).toBe("You are a careful reviewer");
    });
  });
});
