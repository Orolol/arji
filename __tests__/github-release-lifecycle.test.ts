import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

/* ------------------------------------------------------------------ */
/* Hoisted mock state                                                  */
/* ------------------------------------------------------------------ */
const mockGitAddTag = vi.hoisted(() => vi.fn());
const mockGitTag = vi.hoisted(() => vi.fn());
const mockGitPush = vi.hoisted(() => vi.fn());
const mockCreateReleaseBranchAndCommitChangelog = vi.hoisted(() => vi.fn());

/* ------------------------------------------------------------------ */
/* Mock external modules                                               */
/* ------------------------------------------------------------------ */
// Real drizzle-orm + real @/lib/db/schema: both are side-effect-free pure
// builders, and the chain mock ignores their output. No fake column maps.
// `transaction(fn)` runs fn against the same chain, which shares the queues.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "test-release-id"),
}));

// Mock simple-git
vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    addTag: mockGitAddTag,
    tag: mockGitTag,
    push: mockGitPush,
  })),
}));

// Mock Claude spawn (used for changelog generation)
vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: vi.fn(() => ({
    promise: Promise.resolve({ success: false }),
    sessionId: "mock-session",
  })),
}));

vi.mock("@/lib/claude/json-parser", () => ({
  parseClaudeOutput: vi.fn(() => ({ content: "" })),
}));

vi.mock("@/lib/git/release", () => ({
  createReleaseBranchAndCommitChangelog: mockCreateReleaseBranchAndCommitChangelog,
}));

const mockCreateDraftRelease = vi.fn();
vi.mock("@/lib/github/releases", () => ({
  createDraftRelease: mockCreateDraftRelease,
  publishRelease: vi.fn(),
}));

const mockLogSyncOperation = vi.fn();
vi.mock("@/lib/github/sync-log", () => ({
  logSyncOperation: mockLogSyncOperation,
}));

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
  },
}));

// Mock new modules added for release flow
vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => null),
  },
}));

vi.mock("@/lib/agent-sessions/validate-resume", () => ({
  isResumableProvider: vi.fn(() => false),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    name: "Claude Code",
    namedAgentId: null,
    model: null,
  })),
}));

const mockApplyTransition = vi.fn((..._args: unknown[]) => ({ valid: true }));
vi.mock("@/lib/workflow/transition-service", () => ({
  applyTransition: (...args: unknown[]) => mockApplyTransition(...args),
}));

