import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDeleteUserStoryPermanently = vi.hoisted(() => vi.fn());
const mockTryExportArjiJson = vi.hoisted(() => vi.fn());
const ScopedDeleteNotFoundError = vi.hoisted(
  () =>
    class ScopedDeleteNotFoundError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ScopedDeleteNotFoundError";
      }
    },
);

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/planning/permanent-delete", () => ({
  deleteUserStoryPermanently: mockDeleteUserStoryPermanently,
  ScopedDeleteNotFoundError,
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mockTryExportArjiJson,
}));

describe("DELETE /api/projects/[projectId]/stories/[storyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes user story and returns parent epic id", async () => {
    mockDeleteUserStoryPermanently.mockReturnValue({ epicId: "epic-1" });
    const { DELETE } = await import("@/app/api/projects/[projectId]/stories/[storyId]/route");

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1", storyId: "story-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json).toEqual({ data: { deleted: true, epicId: "epic-1" } });
    expect(mockDeleteUserStoryPermanently).toHaveBeenCalledWith("proj-1", "story-1");
    expect(mockTryExportArjiJson).toHaveBeenCalledWith("proj-1");
  });

  it("returns 404 when project-scoped story is missing", async () => {
    mockDeleteUserStoryPermanently.mockImplementation(() => {
      throw new ScopedDeleteNotFoundError("Story not found");
    });

    const { DELETE } = await import("@/app/api/projects/[projectId]/stories/[storyId]/route");

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1", storyId: "story-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(404);
    expect(json).toEqual({ error: "Story not found" });
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
  });

  it("returns 409 when hard delete fails", async () => {
    mockDeleteUserStoryPermanently.mockImplementation(() => {
      throw new Error("delete failed");
    });

    const { DELETE } = await import("@/app/api/projects/[projectId]/stories/[storyId]/route");

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1", storyId: "story-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.error).toContain("Failed to delete story");
    expect(json.error).toContain("delete failed");
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
  });
});

