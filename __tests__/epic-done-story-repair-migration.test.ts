import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_TAG = "0041_repair_done_epic_stories";
const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");

describe(MIGRATION_TAG, () => {
  it("repairs review stories under completed epics without touching other states", () => {
    const connection = new Database(":memory:");
    connection.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE epics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT
      );
      CREATE TABLE user_stories (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL,
        status TEXT
      );
      CREATE TABLE ticket_activity_log (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        epic_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        session_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO projects (id) VALUES ('project-repair');
      INSERT INTO epics (id, project_id, status) VALUES
        ('WwtYAgC2ezhu', 'project-repair', 'done'),
        ('epic-released', 'project-repair', 'released'),
        ('epic-review', 'project-repair', 'review');
      INSERT INTO user_stories (id, epic_id, status) VALUES
        ('done-parent-review', 'WwtYAgC2ezhu', 'review'),
        ('done-parent-todo', 'WwtYAgC2ezhu', 'todo'),
        ('released-parent-review', 'epic-released', 'review'),
        ('review-parent-review', 'epic-review', 'review');
    `);

    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf8"
    );
    connection.exec(sql);

    const statuses = connection
      .prepare("SELECT id, status FROM user_stories ORDER BY id")
      .all();
    expect(statuses).toEqual([
      { id: "done-parent-review", status: "done" },
      { id: "done-parent-todo", status: "todo" },
      { id: "released-parent-review", status: "done" },
      { id: "review-parent-review", status: "review" },
    ]);

    expect(
      connection
        .prepare(
          "SELECT epic_id, from_status, to_status, actor, reason FROM ticket_activity_log ORDER BY epic_id"
        )
        .all()
    ).toEqual([
      {
        epic_id: "WwtYAgC2ezhu",
        from_status: "review",
        to_status: "done",
        actor: "system",
        reason:
          "Story done-parent-review — repaired after parent epic was already completed",
      },
      {
        epic_id: "epic-released",
        from_status: "review",
        to_status: "done",
        actor: "system",
        reason:
          "Story released-parent-review — repaired after parent epic was already completed",
      },
    ]);

    connection.close();
  });

  it("is registered after every existing migration", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((item) => item.tag === MIGRATION_TAG);
    const previous = journal.entries.filter((item) => item.tag !== MIGRATION_TAG).at(-1);

    expect(entry).toBeDefined();
    expect(entry?.idx).toBe((previous?.idx ?? -1) + 1);
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
  });
});
