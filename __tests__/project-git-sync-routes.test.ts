import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockAssertRemoteConfigured = vi.hoisted(() => vi.fn());
const mockGetRemoteAvailability = vi.hoisted(() => vi.fn());
const mockPullGitBranchWithConflictSupport = vi.hoisted(() => vi.fn());
const mockGetConflictFileDiffs = vi.hoisted(() => vi.fn());
const mockPushGitBranch = vi.hoisted(() => vi.fn());
const mockValidatePushPreconditions = vi.hoisted(() => vi.fn());
const mockGetBranchSyncStatus = vi.hoisted(() => vi.fn());
const mockGetCurrentGitBranch = vi.hoisted(() => vi.fn());
const mockFetchGitRemote = vi.hoisted(() => vi.fn());
const mockWriteGitSyncLog = vi.hoisted(() => vi.fn());
/** Mirrors lib/git/remote's precondition error so the routes' `instanceof`
 *  branch is reachable through the module mock. */
const MockGitRemoteNotConfiguredError = vi.hoisted(
  () =>
    class GitRemoteNotConfiguredError extends Error {
      readonly code = "remote_not_configured";
      readonly remote: string;
      readonly configuredRemotes: string[];
      constructor(remote: string, configuredRemotes: string[]) {
        super(`No git remote named '${remote}' is configured for this repository.`);
        this.name = "GitRemoteNotConfiguredError";
        this.remote = remote;
        this.configuredRemotes = configuredRemotes;
      }
    }
);
const MockPushValidationError = vi.hoisted(
  () =>
    class PushValidationError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = "PushValidationError";
        this.code = code;
      }
    }
);

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/git/remote", () => ({
  assertRemoteConfigured: mockAssertRemoteConfigured,
  getRemoteAvailability: mockGetRemoteAvailability,
  pullGitBranchWithConflictSupport: mockPullGitBranchWithConflictSupport,
  getConflictFileDiffs: mockGetConflictFileDiffs,
  pushGitBranch: mockPushGitBranch,
  validatePushPreconditions: mockValidatePushPreconditions,
  getBranchSyncStatus: mockGetBranchSyncStatus,
  getCurrentGitBranch: mockGetCurrentGitBranch,
  fetchGitRemote: mockFetchGitRemote,
  PushValidationError: MockPushValidationError,
  GitRemoteNotConfiguredError: MockGitRemoteNotConfiguredError,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    model: "claude-opus-4-6",
    namedAgentId: null,
    name: null,
  })),
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "session-1"),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({ status: "completed", result: { success: true } })),
  },
}));

vi.mock("@/lib/agent-sessions/validate-resume", () => ({
  isResumableProvider: vi.fn(() => true),
}));

vi.mock("@/lib/github/sync-log", () => ({
  writeGitSyncLog: mockWriteGitSyncLog,
}));

