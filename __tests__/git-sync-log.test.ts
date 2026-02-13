import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn((payload: Record<string, unknown>) => {
        mockDbState.inserted.push(payload);
        return { run: vi.fn() };
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  gitSyncLog: {},
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "log-1"),
}));

describe("writeGitSyncLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.inserted = [];
  });

  it("writes machine-readable JSON detail payloads", async () => {
    const { writeGitSyncLog } = await import("@/lib/github/sync-log");

    writeGitSyncLog({
      projectId: "proj-1",
      operation: "pull",
      status: "failed",
      branch: "feature/one",
      detail: {
        code: "ff_only_conflict",
        remote: "origin",
      },
    });

    expect(mockDbState.inserted).toHaveLength(1);
    expect(mockDbState.inserted[0]).toEqual(
      expect.objectContaining({
        id: "log-1",
        projectId: "proj-1",
        operation: "pull",
        status: "failed",
        branch: "feature/one",
      })
    );
    expect(JSON.parse(String(mockDbState.inserted[0].detail))).toEqual({
      code: "ff_only_conflict",
      remote: "origin",
    });
  });
});
