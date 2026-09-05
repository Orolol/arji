import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";
// Resolves through the mock above, which spreads the real module — so this is
// the very class the routes compare against.
import { GitRemoteNotConfiguredError } from "@/lib/git/remote";

/**
 * A project whose repository has no usable remote is an ordinary, recoverable
 * state — the same one `git/detect-remote` already answers 4xx for. These
 * routes used to let it fall through to `errorResponse`, so the UI saw a 500
 * carrying raw git prose ("fatal: 'origin' does not appear to be a git
 * repository") and had nothing to branch on.
 */
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
/**
 * Answers the repository-shape guard the routes now run before any git read.
 * The fixture paths here are synthetic (`/repo`), so the real guard would
 * refuse every one of them for a reason this file is not about.
 */
const mockAssertGitRepository = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

// Only the git-touching FUNCTIONS are replaced. The real module is spread
// back in so every exported error class keeps its identity: the routes branch
// on `instanceof`, which a bare factory silently breaks.
vi.mock("@/lib/git/remote", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/git/remote")>("@/lib/git/remote");
  return {
    ...actual,
    assertGitRepository: mockAssertGitRepository,
    assertRemoteConfigured: mockAssertRemoteConfigured,
    getRemoteAvailability: mockGetRemoteAvailability,
    pullGitBranchWithConflictSupport: mockPullGitBranchWithConflictSupport,
    getConflictFileDiffs: mockGetConflictFileDiffs,
    pushGitBranch: mockPushGitBranch,
    validatePushPreconditions: mockValidatePushPreconditions,
    getBranchSyncStatus: mockGetBranchSyncStatus,
    getCurrentGitBranch: mockGetCurrentGitBranch,
    fetchGitRemote: mockFetchGitRemote,
  };
});

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

vi.mock("@/lib/github/sync-log", () => ({
  writeGitSyncLog: mockWriteGitSyncLog,
}));

/** Makes the shared remote guard reject exactly as the real one would. */
function noRemoteConfigured(
  remote = "origin",
  configuredRemotes: string[] = [],
  operation: "fetch" | "push" = "fetch"
) {
  mockAssertRemoteConfigured.mockRejectedValue(
    new GitRemoteNotConfiguredError(remote, configuredRemotes, operation)
  );
  mockGetRemoteAvailability.mockResolvedValue({
    remote,
    configured: false,
    configuredRemotes,
    fetchConfigured: false,
    pushConfigured: false,
    fetchRemotes: configuredRemotes,
    pushRemotes: configuredRemotes,
  });
}

describe("git push/pull with no usable remote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockAssertGitRepository.mockReset();
    mockAssertGitRepository.mockResolvedValue(undefined);
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
    mockValidatePushPreconditions.mockResolvedValue(undefined);
    mockGetBranchSyncStatus.mockReset();
    mockGetCurrentGitBranch.mockReset();
    mockWriteGitSyncLog.mockReset();
    mockFetchGitRemote.mockReset();
    mockFetchGitRemote.mockResolvedValue(undefined);
  });

  it("POST push answers 409 with a structured payload instead of a 500", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    noRemoteConfigured("origin", ["upstream"], "push");

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/push/route"
    );
    const res = await POST(
      mockJsonRequest({ branch: "main" }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("remote_not_configured");
    expect(json.remote).toBe("origin");
    expect(json.configuredRemotes).toEqual(["upstream"]);
    expect(json.error).toContain("origin");
    // The precondition is decided before git is asked to transfer anything.
    expect(mockPushGitBranch).not.toHaveBeenCalled();
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "push",
        status: "failed",
        branch: "main",
        detail: expect.objectContaining({ code: "remote_not_configured" }),
      })
    );
  });

  it("POST pull answers 409 when origin is push-only instead of attempting transport", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    noRemoteConfigured("origin", [], "fetch");

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/pull/route"
    );
    const res = await POST(
      mockJsonRequest({ branch: "main" }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("remote_not_configured");
    expect(json.remote).toBe("origin");
    expect(mockAssertRemoteConfigured).toHaveBeenCalledWith(
      "/repo",
      "origin",
      "fetch"
    );
    expect(json.configuredRemotes).toEqual([]);
    expect(mockPullGitBranchWithConflictSupport).not.toHaveBeenCalled();
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "pull",
        status: "failed",
        branch: "main",
        detail: expect.objectContaining({ code: "remote_not_configured" }),
      })
    );
  });

  it("honours a non-default remote name from the request body", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    noRemoteConfigured("fork", ["origin"], "push");

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/push/route"
    );
    const res = await POST(
      mockJsonRequest({ branch: "main", remote: "fork" }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(mockAssertRemoteConfigured).toHaveBeenCalledWith(
      "/repo",
      "fork",
      "push"
    );
    expect(res.status).toBe(409);
    expect(json.remote).toBe("fork");
    expect(json.configuredRemotes).toEqual(["origin"]);
  });

  /* A genuine transport failure must stay distinguishable from the
   * precondition: same route, different status and no recovery code. */

  it("keeps a push transport failure a 5xx with no precondition code", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockPushGitBranch.mockRejectedValue(
      new Error("fatal: could not read Username for 'https://github.com'")
    );

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/push/route"
    );
    const res = await POST(
      mockJsonRequest({ branch: "main" }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.code).toBeUndefined();
    expect(json.error).toContain("could not read Username");
  });

  it("keeps a pull transport failure a 5xx with no precondition code", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repo" }];
    mockPullGitBranchWithConflictSupport.mockRejectedValue(
      new Error("Could not read from remote repository.")
    );

    const { POST } = await import(
      "@/app/api/projects/[projectId]/git/pull/route"
    );
    const res = await POST(
      mockJsonRequest({ branch: "main" }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.code).toBeUndefined();
    expect(json.error).toContain("Could not read from remote repository.");
  });
});

