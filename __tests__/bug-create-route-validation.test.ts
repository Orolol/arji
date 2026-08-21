import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { NextResponse } from "next/server";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";
import { MAX_TICKET_IMAGES } from "@/lib/uploads/image-attachments";

/**
 * The request contract of `POST /api/projects/:id/bugs`.
 *
 * Run against a real database rather than a query mock, because most of what
 * is asserted here is *absence*: a rejected request must leave the `epics`
 * table exactly as it found it. A mock can only report which builder methods
 * were called; `SELECT COUNT(*)` reports whether a row exists.
 */
describe("POST /bugs request contract", () => {
  const projectId = "proj-1";

  let sqlite: Database.Database;
  let cwd: string;
  let POST: typeof import("@/app/api/projects/[projectId]/bugs/route").POST;

  function createBug(body: unknown, project = projectId) {
    return POST(
      mockNextRequest({ body }),
      mockRouteContext({ projectId: project })
    ) as Promise<NextResponse>;
  }

  function bugCount(): number {
    return (
      sqlite.prepare("SELECT COUNT(*) AS count FROM epics").get() as {
        count: number;
      }
    ).count;
  }

  /** A screenshot on record and on disk — the only kind the route accepts. */
  function stageUpload(id: string): string {
    const directory = path.join(cwd, "data", "uploads", projectId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}-shot.png`), "png-bytes");

    const filePath = `data/uploads/${projectId}/${id}-shot.png`;
    sqlite
      .prepare(
        `INSERT INTO chat_attachments
           (id, chat_message_id, project_id, epic_id, file_name, file_path, mime_type, size_bytes)
         VALUES (?, NULL, ?, NULL, 'shot.png', ?, 'image/png', 9)`
      )
      .run(id, projectId, filePath);

    return filePath;
  }

  beforeEach(async () => {
    sqlite = createTestDb().sqlite;
    sqlite
      .prepare("INSERT INTO projects (id, name) VALUES (?, 'Project 1')")
      .run(projectId);
    sqlite
      .prepare("INSERT INTO projects (id, name) VALUES ('proj-2', 'Project 2')")
      .run();

    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "arij-bugs-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ db: drizzle(sqlite, { schema }) }));
    vi.doMock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

    ({ POST } = await import("@/app/api/projects/[projectId]/bugs/route"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/db");
    vi.doUnmock("@/lib/sync/export");
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("files a bug from a minimal valid body", async () => {
    const res = await createBug({ title: "Board renders blank" });

    expect(res.status).toBe(201);
    const bug = sqlite
      .prepare("SELECT title, type, status, priority, description FROM epics")
      .get() as Record<string, unknown>;
    expect(bug).toEqual({
      title: "Board renders blank",
      type: "bug",
      status: "backlog",
      priority: 2,
      description: null,
    });
  });

  describe("rejects without inserting anything", () => {
    it.each([
      ["a missing title", {}],
      ["a whitespace-only title", { title: "   " }],
      ["a non-string title", { title: 42 }],
      ["a title past the epic cap", { title: "x".repeat(201) }],
      ["a description past the epic cap", { title: "Bug", description: "x".repeat(10001) }],
      ["a priority out of range", { title: "Bug", priority: 9 }],
      ["a non-integer priority", { title: "Bug", priority: 1.5 }],
      ["a non-array images value", { title: "Bug", images: "shot.png" }],
      ["a non-string image member", { title: "Bug", images: ["a.png", 7] }],
      ["an empty linkedEpicId", { title: "Bug", linkedEpicId: "" }],
    ])("%s", async (_label, body) => {
      const res = await createBug(body);

      expect(res.status).toBe(400);
      expect(bugCount()).toBe(0);
    });

    it("more screenshots than a ticket may carry", async () => {
      // Every one of them genuinely uploaded and servable, so the count is the
      // only thing left that can refuse the request.
      const images = Array.from({ length: MAX_TICKET_IMAGES + 1 }, (_, index) =>
        stageUpload(`att-${index}`)
      );

      const res = await createBug({ title: "Bug", images });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Validation failed",
        details: expect.objectContaining({
          images: [`A bug may carry at most ${MAX_TICKET_IMAGES} screenshots`],
        }),
      });
      expect(bugCount()).toBe(0);
    });

    it("a body that is not JSON at all", async () => {
      const res = await createBug("{ not json");

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
      expect(bugCount()).toBe(0);
    });
  });

  it("files a bug carrying exactly the screenshot cap", async () => {
    const images = Array.from({ length: MAX_TICKET_IMAGES }, (_, index) =>
      stageUpload(`att-${index}`)
    );

    const res = await createBug({ title: "Bug", images });

    expect(res.status).toBe(201);
    expect(bugCount()).toBe(1);
  });

  it("says which field was refused instead of only that one was", async () => {
    const res = await createBug({ title: "   " });

    await expect(res.json()).resolves.toEqual({
      error: "Validation failed",
      details: expect.objectContaining({ title: ["Title is required"] }),
    });
  });

  it("answers 404 for an unknown project rather than a foreign key crash", async () => {
    const res = await createBug({ title: "Orphan bug" }, "no-such-project");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Project not found" });
    expect(bugCount()).toBe(0);
  });

  describe("linkedEpicId", () => {
    beforeEach(() => {
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('epic-1', ?, 'Mine')")
        .run(projectId);
      sqlite
        .prepare(
          "INSERT INTO epics (id, project_id, title) VALUES ('epic-2', 'proj-2', 'Theirs')"
        )
        .run();
    });

    it("links an epic of this project", async () => {
      const res = await createBug({ title: "Regression", linkedEpicId: "epic-1" });

      expect(res.status).toBe(201);
      expect(
        sqlite
          .prepare("SELECT linked_epic_id FROM epics WHERE type = 'bug'")
          .get()
      ).toEqual({ linked_epic_id: "epic-1" });
    });

    it("refuses an epic belonging to another project", async () => {
      const res = await createBug({ title: "Regression", linkedEpicId: "epic-2" });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Epic not found" });
      // Two seeded epics, no third.
      expect(bugCount()).toBe(2);
    });
  });

  describe("screenshots", () => {
    it("stores the paths and hands the uploads to the new bug", async () => {
      const first = stageUpload("att-1");
      const second = stageUpload("att-2");

      const res = await createBug({ title: "Blank board", images: [first, second] });

      expect(res.status).toBe(201);

      const bug = sqlite
        .prepare("SELECT id, images FROM epics WHERE type = 'bug'")
        .get() as { id: string; images: string };
      expect(JSON.parse(bug.images)).toEqual([first, second]);

      const owners = sqlite
        .prepare("SELECT epic_id FROM chat_attachments ORDER BY id")
        .all();
      expect(owners).toEqual([{ epic_id: bug.id }, { epic_id: bug.id }]);
    });

    it("refuses a screenshot another ticket already owns, and files nothing", async () => {
      const shot = stageUpload("att-1");
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-0', ?, 'First')")
        .run(projectId);
      sqlite
        .prepare("UPDATE chat_attachments SET epic_id = 'bug-0' WHERE id = 'att-1'")
        .run();

      const res = await createBug({ title: "Second report", images: [shot] });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: `Screenshot is already attached elsewhere: ${JSON.stringify(shot)}`,
      });
      // Only the epic seeded above.
      expect(bugCount()).toBe(1);
      expect(
        sqlite.prepare("SELECT epic_id FROM chat_attachments").get()
      ).toEqual({ epic_id: "bug-0" });
    });

    it("rolls the whole bug back when the claim cannot be completed", async () => {
      const shot = stageUpload("att-1");

      // Between the servability check and the claim, another request takes the
      // upload. Simulated by claiming it during the read the route performs
      // just before its transaction.
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-0', ?, 'First')")
        .run(projectId);

      const uploads = await import("@/lib/uploads/servable-uploads");
      const real = uploads.lookupServableUpload;
      vi.spyOn(uploads, "lookupServableUpload").mockImplementation(
        (project, fileName) => {
          const result = real(project, fileName);
          sqlite
            .prepare("UPDATE chat_attachments SET epic_id = 'bug-0' WHERE id = 'att-1'")
            .run();
          return result;
        }
      );

      const res = await createBug({ title: "Racing report", images: [shot] });

      expect(res.status).toBe(409);
      // The insert happened inside the transaction the conflict aborted.
      expect(bugCount()).toBe(1);
    });
  });
});
