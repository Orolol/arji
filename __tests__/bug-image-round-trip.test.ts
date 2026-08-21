import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";
import { parseTicketImages } from "@/lib/uploads/ticket-images";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => Buffer.from("png-bytes")),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { POST as uploadImage } from "@/app/api/projects/[projectId]/chat/upload/route";
import { POST as createBug } from "@/app/api/projects/[projectId]/bugs/route";
import { GET as serveUpload } from "@/app/api/projects/[projectId]/uploads/[fileName]/route";

/**
 * A screenshot survives bug creation only if four pieces agree on one path
 * string: the upload route that writes it, the bug route that stores it, the
 * normaliser the panel reads it back with, and the route that serves the
 * bytes. Each is unit-tested on its own — this walks the whole way across, so
 * a rename on any one of them fails here instead of silently producing a
 * ticket full of broken thumbnails.
 */
describe("bug screenshot round trip", () => {
  const projectId = "proj-1";

  function pastedScreenshot(): File {
    return {
      name: "pasted-image-1755.png",
      type: "image/png",
      size: 2048,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as File;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    fsMock.existsSync.mockReturnValue(true);
  });

  it("carries a pasted screenshot from upload to the ticket panel and back", async () => {
    // 1. The modal uploads the pasted file.
    const uploadRes = await uploadImage(
      {
        formData: async () => ({ get: () => pastedScreenshot() }),
      } as never,
      mockRouteContext({ projectId })
    );
    expect(uploadRes.status).toBe(201);
    const { data: uploaded } = await uploadRes.json();

    const attachmentRow = dbMockState.insertCalls[0] as {
      filePath: string;
      mimeType: string;
      projectId: string;
      epicId: string | null;
    };
    expect(attachmentRow.filePath).toBe(uploaded.filePath);
    // Owned by the project from the moment the bytes land, claimed by nobody
    // until something is submitted with it.
    expect(attachmentRow.projectId).toBe(projectId);
    expect(attachmentRow.epicId).toBeNull();

    // 2. The modal posts that path with the bug. The row step 1 wrote is what
    //    lets it through — the bug route accepts a path only if the upload is
    //    on record, so these two steps agree on one string or neither works.
    resetDbMockState();
    dbMockState.getQueue.push({ id: projectId, name: "Project 1" });
    dbMockState.getQueue.push(attachmentRow);
    const bugRes = await createBug(
      mockJsonRequest({ title: "Board renders blank", images: [uploaded.filePath] }),
      mockRouteContext({ projectId })
    );
    expect(bugRes.status).toBe(201);

    // The upload the modal staged is now the ticket's: the same row the panel
    // will read back is the one a project or ticket delete now reaches.
    expect(dbMockState.updateCalls).toContainEqual(
      expect.objectContaining({ projectId })
    );

    const storedImages = (dbMockState.insertCalls[0] as { images: string }).images;

    // 3. The panel reads the column back.
    const [image] = parseTicketImages(storedImages, projectId);
    expect(image).toBeDefined();
    expect(image.fileName).toBe(uploaded.filePath.split("/").pop());

    // 4. The thumbnail's src resolves to the bytes on disk.
    expect(image.url).toBe(
      `/api/projects/${projectId}/uploads/${image.fileName}`
    );

    resetDbMockState();
    dbMockState.getQueue.push(attachmentRow);
    const serveRes = await serveUpload(
      mockNextRequest({ url: `http://localhost:3000${image.url}` }),
      mockRouteContext({ projectId, fileName: image.fileName })
    );

    expect(serveRes.status).toBe(200);
    expect(serveRes.headers.get("Content-Type")).toBe("image/png");
    expect(fsMock.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(uploaded.filePath)
    );
  });
});
