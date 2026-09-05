import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { ROUTINE_KINDS } from "@/lib/routines/constants";
import { projects, routines } from "@/lib/db/schema";

describe("0036_routines migration", () => {
  it("persists routine state and cascades it with the project", () => {
    const { db, sqlite } = createTestDb();
    try {
      db.insert(projects)
        .values({ id: "project-1", name: "Project" })
        .run();
      db.insert(routines)
        .values({
          id: "routine-1",
          projectId: "project-1",
          kind: "night_run",
          timeOfDay: "23:45",
        })
        .run();

      expect(
        db.select().from(routines).where(eq(routines.id, "routine-1")).get()
      ).toMatchObject({
        projectId: "project-1",
        kind: "night_run",
        enabled: true,
        timeOfDay: "23:45",
        config: "{}",
        lastRunAt: null,
        lastStatus: null,
      });

      db.delete(projects).where(eq(projects.id, "project-1")).run();
      expect(db.select().from(routines).all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects unsupported kinds and malformed daily times", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("project-1", "Project");
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
          )
          .run("routine-bad-kind", "project-1", "unknown", "09:00")
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
          )
          .run("routine-bad-time", "project-1", "night_run", "24:00")
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("allows only one routine of each kind per project", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("project-1", "Project");
      sqlite
        .prepare(
          "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
        )
        .run("routine-1", "project-1", "ci_watch", "00:00");

      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
          )
          .run("routine-2", "project-1", "ci_watch", "00:00")
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
});

/**
 * 0036 pinned the routine kinds in a CHECK constraint, and SQLite cannot
 * widen one in place — so registering a fifth dispatcher is a table rebuild.
 * These tests hold the rebuild to its two obligations: the new kind is
 * accepted, and nothing that was in the table is lost on the way through.
 */
describe("0051_routines_retention_kind migration", () => {
  const migrationSql = fs.readFileSync(
    path.join(process.cwd(), "lib/db/migrations/0051_routines_retention_kind.sql"),
    "utf-8"
  );

  it("accepts every kind the application declares, and nothing else", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("project-1", "Project");

      for (const [index, kind] of ROUTINE_KINDS.entries()) {
        sqlite
          .prepare(
            "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
          )
          .run(`routine-${index}`, "project-1", kind, "03:00");
      }
      expect(
        sqlite.prepare("SELECT COUNT(*) AS total FROM routines").get()
      ).toEqual({ total: ROUTINE_KINDS.length });

      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
          )
          .run("routine-bad", "project-1", "retention_v2", "03:00")
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("carries existing rows and their indexes through the rebuild", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
        .run("project-1", "Project");
      sqlite
        .prepare(
          `INSERT INTO routines (id, project_id, kind, enabled, time_of_day, config, last_run_at, last_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "routine-1",
          "project-1",
          "ci_watch",
          0,
          "07:15",
          '{"intervalMinutes":30}',
          "2026-09-01T07:15:00.000Z",
          "completed"
        );

      // Re-running the migration is the same copy the first pass performs;
      // it is written to be idempotent for exactly this reason.
      sqlite.exec(
        migrationSql
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter(Boolean)
          .join(";\n")
      );

      expect(
        sqlite.prepare("SELECT * FROM routines WHERE id = ?").get("routine-1")
      ).toMatchObject({
        project_id: "project-1",
        kind: "ci_watch",
        enabled: 0,
        time_of_day: "07:15",
        config: '{"intervalMinutes":30}',
        last_run_at: "2026-09-01T07:15:00.000Z",
        last_status: "completed",
      });

      // The unique index and the project cascade are recreated, not dropped.
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO routines (id, project_id, kind, time_of_day) VALUES (?, ?, ?, ?)"
          )
          .run("routine-2", "project-1", "ci_watch", "07:15")
      ).toThrow();
      sqlite.pragma("foreign_keys = ON");
      sqlite.prepare("DELETE FROM projects WHERE id = ?").run("project-1");
      expect(
        sqlite.prepare("SELECT COUNT(*) AS total FROM routines").get()
      ).toEqual({ total: 0 });
    } finally {
      sqlite.close();
    }
  });
});
