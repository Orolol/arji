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

/**
 * `DELETE /api/projects/:projectId/chat/uploads/:attachmentId` — how the
 * staging UI throws away a screenshot nothing ended up owning.
 *
 * Against a real database and real files, because the interesting cases are
 * the ones where the file must still be there afterwards.
 */
describe("DELETE /chat/uploads/[attachmentId]", () => {
  const projectId = "proj-1";

  let sqlite: Database.Database;
  let cwd: string;
  let DELETE: typeof import("@/app/api/projects/[projectId]/chat/uploads/[attachmentId]/route").DELETE;

  function discard(attachmentId: string, project = projectId) {
    return DELETE(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ projectId: project, attachmentId })
    ) as Promise<NextResponse>;
  }

  function stageUpload(id: string, epicId: string | null = null): string {
    const directory = path.join(cwd, "data", "uploads", projectId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}-shot.png`), "png-bytes");

    const filePath = `data/uploads/${projectId}/${id}-shot.png`;
    sqlite
      .prepare(
        `INSERT INTO chat_attachments
           (id, chat_message_id, project_id, epic_id, file_name, file_path, mime_type, size_bytes)
         VALUES (?, NULL, ?, ?, 'shot.png', ?, 'image/png', 9)`
      )
      .run(id, projectId, epicId, filePath);

    return filePath;
  }

  function fileExists(relativePath: string): boolean {
    return fs.existsSync(path.join(cwd, relativePath));
  }

  beforeEach(async () => {
    sqlite = createTestDb().sqlite;
    sqlite
      .prepare("INSERT INTO projects (id, name) VALUES (?, 'Project 1')")
      .run(projectId);
    sqlite
      .prepare("INSERT INTO projects (id, name) VALUES ('proj-2', 'Project 2')")
      .run();

    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "arij-discard-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ db: drizzle(sqlite, { schema }) }));

    ({ DELETE } = await import(
      "@/app/api/projects/[projectId]/chat/uploads/[attachmentId]/route"
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/db");
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("deletes a staged upload and its bytes", async () => {
    const filePath = stageUpload("att-1");

    const res = await discard("att-1");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { discarded: true } });
    expect(fileExists(filePath)).toBe(false);
  });

  it("refuses one a ticket already owns", async () => {
    sqlite
      .prepare("INSERT INTO epics (id, project_id, title) VALUES ('bug-1', ?, 'Blank')")
      .run(projectId);
    const filePath = stageUpload("att-1", "bug-1");

    const res = await discard("att-1");

    expect(res.status).toBe(409);
    expect(fileExists(filePath)).toBe(true);
  });

  it("404s an unknown attachment", async () => {
    const res = await discard("nope");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Attachment not found" });
  });

  it("404s an attachment of another project without touching it", async () => {
    const filePath = stageUpload("att-1");

    const res = await discard("att-1", "proj-2");

    expect(res.status).toBe(404);
    expect(fileExists(filePath)).toBe(true);
  });
});
