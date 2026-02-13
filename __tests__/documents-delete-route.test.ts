import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
}));

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDbState.getQueue.shift() ?? null),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  };

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  documents: {
    id: "id",
    projectId: "projectId",
  },
}));

vi.mock("fs", () => ({
  default: {
    existsSync: mockExistsSync,
    unlinkSync: mockUnlinkSync,
  },
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
}));

describe("DELETE /api/projects/[projectId]/documents/[documentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockExistsSync.mockReturnValue(false);
  });

  it("returns 404 when document is missing", async () => {
    mockDbState.getQueue = [null];

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/documents/[documentId]/route"
    );

    const res = await DELETE({} as import("next/server").NextRequest, {
      params: Promise.resolve({ projectId: "proj-1", documentId: "doc-1" }),
    });

    expect(res.status).toBe(404);
  });

  it("deletes text document DB record without touching filesystem", async () => {
    mockDbState.getQueue = [
      {
        id: "doc-1",
        projectId: "proj-1",
        kind: "text",
        imagePath: null,
      },
    ];

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/documents/[documentId]/route"
    );

    const res = await DELETE({} as import("next/server").NextRequest, {
      params: Promise.resolve({ projectId: "proj-1", documentId: "doc-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.deleted).toBe(true);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("deletes image file and DB record for image documents", async () => {
    mockDbState.getQueue = [
      {
        id: "doc-1",
        projectId: "proj-1",
        kind: "image",
        imagePath: "data/documents/proj-1/doc-1-diagram.png",
      },
    ];
    mockExistsSync.mockReturnValue(true);

    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/documents/[documentId]/route"
    );

    const res = await DELETE({} as import("next/server").NextRequest, {
      params: Promise.resolve({ projectId: "proj-1", documentId: "doc-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });
});
