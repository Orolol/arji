import { describe, expect, it } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { initDb } from "@/lib/db/init";
import journal from "@/lib/db/migrations/meta/_journal.json";

const migration = journal.entries.find((entry) => entry.tag === "0052_refinement_actions")!;

describe("REfinment 2 — refinement actions migration", () => {
  it("upgrades existing sessions with NULL actions without changing their content", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite.exec("ALTER TABLE agent_sessions DROP COLUMN refinement_actions");
      // Un-stamping from 0052 replays every LATER migration too, and an ADD
      // COLUMN is not a no-op the second time — so the composite-agent
      // columns (0053, 0055) have to go back as well.
      sqlite.exec("ALTER TABLE named_agents DROP COLUMN kind");
      sqlite.exec("ALTER TABLE agent_sessions DROP COLUMN composite_agent_id");
      // 0054 DROPS a column, so rewinding past it means putting that column
      // back — the inverse of the drops above. The rewind lands after 0039
      // (which adds it), so nothing else re-creates it.
      sqlite.exec(
        "ALTER TABLE named_agents ADD COLUMN escalates_to text REFERENCES named_agents(id) ON DELETE SET NULL"
      );
      sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(migration.when);
      sqlite.exec("INSERT INTO projects (id, name) VALUES ('p', 'Old project')");
      sqlite.exec("INSERT INTO agent_sessions (id, project_id, prompt, status) VALUES ('s', 'p', 'Historical prompt', 'completed')");
      initDb(sqlite);
      expect(sqlite.prepare("SELECT prompt, status, refinement_actions FROM agent_sessions WHERE id = 's'").get())
        .toEqual({ prompt: "Historical prompt", status: "completed", refinement_actions: null });
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(() => initDb(sqlite)).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("baseline-stamps an existing column and preserves configured actions", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite.exec("INSERT INTO projects (id, name) VALUES ('p', 'Legacy project')");
      sqlite.prepare("INSERT INTO agent_sessions (id, project_id, refinement_actions) VALUES ('s', 'p', ?)").run('["grooming"]');
      sqlite.exec("DROP TABLE __drizzle_migrations");
      initDb(sqlite);
      expect(sqlite.prepare("SELECT refinement_actions FROM agent_sessions WHERE id = 's'").get())
        .toEqual({ refinement_actions: '["grooming"]' });
      expect(sqlite.prepare("SELECT created_at FROM __drizzle_migrations WHERE created_at = ?").get(migration.when)).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
});
