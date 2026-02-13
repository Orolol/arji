import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
  allQueue: [] as unknown[],
}));

const mockSchema = vi.hoisted(() => ({
  gitSyncLog: {
    __name: "git_sync_log",
    id: "id",
    projectId: "projectId",
    operation: "operation",
    branch: "branch",
    status: "status",
    detail: "detail",
    createdAt: "createdAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.get.mockReturnValue(null);
  chain.insert.mockImplementation((table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      mockDbState.insertCalls.push({ table, payload });
      return { run: vi.fn() };
    }),
  }));

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => mockSchema);

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "test-id-123"),
}));

describe("logSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.insertCalls = [];
    mockDbState.allQueue = [];
  });

  it("inserts a sync log entry with all fields", async () => {
    const { logSyncOperation } = await import("@/lib/github/sync-log");

    logSyncOperation({
      projectId: "proj_1",
      operation: "push",
      branch: "main",
      status: "success",
      detail: "Pushed 3 commits",
    });

    expect(mockDbState.insertCalls).toHaveLength(1);
    expect(mockDbState.insertCalls[0].table).toBe(mockSchema.gitSyncLog);
    expect(mockDbState.insertCalls[0].payload).toEqual(
      expect.objectContaining({
        id: "test-id-123",
        projectId: "proj_1",
        operation: "push",
        branch: "main",
        status: "success",
        detail: "Pushed 3 commits",
      })
    );
  });

  it("handles optional fields (branch, detail) as null", async () => {
    const { logSyncOperation } = await import("@/lib/github/sync-log");

    logSyncOperation({
      projectId: "proj_2",
      operation: "fetch",
      status: "failure",
    });

    expect(mockDbState.insertCalls).toHaveLength(1);
    expect(mockDbState.insertCalls[0].payload).toEqual(
      expect.objectContaining({
        projectId: "proj_2",
        operation: "fetch",
        branch: null,
        status: "failure",
        detail: null,
      })
    );
  });
});

describe("getRecentSyncLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.insertCalls = [];
    mockDbState.allQueue = [];
  });

  it("returns sync log entries for the project", async () => {
    const mockLogs = [
      {
        id: "log_1",
        projectId: "proj_1",
        operation: "push",
        branch: "main",
        status: "success",
        detail: null,
        createdAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "log_2",
        projectId: "proj_1",
        operation: "pull",
        branch: "dev",
        status: "failure",
        detail: "non-fast-forward",
        createdAt: "2025-01-01T01:00:00Z",
      },
    ];

    mockDbState.allQueue = [mockLogs];

    const { getRecentSyncLogs } = await import("@/lib/github/sync-log");
    const result = getRecentSyncLogs("proj_1");

    expect(result).toHaveLength(2);
    expect(result[0].operation).toBe("push");
    expect(result[1].status).toBe("failure");
  });

  it("returns empty array when no logs exist", async () => {
    mockDbState.allQueue = [[]];

    const { getRecentSyncLogs } = await import("@/lib/github/sync-log");
    const result = getRecentSyncLogs("proj_1");

    expect(result).toHaveLength(0);
  });
});
