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

  // Its own slot, not a shared one: `when` IS the migrator's identity, so a
  // migration landing on a `when` another branch already used is skipped
  // forever on databases that ran the other one. Asserted against the entry
  // immediately BEFORE it rather than the journal's tail, so a migration
  // appended later (as the review-channel branch's two were) stays legal.
  it("is registered after the migration preceding it", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex(
      (item) => item.tag === MIGRATION_TAG
    );
    const entry = journal.entries[position];
    const previous = position > 0 ? journal.entries[position - 1] : undefined;

    expect(entry).toBeDefined();
    expect(entry.idx).toBe((previous?.idx ?? -1) + 1);
    expect(entry.when).toBeGreaterThan(previous?.when ?? 0);

    // And nothing after it reuses its slot.
    for (const later of journal.entries.slice(position + 1)) {
      expect(later.when).toBeGreaterThan(entry.when);
    }
  });
});