vi.mock("@/lib/events/emit", () => ({
  emitReleaseCreated: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function createMockRequest(body: unknown) {
  return mockNextRequest({
    url: "http://localhost/api/projects/proj_1/releases",
    method: "POST",
    body,
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */
describe("Release creation with pushToGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockGitAddTag.mockReset();
    mockGitTag.mockReset();
    mockGitPush.mockReset();
    mockCreateReleaseBranchAndCommitChangelog.mockReset();
    mockCreateReleaseBranchAndCommitChangelog.mockResolvedValue({
      releaseBranch: "release/v1.0.0",
      changelogCommitted: true,
      commitHash: "abc123",
    });
  });

  it("creates a local-only release when pushToGitHub is false", async () => {
    // Setup: project without GitHub, selected epics, release result
    dbMockState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: null },
      { id: "test-release-id", version: "1.0.0" },
    ];
    dbMockState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc", status: "done" }],
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "1.0.0",
      epicIds: ["ep_1"],
      generateChangelog: false,
      pushToGitHub: false,
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();

    // GitHub functions should NOT have been called
    expect(mockCreateDraftRelease).not.toHaveBeenCalled();
    expect(mockLogSyncOperation).not.toHaveBeenCalled();
    expect(mockCreateReleaseBranchAndCommitChangelog).toHaveBeenCalled();
  });

  it("pushes tag and creates draft release when pushToGitHub is true", async () => {
    // Setup: project with GitHub configured
    dbMockState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: "owner/repo" },
      { id: "test-release-id", version: "1.0.0", githubReleaseId: 99, githubReleaseUrl: "https://github.com/owner/repo/releases/99" },
    ];
    dbMockState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc", status: "done" }],
    ];

    mockCreateDraftRelease.mockResolvedValue({
      id: 99,
      url: "https://github.com/owner/repo/releases/99",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "1.0.0",
      title: "First Release",
      epicIds: ["ep_1"],
      generateChangelog: false,
      pushToGitHub: true,
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();

    expect(mockCreateReleaseBranchAndCommitChangelog).toHaveBeenCalledWith(
      "/tmp/repo",
      "1.0.0",
      expect.any(String),
      { defaultBranch: undefined }
    );

    // Verify tag was created against the release commit hash, not HEAD
    expect(mockGitTag).toHaveBeenCalledWith(["v1.0.0", "abc123"]);

    // createDraftRelease should have been called
    expect(mockCreateDraftRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        tag: "v1.0.0",
        title: "v1.0.0 — First Release",
      })
    );

    // Sync log should have entries for tag push and release create
    expect(mockLogSyncOperation).toHaveBeenCalledTimes(2);
    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        operation: "tag_push",
        status: "success",
      })
    );
    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        operation: "release",
        status: "success",
      })
    );
  });

  it("hands the stored default branch to the release helper", async () => {
    // A develop-default clone must not be branched from main: the release
    // helper receives the project's stored default_branch and bases the
    // release branch on it when it exists locally.
    dbMockState.getQueue = [
      {
        id: "proj_1",
        name: "Test Project",
        gitRepoPath: "/tmp/repo",
        githubOwnerRepo: "owner/repo",
        defaultBranch: "develop",
      },
      { id: "test-release-id", version: "1.0.0" },
    ];
    dbMockState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc", status: "done" }],
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "1.0.0",
      epicIds: ["ep_1"],
      generateChangelog: false,
      pushToGitHub: false,
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();
    expect(mockCreateReleaseBranchAndCommitChangelog).toHaveBeenCalledWith(
      "/tmp/repo",
      "1.0.0",
      expect.any(String),
      { defaultBranch: "develop" }
    );
  });

  it("creates local release even when GitHub push fails", async () => {
    dbMockState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: "owner/repo" },
      { id: "test-release-id", version: "2.0.0" },
    ];
    dbMockState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc", status: "done" }],
    ];

    mockGitPush.mockRejectedValue(new Error("Network error"));
    mockCreateDraftRelease.mockRejectedValue(new Error("API error"));

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "2.0.0",
      epicIds: ["ep_1"],
      generateChangelog: false,
      pushToGitHub: true,
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));
    const json = await res.json();

    // Release still created successfully
    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();

    // But errors reported (inside the data envelope)
    expect(json.data.githubErrors).toBeDefined();
    expect(json.data.githubErrors).toHaveLength(2);
    expect(json.data.githubErrors[0]).toContain("Tag push failed");
    expect(json.data.githubErrors[1]).toContain("GitHub release creation failed");

    // Failures logged
    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "tag_push",
        status: "failure",
      })
    );
    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "release",
        status: "failure",
      })
    );
  });

  it("skips GitHub operations when project has no githubOwnerRepo", async () => {
    dbMockState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: null },
      { id: "test-release-id", version: "1.0.0" },
    ];
    dbMockState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc", status: "done" }],
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "1.0.0",
      epicIds: ["ep_1"],
      generateChangelog: false,
      pushToGitHub: true, // true but no github config
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));

    expect(res.status).toBe(201);
    expect(mockCreateDraftRelease).not.toHaveBeenCalled();
  });

  it("returns 400 when version is missing", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      epicIds: ["ep_1"],
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
    expect(json.details.version[0]).toContain("version");
  });

  it("returns 400 when epicIds is empty", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "1.0.0",
      epicIds: [],
    });

    const res = await POST(req, mockRouteContext({ projectId: "proj_1" }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
    expect(json.details.epicIds[0]).toContain("epicIds");
  });
});
