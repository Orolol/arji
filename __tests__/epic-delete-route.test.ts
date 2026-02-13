import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDeleteEpicPermanently = vi.hoisted(() => vi.fn());
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
  deleteEpicPermanently: mockDeleteEpicPermanently,
  ScopedDeleteNotFoundError,
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mockTryExportArjiJson,
}));

describe("DELETE /api/projects/[projectId]/epics/[epicId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes epic and exports project snapshot", async () => {
    const { DELETE } = await import("@/app/api/projects/[projectId]/epics/[epicId]/route");

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json).toEqual({ data: { deleted: true } });
    expect(mockDeleteEpicPermanently).toHaveBeenCalledWith("proj-1", "epic-1");
    expect(mockTryExportArjiJson).toHaveBeenCalledWith("proj-1");
  });

  it("returns 404 when project-scoped epic is missing", async () => {
    mockDeleteEpicPermanently.mockImplementation(() => {
      throw new ScopedDeleteNotFoundError("Epic not found");
    });

    const { DELETE } = await import("@/app/api/projects/[projectId]/epics/[epicId]/route");

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(404);
    expect(json).toEqual({ error: "Epic not found" });
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
  });

  it("returns 409 when hard delete fails", async () => {
    mockDeleteEpicPermanently.mockImplementation(() => {
      throw new Error("constraint failed");
    });

    const { DELETE } = await import("@/app/api/projects/[projectId]/epics/[epicId]/route");

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.error).toContain("Failed to delete epic");
    expect(json.error).toContain("constraint failed");
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
  });
});

