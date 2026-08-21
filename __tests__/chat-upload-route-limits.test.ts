import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { resetDbMockState, mockRouteContext } from "@/__tests__/helpers/db-mock";
import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/uploads/image-attachments";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { POST } from "@/app/api/projects/[projectId]/chat/upload/route";

/**
 * The bug creation modal and the chat composer both upload here and both
 * pre-filter with `imageUploadRejectionReason`. These tests pin the server
 * end of that shared rule, so a client-side filter can never be the only
 * thing standing between a bad file and the disk.
 */
describe("chat upload route limits", () => {
  // jsdom's File has no arrayBuffer(), and the route needs one — so the
  // uploaded file is described directly rather than through jsdom.
  function fileOfSize(name: string, type: string, size: number): File {
    return {
      name,
      type,
      size,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as File;
  }

  function uploadRequest(file: File | null): NextRequest {
    return {
      formData: async () => ({ get: () => file }),
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("rejects a non-image file without touching the disk", async () => {
    const res = await POST(
      uploadRequest(fileOfSize("trace.pdf", "application/pdf", 1024)),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error:
        "Unsupported file type: application/pdf. Allowed: png, jpg, jpeg, gif, webp",
    });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects a file over the size limit without touching the disk", async () => {
    const res = await POST(
      uploadRequest(
        fileOfSize("huge.png", "image/png", MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024)
      ),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "File too large (11.0MB). Max: 10MB",
    });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("accepts an image inside the limit", async () => {
    const res = await POST(
      uploadRequest(fileOfSize("shot.png", "image/png", 2048)),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.mimeType).toBe("image/png");
    expect(body.data.filePath).toMatch(/^data\/uploads\/proj-1\/.+shot\.png$/);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("still rejects when no file is provided", async () => {
    const res = await POST(
      uploadRequest(null),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "No file provided" });
  });
});
