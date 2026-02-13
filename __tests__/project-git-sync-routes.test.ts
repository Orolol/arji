import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
}));

const mockFetchGitRemote = vi.hoisted(() => vi.fn());
const mockPullGitBranchFfOnly = vi.hoisted(() => vi.fn());
const mockPushGitBranch = vi.hoisted(() => vi.fn());
const mockGetBranchSyncStatus = vi.hoisted(() => vi.fn());
const mockGetCurrentGitBranch = vi.hoisted(() => vi.fn());
const mockWriteGitSyncLog = vi.hoisted(() => vi.fn());
const MockFastForwardOnlyPullError = vi.hoisted(
  () =>
    class FastForwardOnlyPullError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "FastForwardOnlyPullError";
      }
    }
);

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDbState.getQueue.shift() ?? null),
  };

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  projects: {
    id: "id",
    gitRepoPath: "gitRepoPath",
  },
}));

vi.mock("@/lib/git/remote", () => ({
  fetchGitRemote: mockFetchGitRemote,
  pullGitBranchFfOnly: mockPullGitBranchFfOnly,
  pushGitBranch: mockPushGitBranch,
  getBranchSyncStatus: mockGetBranchSyncStatus,
  getCurrentGitBranch: mockGetCurrentGitBranch,
  FastForwardOnlyPullError: MockFastForwardOnlyPullError,
}));

vi.mock("@/lib/github/sync-log", () => ({
  writeGitSyncLog: mockWriteGitSyncLog,
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("Project git sync routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockFetchGitRemote.mockReset();
    mockPullGitBranchFfOnly.mockReset();
    mockPushGitBranch.mockReset();
    mockGetBranchSyncStatus.mockReset();
    mockGetCurrentGitBranch.mockReset();
    mockWriteGitSyncLog.mockReset();
  });

  it("POST fetch returns structured project and branch context", async () => {
    mockDbState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockFetchGitRemote.mockResolvedValue({
      branches: [],
      tags: [],
      updated: [],
      deleted: [],
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/fetch/route"
    );
    const res = await POST(
      mockRequest({ remote: "origin", branch: "feature/one" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.action).toBe("fetch");
    expect(json.data.projectId).toBe("proj-1");
    expect(json.data.remote).toBe("origin");
    expect(json.data.branch).toBe("feature/one");
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "fetch",
        status: "success",
        branch: "feature/one",
      })
    );
  });

  it("POST pull returns 409 and guidance when ff-only pull is not possible", async () => {
    mockDbState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockPullGitBranchFfOnly.mockRejectedValue(
      new MockFastForwardOnlyPullError(
        "Fast-forward pull is not possible. Rebase or merge your branch before pulling."
      )
    );

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/pull/route"
    );
    const res = await POST(mockRequest({ branch: "feature/one" }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toContain("Fast-forward pull is not possible");
    expect(json.data).toEqual(
      expect.objectContaining({
        action: "pull",
        projectId: "proj-1",
        branch: "feature/one",
      })
    );
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "pull",
        status: "failed",
        branch: "feature/one",
      })
    );
  });

  it("POST push returns structured project and branch context", async () => {
    mockDbState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockPushGitBranch.mockResolvedValue({
      pushed: [{ to: "origin/feature/one" }],
      created: [],
      deleted: [],
      failed: false,
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/push/route"
    );
    const res = await POST(mockRequest({ branch: "feature/one" }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual(
      expect.objectContaining({
        action: "push",
        projectId: "proj-1",
        branch: "feature/one",
        remote: "origin",
      })
    );
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "push",
        status: "success",
        branch: "feature/one",
      })
    );
  });

  it("GET status returns ahead/behind for requested branch", async () => {
    mockDbState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockGetBranchSyncStatus.mockResolvedValue({
      branch: "feature/one",
      remote: "origin",
      remoteBranch: "origin/feature/one",
      ahead: 2,
      behind: 1,
      hasRemoteBranch: true,
    });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/git/status/route"
    );
    const request = {
      nextUrl: new URL("http://localhost/api/projects/proj-1/git/status?branch=feature/one"),
    } as unknown as import("next/server").NextRequest;

    const res = await GET(request, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.projectId).toBe("proj-1");
    expect(json.data.branch).toBe("feature/one");
    expect(json.data.ahead).toBe(2);
    expect(json.data.behind).toBe(1);
  });
});
