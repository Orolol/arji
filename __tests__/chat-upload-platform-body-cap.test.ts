import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbMockState, mockRouteContext } from "@/__tests__/helpers/db-mock";
import {
  PLATFORM_MAX_BODY_BYTES,
  fileOfSize,
  multipartEnvelopeBytes,
  platformRequest,
} from "@/__tests__/helpers/upload-request";
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
 * `proxy.ts` matches `/api/:path*`, so Next buffers every upload body up
 * to `experimental.proxyClientMaxBodySize` and hands the route whatever fits.
 * That cap defaults to 10MB — the exact value `MAX_IMAGE_UPLOAD_BYTES` used to
 * hold — so a file *at* the app limit overflowed the platform cap as soon as
 * the multipart envelope was added: the body arrived truncated,
 * `request.formData()` threw, and `imageUploadRejectionReason`'s
 * `File too large` branch never ran for any file it was written to explain.
 *
 * These tests drive the route through `__tests__/helpers/upload-request.ts`,
 * which simulates that truncation rule and reads the cap from `next.config.ts`
 * so the suite tracks the real configuration rather than a copy of it.
 */
describe("chat upload under the platform body cap", () => {
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

    expect(res.status).toBe(413);
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
