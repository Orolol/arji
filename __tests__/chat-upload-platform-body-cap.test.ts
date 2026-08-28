import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import nextConfig from "@/next.config";
import { resetDbMockState, mockRouteContext } from "@/__tests__/helpers/db-mock";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
} from "@/lib/uploads/image-attachments";

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
 * The app's size guard has to be *reachable*.
 *
 * `middleware.ts` matches `/api/:path*`, so Next buffers every upload body up
 * to `experimental.proxyClientMaxBodySize` and hands the route whatever fits.
 * That cap defaults to 10MB — the exact value `MAX_IMAGE_UPLOAD_BYTES` used to
 * hold — so a file *at* the app limit overflowed the platform cap as soon as
 * the multipart envelope was added: the body arrived truncated,
 * `request.formData()` threw, and `imageUploadRejectionReason`'s
 * `File too large` branch never ran for any file it was written to explain.
 *
 * These tests drive the route through a simulation of that truncation rule,
 * reading the cap from `next.config.ts` so the suite tracks the real
 * configuration rather than a copy of it.
 */
describe("chat upload under the platform body cap", () => {
  /** Next's documented default when the option is not configured. */
  const NEXT_DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

  const SIZE_UNITS: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  function parseSizeLimit(value: string): number {
    const match = /^\s*([\d.]+)\s*(b|kb|mb|gb)\s*$/i.exec(value);
    if (!match) throw new Error(`Unparseable size limit: ${value}`);
    return Number(match[1]) * SIZE_UNITS[match[2]!.toLowerCase()]!;
  }

  /** What the platform will actually let through to the route handler. */
  const PLATFORM_MAX_BODY_BYTES = (() => {
    const configured = nextConfig.experimental?.proxyClientMaxBodySize;
    if (typeof configured === "number") return configured;
    if (typeof configured === "string") return parseSizeLimit(configured);
    return NEXT_DEFAULT_MAX_BODY_BYTES;
  })();

  const BOUNDARY = "----ArijFormBoundaryEXAMPLE0123456789";

  /**
   * Bytes the multipart wrapper adds around the file's own bytes. Measured
   * from the real headers rather than guessed, because the whole defect is
   * that this overhead is what pushed an at-the-limit file past the cap.
   */
  function multipartEnvelopeBytes(fileName: string, mimeType: string): number {
    const encoder = new TextEncoder();
    const head =
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${BOUNDARY}--\r\n`;
    return encoder.encode(head).length + encoder.encode(tail).length;
  }

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

  /**
   * A request as the platform delivers it: intact when the whole multipart
   * body fits under the cap, truncated — so `formData()` rejects the way it
   * does in production — when it does not. `content-length` still describes
   * what the client tried to send either way.
   */
  function platformRequest(file: File): NextRequest {
    const bodyBytes = file.size + multipartEnvelopeBytes(file.name, file.type);
    const headers = new Headers({
      "content-length": String(bodyBytes),
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    });

    if (bodyBytes > PLATFORM_MAX_BODY_BYTES) {
      return {
        headers,
        formData: async () => {
          throw new TypeError("Failed to parse body as FormData.");
        },
      } as unknown as NextRequest;
    }

    return {
      headers,
      formData: async () => ({
        get: (name: string) => (name === "file" ? file : null),
      }),
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("keeps the platform cap above the app limit with room for the envelope", () => {
    // Equal limits are what made the guard unreachable. The headroom has to
    // cover the multipart wrapper, and any realistic file name with it.
    expect(PLATFORM_MAX_BODY_BYTES).toBeGreaterThan(
      MAX_IMAGE_UPLOAD_BYTES + multipartEnvelopeBytes("screenshot.png", "image/png")
    );
  });

  it("accepts a file sitting exactly on the app limit", async () => {
    // The reported bug: 9.9MB returned 201 and 10MB returned a bare 500,
    // because the envelope pushed the body over a cap set to the same number.
    const res = await POST(
      platformRequest(fileOfSize("exact.png", "image/png", MAX_IMAGE_UPLOAD_BYTES)),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(201);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("answers a file just over the app limit with the size guard's message", async () => {
    const res = await POST(
      platformRequest(
        fileOfSize("huge.png", "image/png", MAX_IMAGE_UPLOAD_BYTES + 512 * 1024)
      ),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: `File too large (10.5MB). Max: ${MAX_IMAGE_UPLOAD_LABEL}`,
    });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("still accepts a file comfortably under the limit", async () => {
    const res = await POST(
      platformRequest(fileOfSize("shot.png", "image/png", 9 * 1024 * 1024)),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(201);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("keeps the 413 for a body the platform genuinely could not deliver", async () => {
    // Far past both limits: no configuration makes this parseable, so the
    // truncation answer stays — it just no longer answers for 10MB files.
    const res = await POST(
      platformRequest(fileOfSize("massive.png", "image/png", 30 * 1024 * 1024)),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(413);
    const raw = await res.text();
    expect(raw).not.toBe("");
    expect(JSON.parse(raw).error).toContain(`Max: ${MAX_IMAGE_UPLOAD_LABEL}`);
  });

  it("keeps the label in step with the byte limit", () => {
    expect(MAX_IMAGE_UPLOAD_LABEL).toBe(
      `${MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024}MB`
    );
  });
});
