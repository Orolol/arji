/**
 * POST /api/projects/[projectId]/documents/import — the batch import behind
 * the scan dialog's selection step.
 *
 * The filesystem side runs against a real temp tree (never the user's own
 * repo); only db, converters and route-helpers are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockConvertToMarkdown = vi.hoisted(() => vi.fn());

// Real drizzle-orm and real @/lib/db/schema (a schema rename must break this
// test the same way it would break prod).
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/converters", () => ({
  convertToMarkdown: mockConvertToMarkdown,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "doc-1"),
}));

// Assigned in beforeEach, read by the mock once the route module is imported
// inside a test — after initialization.
let mockScanRoot = "";

vi.mock("@/lib/api/route-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    getProjectOr404: () => ({
      project: { id: "proj-1", gitRepoPath: mockScanRoot },
    }),
    isErrorResponse: (result: unknown) => result instanceof NextResponse,
    errorResponse: (error: unknown, fallback: string) =>
      NextResponse.json(
        { error: error instanceof Error ? error.message : fallback },
        { status: 500 }
      ),
  };
});

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arij-doc-import-"));
}

function writeTree(root: string): void {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "spec.md"), "# spec");
  fs.writeFileSync(path.join(root, "README.md"), "readme");
  fs.writeFileSync(path.join(root, "legacy.doc"), "legacy word bytes");
  fs.writeFileSync(path.join(root, "a", "same.md"), "from a");
  fs.writeFileSync(path.join(root, "b", "same.md"), "from b");
}

async function post(relativePaths: unknown) {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/documents/import/route"
  );
  return POST(mockJsonRequest({ relativePaths }), mockRouteContext({ projectId: "proj-1" }));
}

describe("Documents import route", () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockConvertToMarkdown.mockResolvedValue("# Converted markdown");
    root = makeRoot();
    writeTree(root);
    mockScanRoot = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an empty selection with 400 and imports nothing", async () => {
    const res = await post([]);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("No files selected");
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await post("docs/spec.md");

    expect(res.status).toBe(400);
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("imports a selected file as a converted text document", async () => {
    dbMockState.getQueue = [null]; // duplicate check: no existing doc

    const res = await post(["docs/spec.md"]);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.imported).toHaveLength(1);
    expect(json.data.imported[0]).toMatchObject({
      projectId: "proj-1",
      originalFilename: "spec.md",
      kind: "text",
      markdownContent: "# Converted markdown",
      mimeType: "text/markdown",
      imagePath: null,
    });
    expect(json.data.skipped).toHaveLength(0);
    expect(mockConvertToMarkdown).toHaveBeenCalledTimes(1);
    expect(dbMockState.insertCalls[0]).toMatchObject({
      originalFilename: "spec.md",
      kind: "text",
    });
  });

  it("skips paths escaping the project root without reading them", async () => {
    const outside = path.join(path.dirname(root), "outside.md");
    fs.writeFileSync(outside, "secret");

    try {
      const res = await post(["../outside.md"]);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.imported).toHaveLength(0);
      expect(json.data.skipped[0].reason).toContain("Not a file");
      expect(mockConvertToMarkdown).not.toHaveBeenCalled();
      expect(dbMockState.insertCalls).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("marks files whose name already exists in the project as already imported", async () => {
    dbMockState.getQueue = [{ id: "existing-doc" }];

    const res = await post(["docs/spec.md"]);
    const json = await res.json();

    expect(json.data.imported).toHaveLength(0);
    expect(json.data.skipped[0]).toMatchObject({
      relativePath: "docs/spec.md",
      reason: "Already imported.",
    });
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("skips legacy .doc files with an actionable reason", async () => {
    const res = await post(["legacy.doc"]);
    const json = await res.json();

    expect(json.data.imported).toHaveLength(0);
    expect(json.data.skipped[0].reason).toContain(".docx");
    expect(mockConvertToMarkdown).not.toHaveBeenCalled();
  });

  it("imports only the first of two files sharing a basename", async () => {
    dbMockState.getQueue = [null]; // duplicate check for a/same.md only

    const res = await post(["a/same.md", "b/same.md"]);
    const json = await res.json();

    expect(json.data.imported).toHaveLength(1);
    expect(json.data.imported[0].markdownContent).toBe("# Converted markdown");
    expect(json.data.skipped[0]).toMatchObject({
      relativePath: "b/same.md",
    });
    expect(json.data.skipped[0].reason).toContain("already part of this request");
    expect(dbMockState.insertCalls).toHaveLength(1);
  });

  it("skips files missing from disk without aborting the batch", async () => {
    dbMockState.getQueue = [null];

    const res = await post(["docs/gone.md", "README.md"]);
    const json = await res.json();

    expect(json.data.imported).toHaveLength(1);
    expect(json.data.imported[0].originalFilename).toBe("README.md");
    expect(json.data.skipped[0]).toMatchObject({
      relativePath: "docs/gone.md",
      reason: "File not found on disk.",
    });
  });
});
