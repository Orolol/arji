import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  getDbChainMock,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { lookupServableUpload } from "@/lib/uploads/servable-uploads";

/**
 * The one rule two routes share: the route that serves a bug's screenshot and
 * the route that stores its path. Anything this refuses is a broken thumbnail
 * if it ever reaches `epics.images`, so the refusals are the interesting half.
 */
describe("lookupServableUpload", () => {
  const attachmentRow = {
    id: "att-1",
    chatMessageId: null,
    fileName: "screenshot.png",
    filePath: "data/uploads/proj-1/att-1-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-08-20T10:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    fsMock.existsSync.mockReturnValue(true);
  });

  it("resolves a registered image to its bytes and recorded type", () => {
    dbMockState.getQueue.push(attachmentRow);

    const result = lookupServableUpload("proj-1", "att-1-screenshot.png");

    expect(result).toMatchObject({
      servable: true,
      relativePath: "data/uploads/proj-1/att-1-screenshot.png",
      mimeType: "image/png",
    });
    expect(result.servable && result.absolutePath).toContain(
      "data/uploads/proj-1/att-1-screenshot.png"
    );
  });

  it("looks the name up under the project it was asked about", () => {
    dbMockState.getQueue.push({
      ...attachmentRow,
      filePath: "data/uploads/proj-2/att-1-screenshot.png",
    });

    const result = lookupServableUpload("proj-2", "att-1-screenshot.png");

    // The project id is not a filter applied afterwards — it is part of the
    // path being looked up, which is what keeps one project's ticket from
    // reaching another's uploads.
    expect(result.servable && result.relativePath).toBe(
      "data/uploads/proj-2/att-1-screenshot.png"
    );
  });

  it("refuses a name with no attachment row", () => {
    expect(lookupServableUpload("proj-1", "never-uploaded.png")).toEqual({
      servable: false,
      reason: "not-registered",
    });
  });

  it("refuses a row whose recorded type is not an allowed image", () => {
    dbMockState.getQueue.push({ ...attachmentRow, mimeType: "text/html" });

    expect(lookupServableUpload("proj-1", "att-1-payload.html")).toEqual({
      servable: false,
      reason: "not-registered",
    });
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it.each([
    ["a traversal", "../../../etc/passwd"],
    ["a decoded separator", "nested/shot.png"],
    ["a windows separator", "..\\arij.db"],
    ["a null byte", "shot.png\u0000.txt"],
    ["dot", "."],
    ["dot dot", ".."],
    ["empty", ""],
    ["a non-string", 7],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s before querying anything", (_label, fileName) => {
    dbMockState.getQueue.push(attachmentRow);

    expect(lookupServableUpload("proj-1", fileName)).toEqual({
      servable: false,
      reason: "not-registered",
    });
    expect(getDbChainMock().select).not.toHaveBeenCalled();
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it("distinguishes an upload on record whose bytes are gone", () => {
    dbMockState.getQueue.push(attachmentRow);
    fsMock.existsSync.mockReturnValue(false);

    // A separate reason from "not-registered": the upload did happen, so the
    // caller is looking at a wiped `data/` directory, not a crafted path.
    expect(lookupServableUpload("proj-1", "att-1-screenshot.png")).toEqual({
      servable: false,
      reason: "missing-on-disk",
    });
  });
});
