import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  mockNextRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn((_path: string) => true),
  readFileSync: vi.fn((_path: string) => Buffer.from("png-bytes")),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { GET } from "@/app/api/projects/[projectId]/chat/uploads/[attachmentId]/route";

/**
 * The route that serves a chat attachment by row id.
 *
 * It reads `chat_attachments.file_path` — a database string — and turns it
 * into a file it reads off disk, so the containment boundary is the whole
 * point: only bytes genuinely under `data/uploads/` may leave through here.
 * Both directions are asserted, because a rule that refuses everything would
 * satisfy the refusals alone.
 */
describe("GET /api/projects/[projectId]/chat/uploads/[attachmentId]", () => {
  const attachmentRow = {
    id: "att-1",
    projectId: "proj-1",
    chatMessageId: null,
    epicId: null,
    fileName: "screenshot.png",
    filePath: "data/uploads/proj-1/att-1-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-08-20T10:00:00.000Z",
  };

  function get(attachmentId = "att-1", projectId = "proj-1") {
    return GET(mockNextRequest(), mockRouteContext({ projectId, attachmentId }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(Buffer.from("png-bytes"));
  });

  // ---- the permitted direction -------------------------------------------

  it("serves a stored upload with its recorded type and exact bytes", async () => {
    dbMockState.getQueue.push(attachmentRow);

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe("9");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from("png-bytes")
    );

    expect(fsMock.readFileSync.mock.calls[0]?.[0]).toBe(
      path.join(process.cwd(), "data", "uploads", "proj-1", "att-1-screenshot.png")
    );
  });

  it("still tolerates the `./` prefix the reader accepts elsewhere", async () => {
    dbMockState.getQueue.push({
      ...attachmentRow,
      filePath: "./data/uploads/proj-1/att-1-screenshot.png",
    });

    const response = await get();

    expect(response.status).toBe(200);
    expect(fsMock.readFileSync.mock.calls[0]?.[0]).toBe(
      path.join(process.cwd(), "data", "uploads", "proj-1", "att-1-screenshot.png")
    );
  });

  it("reports a row whose bytes are gone as missing rather than serving them", async () => {
    dbMockState.getQueue.push(attachmentRow);
    fsMock.existsSync.mockReturnValue(false);

    const response = await get();

    expect(response.status).toBe(404);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it("reports an unknown id as absent", async () => {
    const response = await get("nope");

    expect(response.status).toBe(404);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  // ---- the refused direction ---------------------------------------------

  it.each([
    ["a repo file outside the uploads tree", "package.json"],
    ["another of the app's own data folders", "data/documents/proj-1/secret.md"],
    ["a traversal back out of the uploads tree", "data/uploads/proj-1/../../../package.json"],
    ["an absolute path", "/etc/passwd"],
    ["a parent-relative path", "../../../etc/passwd"],
  ])("refuses %s", async (_label, filePath) => {
    dbMockState.getQueue.push({ ...attachmentRow, filePath });

    const response = await get();

    expect(response.status).toBe(404);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it("refuses the uploads root itself", async () => {
    dbMockState.getQueue.push({ ...attachmentRow, filePath: "data/uploads" });

    const response = await get();

    expect(response.status).toBe(404);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });
});