/**
 * The Git Sync page has to be able to re-derive "no remote here" on every
 * mount, so the state read has to carry it — a 409 body held in component
 * state disappears on refresh.
 */
describe("GET git status remote configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockAssertGitRepository.mockReset();
    mockAssertGitRepository.mockResolvedValue(undefined);
    mockAssertRemoteConfigured.mockReset();
    mockAssertRemoteConfigured.mockResolvedValue(undefined);
    mockGetRemoteAvailability.mockReset();
    mockGetBranchSyncStatus.mockReset();
    mockGetCurrentGitBranch.mockReset();
    mockFetchGitRemote.mockReset();
    mockFetchGitRemote.mockResolvedValue(undefined);
    mockGetBranchSyncStatus.mockResolvedValue({
      branch: "main",
      remote: "origin",
      remoteBranch: "origin/main",
      ahead: 0,
      behind: 0,
      hasRemoteBranch: false,
    });
  });

  async function callStatus(repoPath: string) {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: repoPath }];
    const { GET } = await import(
      "@/app/api/projects/[projectId]/git/status/route"
    );
    const res = await GET(
      mockNextRequest({
        url: "http://localhost/api/projects/proj-1/git/status?branch=main",
      }),
      mockRouteContext({ projectId: "proj-1" })
    );
    return { res, json: await res.json() };
  }

  it("reports the missing remote and the repository's actual remotes", async () => {
    mockGetRemoteAvailability.mockResolvedValue({
      remote: "origin",
      configured: false,
      configuredRemotes: ["upstream"],
      fetchConfigured: false,
      pushConfigured: false,
      fetchRemotes: ["upstream"],
      pushRemotes: ["upstream"],
    });

    const { res, json } = await callStatus("/repo-no-remote");

    expect(res.status).toBe(200);
    expect(json.data.remoteConfigured).toBe(false);
    expect(json.data.remoteFetchConfigured).toBe(false);
    expect(json.data.remotePushConfigured).toBe(false);
    expect(json.data.configuredRemotes).toEqual(["upstream"]);
    // Fetching a remote that does not exist only yields a misleading
    // `lastFetchError`; the precondition is the honest answer.
    expect(mockFetchGitRemote).not.toHaveBeenCalled();
    expect(json.data.lastFetchError).toBeNull();
  });

  it("reports a configured remote and still runs the implicit fetch", async () => {
    mockGetRemoteAvailability.mockResolvedValue({
      remote: "origin",
      configured: true,
      configuredRemotes: ["origin"],
      fetchConfigured: true,
      pushConfigured: true,
      fetchRemotes: ["origin"],
      pushRemotes: ["origin"],
    });

    const { res, json } = await callStatus("/repo-with-remote");

    expect(res.status).toBe(200);
    expect(json.data.remoteConfigured).toBe(true);
    expect(json.data.remoteFetchConfigured).toBe(true);
    expect(json.data.remotePushConfigured).toBe(true);
    expect(json.data.configuredRemotes).toEqual(["origin"]);
    expect(mockFetchGitRemote).toHaveBeenCalledTimes(1);
  });

  it("reports a push-only remote per operation and does not try to fetch it", async () => {
    mockGetRemoteAvailability.mockResolvedValue({
      remote: "origin",
      configured: true,
      configuredRemotes: ["origin"],
      fetchConfigured: false,
      pushConfigured: true,
      fetchRemotes: [],
      pushRemotes: ["origin"],
    });

    const { res, json } = await callStatus("/repo-push-only");

    expect(res.status).toBe(200);
    expect(json.data.remoteFetchConfigured).toBe(false);
    expect(json.data.remotePushConfigured).toBe(true);
    expect(mockFetchGitRemote).not.toHaveBeenCalled();
  });

  it("leaves the state unknown rather than guessing when the remote list is unreadable", async () => {
    mockGetRemoteAvailability.mockRejectedValue(new Error("not a git repository"));

    const { res, json } = await callStatus("/repo-unreadable");

    expect(res.status).toBe(200);
    expect(json.data.remoteConfigured).toBeNull();
    expect(json.data.configuredRemotes).toBeNull();
  });
});
