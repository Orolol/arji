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
      headers: new Headers(),
      formData: async () => ({ get: () => file }),
    } as unknown as NextRequest;
  }

  /**
   * A body the platform truncated at its own request cap: the multipart
   * stream is cut short, so `formData()` rejects with the same TypeError Next
   * throws in production. `content-length` still describes what the client
   * tried to send.
   */
  function truncatedRequest(contentLength: number | null): NextRequest {
    const headers = new Headers();
    if (contentLength !== null) {
      headers.set("content-length", String(contentLength));
    }

    return {
      headers,
      formData: async () => {
        throw new TypeError("Failed to parse body as FormData.");
      },
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

    // 413, like a body the platform refused to deliver: one status for "too
    // big" whichever side of the platform cap the upload landed on.
    expect(res.status).toBe(413);
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

  it("answers an oversized truncated body with 413 and names the limit", async () => {
    const res = await POST(
      truncatedRequest(12 * 1024 * 1024),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(413);
    const raw = await res.text();
    expect(raw).not.toBe("");
    expect(JSON.parse(raw)).toEqual({
      error: "Upload too large (12.0MB including form overhead). Max: 10MB",
    });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("still names the limit when the truncated body declared no length", async () => {
    const res = await POST(
      truncatedRequest(null),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: "Upload too large. Max: 10MB",
    });
  });

  it("does not blame the size limit for a small unparseable body", async () => {
    const res = await POST(
      truncatedRequest(2048),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Could not read the upload. Expected a multipart form body.",
    });
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
