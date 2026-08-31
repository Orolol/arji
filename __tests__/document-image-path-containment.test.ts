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

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockUnlinkSync = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: { existsSync: mockExistsSync, unlinkSync: mockUnlinkSync },
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock("@/lib/documents/query", () => ({ listProjectDocuments: vi.fn() }));

import type { ProjectDocumentRecord } from "@/lib/documents/query";

/**
 * `documents.image_path` is the other database string this app turns into a
 * real file: the delete route unlinks it, and the mention builder hands it to
 * an agent as a path to open. Both are anchored at `data/documents/`, and both
 * directions of that boundary are asserted here.
 */
describe("document image paths stay inside data/documents", () => {
  const imageDoc = {
    id: "doc-1",
    projectId: "proj-1",
    originalFilename: "UI Mock.png",
    kind: "image",
    markdownContent: null,
    imagePath: "data/documents/proj-1/doc-1-ui-mock.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  } satisfies ProjectDocumentRecord;

  const outsidePaths = [
    ["a repo file outside the documents tree", "package.json"],
    ["another of the app's own data folders", "data/uploads/proj-1/att-1.png"],
    ["a traversal back out", "data/documents/proj-1/../../../package.json"],
    ["an absolute path", "/etc/passwd"],
    ["a parent-relative path", "../../../etc/passwd"],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockExistsSync.mockReturnValue(true);
  });

  describe("the prompt section that points an agent at the file", () => {
    it("gives the absolute path of a document genuinely under data/documents", async () => {
      const { buildMentionContextBlock } = await import(
        "@/lib/documents/mentions"
      );

      const block = buildMentionContextBlock([imageDoc]);

      expect(block).toContain(
        path.join(
          process.cwd(),
          "data",
          "documents",
          "proj-1",
          "doc-1-ui-mock.png"
        )
      );
    });

    it.each(outsidePaths)(
      "does not hand an agent %s",
      async (_label, imagePath) => {
        const { buildMentionContextBlock } = await import(
          "@/lib/documents/mentions"
        );

        const block = buildMentionContextBlock([{ ...imageDoc, imagePath }]);

        expect(block).toContain("(missing image path)");
        expect(block).not.toContain(path.join(process.cwd(), imagePath));
      }
    );
  });

  describe("the delete route that unlinks the file", () => {
    async function del() {
      const { DELETE } = await import(
        "@/app/api/projects/[projectId]/documents/[documentId]/route"
      );
      return DELETE(
        mockNextRequest({ method: "DELETE" }),
        mockRouteContext({ projectId: "proj-1", documentId: "doc-1" })
      );
    }

    it("unlinks a document genuinely under data/documents", async () => {
      dbMockState.getQueue = [imageDoc];

      const response = await del();

      expect(response.status).toBe(200);
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        path.join(
          process.cwd(),
          "data",
          "documents",
          "proj-1",
          "doc-1-ui-mock.png"
        )
      );
    });

    it.each(outsidePaths)("refuses to unlink %s", async (_label, imagePath) => {
      dbMockState.getQueue = [{ ...imageDoc, imagePath }];

      const response = await del();

      expect(response.status).toBe(200);
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });
  });
});