describe("Project git sync routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockAssertRemoteConfigured.mockReset();
    mockAssertRemoteConfigured.mockResolvedValue(undefined);
    mockGetRemoteAvailability.mockReset();
    mockGetRemoteAvailability.mockResolvedValue({
      remote: "origin",
      configured: true,
      configuredRemotes: ["origin"],
      fetchConfigured: true,
      pushConfigured: true,
      fetchRemotes: ["origin"],
      pushRemotes: ["origin"],
    });
    mockPullGitBranchWithConflictSupport.mockReset();
    mockGetConflictFileDiffs.mockReset();
    mockPushGitBranch.mockReset();
    mockValidatePushPreconditions.mockReset();
    mockGetBranchSyncStatus.mockReset();
    mockGetCurrentGitBranch.mockReset();
    mockWriteGitSyncLog.mockReset();
    mockFetchGitRemote.mockReset();
    mockFetchGitRemote.mockResolvedValue(undefined);
  });

  it("POST pull returns 409 with file-level diffs when conflicts are not auto-resolved", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockPullGitBranchWithConflictSupport.mockResolvedValue({
      conflicted: true,
      summary: "merge failed",
      conflictedFiles: ["src/a.ts"],
    });
    mockGetConflictFileDiffs.mockResolvedValue([
      { filePath: "src/a.ts", diff: "@@ -1 +1 @@" },
    ]);

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/pull/route"
    );
    const res = await POST(
      mockJsonRequest({ branch: "feature/one", autoResolveConflicts: false }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toContain("merge conflicts");
    expect(json.code).toBe("merge_conflicts");
    expect(json.conflicted).toBe(true);
    expect(json.conflictedFiles).toEqual(["src/a.ts"]);
    expect(json.conflictDiffs).toHaveLength(1);
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "pull",
        status: "failed",
        branch: "feature/one",
      })
    );
  });

  it("POST pull starts conflict resolution agent when auto resolve is enabled", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockPullGitBranchWithConflictSupport.mockResolvedValue({
      conflicted: true,
      summary: "merge failed",
      conflictedFiles: ["src/a.ts", "src/b.ts"],
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/pull/route"
    );
    const res = await POST(mockJsonRequest({ branch: "feature/one" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json.data.autoResolve).toBe(true);
    expect(json.data.sessionId).toBe("session-1");
    expect(json.data.conflictedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("POST push returns structured project and branch context", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockValidatePushPreconditions.mockResolvedValue(undefined);
    mockPushGitBranch.mockResolvedValue({
      pushed: [{ to: "origin/feature/one" }],
      created: [],
      deleted: [],
      failed: false,
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/push/route"
    );
    const res = await POST(mockJsonRequest({ branch: "feature/one" }), mockRouteContext({ projectId: "proj-1" }));
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

  it("POST push returns 409 when validation fails", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockValidatePushPreconditions.mockRejectedValue(
      new MockPushValidationError(
        "working_tree_dirty",
        "Push rejected: working tree has uncommitted changes."
      )
    );

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/push/route"
    );
    const res = await POST(mockJsonRequest({ branch: "feature/one" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toContain("uncommitted changes");
    expect(json.code).toBe("working_tree_dirty");
  });

  it("GET status returns ahead/behind for requested branch", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
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
    const request = mockNextRequest({
      url: "http://localhost/api/projects/proj-1/git/status?branch=feature/one",
    });

    const res = await GET(request, mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.projectId).toBe("proj-1");
    expect(json.data.branch).toBe("feature/one");
    expect(json.data.ahead).toBe(2);
    expect(json.data.behind).toBe(1);
  });
});

/**
 * The implicit-fetch TTL lives in a module-level Map inside the status route,
 * and the route module is cached for the whole file — so every test here uses
 * its OWN repo path to get a clean TTL slot instead of resetting modules.
 */
describe("GET git status implicit fetch (TTL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockGetRemoteAvailability.mockReset();
    mockGetRemoteAvailability.mockResolvedValue({
      remote: "origin",
      configured: true,
      configuredRemotes: ["origin"],
      fetchConfigured: true,
      pushConfigured: true,
      fetchRemotes: ["origin"],
      pushRemotes: ["origin"],
    });
    mockGetBranchSyncStatus.mockReset();
    mockGetCurrentGitBranch.mockReset();
    mockFetchGitRemote.mockReset();
    mockFetchGitRemote.mockResolvedValue(undefined);
    mockGetBranchSyncStatus.mockResolvedValue({
      branch: "feature/one",
      remote: "origin",
      remoteBranch: "origin/feature/one",
      ahead: 2,
      behind: 1,
      hasRemoteBranch: true,
    });
  });

  async function callStatus(repoPath: string) {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: repoPath }];
    const { GET } = await import(
      "@/app/api/projects/[projectId]/git/status/route"
    );
    const res = await GET(
      mockNextRequest({
        url: "http://localhost/api/projects/proj-1/git/status?branch=feature/one",
      }),
      mockRouteContext({ projectId: "proj-1" })
    );
    return { res, json: await res.json() };
  }

  it("fetches the remote when no fetch is recorded for the repo", async () => {
    const before = Date.now();
    const { res, json } = await callStatus("/repo-ttl-cold");

    expect(res.status).toBe(200);
    expect(mockFetchGitRemote).toHaveBeenCalledTimes(1);
    expect(mockFetchGitRemote).toHaveBeenCalledWith("/repo-ttl-cold", "origin");
    expect(json.data.lastFetchError).toBeNull();
    expect(json.data.lastFetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("skips the fetch on a second call inside the TTL window", async () => {
    const first = await callStatus("/repo-ttl-warm");
    expect(mockFetchGitRemote).toHaveBeenCalledTimes(1);

    const second = await callStatus("/repo-ttl-warm");

    expect(mockFetchGitRemote).toHaveBeenCalledTimes(1);
    expect(second.res.status).toBe(200);
    expect(second.json.data.lastFetchedAt).toBe(first.json.data.lastFetchedAt);
    expect(second.json.data.lastFetchError).toBeNull();
  });

  it("fetches again once the TTL has expired", async () => {
    const t0 = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const first = await callStatus("/repo-ttl-expiry");
      expect(mockFetchGitRemote).toHaveBeenCalledTimes(1);
      expect(first.json.data.lastFetchedAt).toBe(t0);

      // 4 minutes later: still inside the 5-minute TTL.
      nowSpy.mockReturnValue(t0 + 4 * 60 * 1000);
      await callStatus("/repo-ttl-expiry");
      expect(mockFetchGitRemote).toHaveBeenCalledTimes(1);

      // 6 minutes later: stale, fetch again.
      const t1 = t0 + 6 * 60 * 1000;
      nowSpy.mockReturnValue(t1);
      const third = await callStatus("/repo-ttl-expiry");

      expect(mockFetchGitRemote).toHaveBeenCalledTimes(2);
      expect(third.json.data.lastFetchedAt).toBe(t1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps serving status when the fetch fails, reporting lastFetchError", async () => {
    mockFetchGitRemote.mockRejectedValue(
      new Error("could not read Username for 'https://github.com'")
    );

    const { res, json } = await callStatus("/repo-ttl-offline");

    expect(res.status).toBe(200);
    expect(json.data.ahead).toBe(2);
    expect(json.data.behind).toBe(1);
    expect(json.data.lastFetchedAt).toBeNull();
    expect(json.data.lastFetchError).toContain("could not read Username");
  });

  it("retries on the next call after a failed fetch (failure is not cached)", async () => {
    mockFetchGitRemote.mockRejectedValueOnce(new Error("network unreachable"));

    const first = await callStatus("/repo-ttl-recover");
    expect(first.json.data.lastFetchError).toContain("network unreachable");

    const second = await callStatus("/repo-ttl-recover");

    expect(mockFetchGitRemote).toHaveBeenCalledTimes(2);
    expect(second.json.data.lastFetchError).toBeNull();
    expect(typeof second.json.data.lastFetchedAt).toBe("number");
  });
});
