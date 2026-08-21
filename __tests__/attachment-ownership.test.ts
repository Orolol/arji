import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-utils";

/**
 * The lifecycle of an uploaded screenshot, end to end, against a real SQLite
 * database and real files on disk.
 *
 * Mocked `fs` and a seeded query mock cannot prove any of this: a mock returns
 * its row whatever the WHERE clause asks for, and a mocked `unlinkSync` proves
 * only that a function was called. What is being asserted here is that the
 * file is *gone* — and that the ones that must survive are still there.
 */
describe("upload ownership", () => {
  const projectId = "proj-1";

  let sqlite: Database.Database;
  let cwd: string;
  let ownership: typeof import("@/lib/uploads/attachment-ownership");

  /** Writes bytes and the row `POST /chat/upload` would have written. */
  function stageUpload(
    id: string,
    options: { projectId?: string | null; epicId?: string | null; chatMessageId?: string | null } = {}
  ): string {
    const owner = options.projectId === undefined ? projectId : options.projectId;
    const directory = path.join(cwd, "data", "uploads", projectId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}-shot.png`), "png-bytes");

    const filePath = `data/uploads/${projectId}/${id}-shot.png`;

    sqlite
      .prepare(
        `INSERT INTO chat_attachments
           (id, chat_message_id, project_id, epic_id, file_name, file_path, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, 'shot.png', ?, 'image/png', 9)`
      )
      .run(id, options.chatMessageId ?? null, owner, options.epicId ?? null, filePath);

    return filePath;
  }

  function exists(relativePath: string): boolean {
    return fs.existsSync(path.join(cwd, relativePath));
  }

  function rowExists(id: string): boolean {
    return (
      sqlite.prepare("SELECT id FROM chat_attachments WHERE id = ?").get(id) !==
      undefined
    );
  }

  beforeEach(async () => {
    sqlite = createTestDb().sqlite;
    sqlite
      .prepare("INSERT INTO projects (id, name) VALUES (?, 'Project 1')")
      .run(projectId);
    sqlite
      .prepare("INSERT INTO projects (id, name) VALUES ('proj-2', 'Project 2')")
      .run();

    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "arij-uploads-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ db: drizzle(sqlite, { schema }) }));
    ownership = await import("@/lib/uploads/attachment-ownership");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/db");
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe("discarding a staged upload", () => {
    it("removes the row and the bytes", () => {
      const filePath = stageUpload("att-1");

      expect(ownership.discardStagedUpload(projectId, "att-1")).toBe("discarded");

      expect(rowExists("att-1")).toBe(false);
      expect(exists(filePath)).toBe(false);
    });

    it("refuses one a bug already owns, and leaves the file alone", () => {
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'Blank board')")
        .run(projectId);
      const filePath = stageUpload("att-1", { epicId: "bug-1" });

      expect(ownership.discardStagedUpload(projectId, "att-1")).toBe("claimed");

      // The whole point: a stale modal still holding this id must not be able
      // to blank the screenshot of the report it just filed.
      expect(rowExists("att-1")).toBe(true);
      expect(exists(filePath)).toBe(true);
    });

    it("refuses one already sent in a chat message", () => {
      sqlite
        .prepare(
          "INSERT INTO chat_messages (id, project_id, role, content) VALUES ('msg-1', ?, 'user', 'hi')"
        )
        .run(projectId);
      const filePath = stageUpload("att-1", { chatMessageId: "msg-1" });

      expect(ownership.discardStagedUpload(projectId, "att-1")).toBe("claimed");
      expect(exists(filePath)).toBe(true);
    });

    it("reads as absent from another project", () => {
      const filePath = stageUpload("att-1");

      expect(ownership.discardStagedUpload("proj-2", "att-1")).toBe("not-found");
      expect(exists(filePath)).toBe(true);
    });

    it("reports an unknown id as absent", () => {
      expect(ownership.discardStagedUpload(projectId, "nope")).toBe("not-found");
    });

    it("still cleans up a row uploaded before ownership existed", () => {
      // project_id NULL: uploaded before 0030 and unattributable by the
      // backfill. The path still says whose it is.
      const filePath = stageUpload("att-legacy", { projectId: null });

      expect(ownership.discardStagedUpload(projectId, "att-legacy")).toBe(
        "discarded"
      );
      expect(exists(filePath)).toBe(false);
    });

    it("will not let another project claim a legacy row by its path", () => {
      const filePath = stageUpload("att-legacy", { projectId: null });

      expect(ownership.discardStagedUpload("proj-2", "att-legacy")).toBe(
        "not-found"
      );
      expect(exists(filePath)).toBe(true);
    });
  });

  describe("claiming uploads for a ticket", () => {
    beforeEach(() => {
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'Blank board')")
        .run(projectId);
    });

    it("takes every staged upload it names", () => {
      const first = stageUpload("att-1");
      const second = stageUpload("att-2");

      ownership.claimUploadsForTicket(
        drizzle(sqlite, { schema }),
        projectId,
        "bug-1",
        [first, second]
      );

      const owners = sqlite
        .prepare("SELECT epic_id, project_id FROM chat_attachments ORDER BY id")
        .all() as { epic_id: string; project_id: string }[];
      expect(owners).toEqual([
        { epic_id: "bug-1", project_id: projectId },
        { epic_id: "bug-1", project_id: projectId },
      ]);
    });

    it("counts a repeated path once instead of calling it a conflict", () => {
      const only = stageUpload("att-1");

      expect(() =>
        ownership.claimUploadsForTicket(
          drizzle(sqlite, { schema }),
          projectId,
          "bug-1",
          [only, only]
        )
      ).not.toThrow();
    });

    it("throws when one of them was claimed in between", () => {
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-2', ?, 'Other')")
        .run(projectId);
      const free = stageUpload("att-1");
      const taken = stageUpload("att-2", { epicId: "bug-2" });

      expect(() =>
        ownership.claimUploadsForTicket(
          drizzle(sqlite, { schema }),
          projectId,
          "bug-1",
          [free, taken]
        )
      ).toThrow(ownership.UploadClaimConflictError);
    });

    it("adopts a legacy row that has no project yet", () => {
      const legacy = stageUpload("att-legacy", { projectId: null });

      ownership.claimUploadsForTicket(
        drizzle(sqlite, { schema }),
        projectId,
        "bug-1",
        [legacy]
      );

      const row = sqlite
        .prepare("SELECT project_id, epic_id FROM chat_attachments WHERE id = ?")
        .get("att-legacy") as { project_id: string; epic_id: string };
      expect(row).toEqual({ project_id: projectId, epic_id: "bug-1" });
    });
  });

  describe("deleting a project's uploads", () => {
    it("removes the rows and the whole upload directory", () => {
      const staged = stageUpload("att-1");
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'Blank')")
        .run(projectId);
      const claimed = stageUpload("att-2", { epicId: "bug-1" });

      const result = ownership.deleteProjectUploads(projectId);

      expect(result).toEqual({ rowsDeleted: 2, directoryRemoved: true });
      expect(exists(staged)).toBe(false);
      expect(exists(claimed)).toBe(false);
      expect(exists(`data/uploads/${projectId}`)).toBe(false);
    });

    it("takes bytes whose row was already lost", () => {
      // A chat message deleted long ago cascaded its attachment row away and
      // left the file behind. Deleting the project is the last thing that can
      // reach it.
      const directory = path.join(cwd, "data", "uploads", projectId);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "orphan.png"), "png-bytes");

      ownership.deleteProjectUploads(projectId);

      expect(exists(`data/uploads/${projectId}/orphan.png`)).toBe(false);
    });

    it("leaves another project's uploads untouched", () => {
      const mine = stageUpload("att-1");
      const theirDirectory = path.join(cwd, "data", "uploads", "proj-2");
      fs.mkdirSync(theirDirectory, { recursive: true });
      fs.writeFileSync(path.join(theirDirectory, "theirs.png"), "png-bytes");

      ownership.deleteProjectUploads(projectId);

      expect(exists(mine)).toBe(false);
      expect(exists("data/uploads/proj-2/theirs.png")).toBe(true);
    });

    it("reports nothing removed for a project that never uploaded", () => {
      expect(ownership.deleteProjectUploads("proj-2")).toEqual({
        rowsDeleted: 0,
        directoryRemoved: false,
      });
    });
  });

  describe("removeUploadFiles", () => {
    it("refuses a path that resolves outside the uploads directory", () => {
      fs.writeFileSync(path.join(cwd, "arij.db"), "not-an-upload");

      expect(
        ownership.removeUploadFiles([
          "data/uploads/../../arij.db",
          "/etc/passwd",
          "",
        ])
      ).toBe(0);
      expect(exists("arij.db")).toBe(true);
    });

    it("counts only the files that were there", () => {
      const filePath = stageUpload("att-1");

      expect(
        ownership.removeUploadFiles([filePath, `data/uploads/${projectId}/gone.png`])
      ).toBe(1);
    });
  });

  describe("deleting the ticket a screenshot belongs to", () => {
    it("takes its rows and its files with it", async () => {
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'Blank')")
        .run(projectId);
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-2', ?, 'Other')")
        .run(projectId);
      const mine = stageUpload("att-1", { epicId: "bug-1" });
      const neighbours = stageUpload("att-2", { epicId: "bug-2" });
      const staged = stageUpload("att-3");

      const { deleteEpicPermanently } = await import(
        "@/lib/planning/permanent-delete"
      );
      deleteEpicPermanently(projectId, "bug-1");

      expect(rowExists("att-1")).toBe(false);
      expect(exists(mine)).toBe(false);

      // Only its own: a sibling's screenshot and an unrelated staged upload
      // both survive.
      expect(exists(neighbours)).toBe(true);
      expect(exists(staged)).toBe(true);
    });

    it("removes the rows even on a connection with foreign keys off", async () => {
      // The files are unlinked unconditionally, so a cascade that silently did
      // not fire would leave rows pointing at bytes that no longer exist — a
      // permanently broken thumbnail. The delete states it rather than
      // inheriting it from a pragma set somewhere else.
      sqlite.pragma("foreign_keys = OFF");
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'Blank')")
        .run(projectId);
      stageUpload("att-1", { epicId: "bug-1" });

      const { deleteEpicPermanently } = await import(
        "@/lib/planning/permanent-delete"
      );
      deleteEpicPermanently(projectId, "bug-1");

      expect(rowExists("att-1")).toBe(false);
    });

    it("leaves a bug with no screenshots exactly as it was", async () => {
      sqlite
        .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'No shots')")
        .run(projectId);

      const { deleteEpicPermanently } = await import(
        "@/lib/planning/permanent-delete"
      );

      expect(() => deleteEpicPermanently(projectId, "bug-1")).not.toThrow();
      expect(
        sqlite.prepare("SELECT id FROM epics WHERE id = 'bug-1'").get()
      ).toBeUndefined();
    });
  });
});
