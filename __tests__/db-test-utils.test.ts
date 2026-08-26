import { describe, expect, it } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import * as schema from "@/lib/db/schema";

describe("createTestDb", () => {
  it("returns a db and sqlite instance", () => {
    const { db, sqlite } = createTestDb();
    expect(db).toBeDefined();
    expect(sqlite).toBeDefined();
    sqlite.close();
  });

  it("creates all schema tables", () => {
    const { sqlite } = createTestDb();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("epics");
    expect(tableNames).toContain("user_stories");
    expect(tableNames).toContain("agent_sessions");
    expect(tableNames).toContain("chat_conversations");
    expect(tableNames).toContain("chat_messages");
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("documents");
    expect(tableNames).toContain("named_agents");
    expect(tableNames).toContain("agent_prompts");
    expect(tableNames).toContain("custom_review_agents");
    expect(tableNames).toContain("agent_provider_defaults");
    expect(tableNames).toContain("ticket_dependencies");
    expect(tableNames).toContain("git_sync_log");
    expect(tableNames).toContain("qa_reports");
    expect(tableNames).toContain("qa_prompts");
    expect(tableNames).toContain("releases");
    expect(tableNames).toContain("pull_requests");
    expect(tableNames).toContain("chat_attachments");
    expect(tableNames).toContain("agent_session_sequences");
    expect(tableNames).toContain("agent_session_chunks");
    expect(tableNames).toContain("ticket_comments");
    expect(tableNames).toContain("review_comments");
    expect(tableNames).toContain("grading_reports");
    sqlite.close();
  });

  it("creates isolated instances (no cross-contamination)", () => {
    const db1 = createTestDb();
    const db2 = createTestDb();

    db1.sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Project1')").run();

    const rows = db2.sqlite.prepare("SELECT * FROM projects").all();
    expect(rows).toHaveLength(0);

    db1.sqlite.close();
    db2.sqlite.close();
  });

  it("supports Drizzle ORM queries", () => {
    const { db, sqlite } = createTestDb();

    // Insert via raw SQL
    sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Test')").run();

    // Read via Drizzle
    const result = db.select().from(schema.projects).all();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Test");

    sqlite.close();
  });

  it("enforces foreign key constraints", () => {
    const { sqlite } = createTestDb();

    // Insert epic without a valid project should fail
    expect(() => {
      sqlite.prepare("INSERT INTO epics (id, project_id, title) VALUES ('e1', 'nonexistent', 'Test')").run();
    }).toThrow();

    sqlite.close();
  });
});
