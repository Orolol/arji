import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  getDbChainMock,
  mockNextRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => Buffer.from("png-bytes")),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { GET } from "@/app/api/projects/[projectId]/uploads/[fileName]/route";

/**
 * This route is what makes a bug's stored `data/uploads/<projectId>/<file>`
 * paths displayable. It reads a path assembled from a URL segment, so its
 * whole job is to serve *only* files a project actually uploaded.
 */
describe("project uploads route", () => {
  const attachmentRow = {
    id: "att-1",
    chatMessageId: null,
    fileName: "screenshot.png",
    filePath: "data/uploads/proj-1/att-1-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-08-20T10:00:00.000Z",
  };

  function get(fileName: string, projectId = "proj-1") {
    return GET(mockNextRequest(), mockRouteContext({ projectId, fileName }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(Buffer.from("png-bytes"));
  });

  it("serves a registered upload with its recorded type", async () => {
    dbMockState.getQueue.push(attachmentRow);

    const res = await get("att-1-screenshot.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe("9");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe("png-bytes");
  });

  it("reads the file the project's upload directory holds", async () => {
    dbMockState.getQueue.push(attachmentRow);

    await get("att-1-screenshot.png");

    expect(fsMock.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining("data/uploads/proj-1/att-1-screenshot.png")
    );
  });

  it("404s a name with no attachment row, without touching the disk", async () => {
    // getQueue empty -> the lookup returns null.
    const res = await get("never-uploaded.png");

    expect(res.status).toBe(404);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it("404s a row whose recorded type is not an allowed image", async () => {
    dbMockState.getQueue.push({
      ...attachmentRow,
      fileName: "payload.html",
      filePath: "data/uploads/proj-1/att-1-payload.html",
      mimeType: "text/html",
    });

    const res = await get("att-1-payload.html");

    expect(res.status).toBe(404);
    // The point is that the bytes never leave with an executable type.
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ["traversal", "../../../etc/passwd"],
    ["a decoded separator", "nested/shot.png"],
    ["a windows separator", "..\\arij.db"],
    ["dot", "."],
    ["dot dot", ".."],
    ["empty", ""],
  ])("refuses %s before it reaches the database", async (_label, fileName) => {
    dbMockState.getQueue.push(attachmentRow);

    const res = await get(fileName);

    expect(res.status).toBe(404);
    expect(getDbChainMock().select).not.toHaveBeenCalled();
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it("404s when the row survives but the file is gone", async () => {
    dbMockState.getQueue.push(attachmentRow);
    fsMock.existsSync.mockReturnValue(false);

    const res = await get("att-1-screenshot.png");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "File not found on disk" });
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });
});
