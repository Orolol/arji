import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
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
