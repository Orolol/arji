// @vitest-environment node
//
// Node, not jsdom: the subject is a server route, and reading
// `vitest.config.ts` for the collection check below loads Vite's plugin
// pipeline, which esbuild refuses to run under jsdom's TextEncoder.
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import vitestConfig from "@/vitest.config";
import { resetDbMockState, mockRouteContext } from "@/__tests__/helpers/db-mock";
import {
  PLATFORM_MAX_BODY_BYTES,
  fileOfSize,
  platformUpload,
} from "@/__tests__/helpers/upload-request";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
  imageUploadRejectionReason,
  oversizedUploadReason,
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
 * The size limit has two sides and both have to be pinned.
 *
 * The reported bug was that only one of them existed in practice: an upload of
 * 10MB or more died on the platform's request cap before the route ran, so the
 * accepted side stopped a byte early and the refused side answered with a bare
 * 500. `imageUploadRejectionReason`'s `File too large` branch was tested dead
 * code — green in a unit test, unreachable through HTTP.
 *
 * So these tests assert on the boundary a byte at a time, through the platform
 * simulation, and on *which* code answered: the guard's own wording proves the
 * route read the file and refused it, rather than the platform truncating the
 * body and the route explaining the wreckage after the fact.
 */
describe("chat upload size boundary", () => {
  const png = (name: string, size: number) => fileOfSize(name, "image/png", size);

  async function upload(file: File) {
    const { request, delivered, bodyBytes } = platformUpload(file);
    const response = await POST(request, mockRouteContext({ projectId: "proj-1" }));
    return { response, delivered, bodyBytes };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("accepts an upload one byte under the limit", async () => {
    const { response } = await upload(png("just-under.png", MAX_IMAGE_UPLOAD_BYTES - 1));

    expect(response.status).toBe(201);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("accepts an upload sitting exactly on the limit", async () => {
    // The guard refuses `size > MAX`, so the limit itself is an accepted size —
    // and it is the exact size that used to return an empty-bodied 500.
    const { response } = await upload(png("exactly-at.png", MAX_IMAGE_UPLOAD_BYTES));

    expect(response.status).toBe(201);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("refuses an upload one byte over the limit with 413 and a usable body", async () => {
    const { response } = await upload(png("just-over.png", MAX_IMAGE_UPLOAD_BYTES + 1));

    expect(response.status).toBe(413);

    // The defect was an *empty* body, so read the raw text before parsing:
    // `res.json()` on a bare 500 throws rather than reporting the emptiness.
    const raw = await response.text();
    expect(raw).not.toBe("");

    const body = JSON.parse(raw);
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toBe("");
    expect(body.error).toContain(`Max: ${MAX_IMAGE_UPLOAD_LABEL}`);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("answers with the guard's own message, proving the guard ran", async () => {
    const file = png("just-over.png", MAX_IMAGE_UPLOAD_BYTES + 1);
    const { response, delivered, bodyBytes } = await upload(file);

    // Precondition: a file one byte over the app limit is still small enough
    // for the platform to deliver whole. Without this headroom the route never
    // sees the file and the assertion below would be testing the truncation
    // path wearing the guard's name.
    expect(bodyBytes).toBeLessThanOrEqual(PLATFORM_MAX_BODY_BYTES);
    expect(delivered).toBe(true);

    const { error } = await response.json();

    // Byte-identical to what `imageUploadRejectionReason` produces for this
    // file: the route inspected the parsed file, it did not infer a size from
    // `content-length` after a failed parse.
    expect(error).toBe(imageUploadRejectionReason(file));
    expect(error).toBe(`File too large (10.0MB). Max: ${MAX_IMAGE_UPLOAD_LABEL}`);
    expect(error).not.toBe(oversizedUploadReason(bodyBytes));
  });

  it("keeps 413 for the size and 400 for the shape", async () => {
    // 413 has to mean "too big", not "refused by the upload route" — a blanket
    // status would make the two rejections indistinguishable to the caller.
    const { response } = await upload(fileOfSize("trace.pdf", "application/pdf", 1024));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Unsupported file type: application/pdf. Allowed: png, jpg, jpeg, gif, webp",
    });
  });

  it("is collected by vitest rather than swept up by an exclude", () => {
    // The suite is only a guard if it runs. `vitest.config.ts` excludes whole
    // trees that carry their own copies of these tests (agent worktrees, the
    // clone workspace, runtime data), so pin that this file's own path sits
    // outside every one of them and matches the include glob.
    const repoRelative = path
      .relative(process.cwd(), fileURLToPath(import.meta.url))
      .split(path.sep);

    expect(repoRelative[0]).toBe("__tests__");
    expect(repoRelative.at(-1)).toMatch(/\.test\.ts$/);
    expect(vitestConfig.test?.include).toContain("**/*.test.{ts,tsx,mjs}");

    const excludedTrees = (vitestConfig.test?.exclude ?? []).map((pattern) =>
      pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")
    );
    expect(excludedTrees.length).toBeGreaterThan(0);
    for (const tree of excludedTrees) {
      expect(repoRelative).not.toContain(tree);
    }
  });
});
