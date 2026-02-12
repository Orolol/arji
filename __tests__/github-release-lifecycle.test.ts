import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Hoisted mock state                                                  */
/* ------------------------------------------------------------------ */
const mockDbState = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
  updateCalls: [] as Array<{ table: unknown; values: unknown }>,
  allQueue: [] as unknown[],
  getQueue: [] as unknown[],
}));

const mockSchema = vi.hoisted(() => ({
  releases: { __name: "releases" },
  projects: { __name: "projects" },
  epics: { __name: "epics" },
  settings: { __name: "settings" },
  gitSyncLog: { __name: "git_sync_log" },
}));

/* ------------------------------------------------------------------ */
/* Mock external modules                                               */
/* ------------------------------------------------------------------ */
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __eq: args })),
  desc: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
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
    update: vi.fn(),
    set: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.insert.mockImplementation((table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      mockDbState.insertCalls.push({ table, payload });
      return { run: vi.fn() };
    }),
  }));
  chain.update.mockImplementation((table: unknown) => ({
    set: vi.fn((values: unknown) => {
      mockDbState.updateCalls.push({ table, values });
      return chain;
    }),
  }));

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => mockSchema);
vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "test-release-id"),
}));

// Mock simple-git
vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    addTag: vi.fn(),
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

// Mock GitHub modules
const mockPushTag = vi.fn();
vi.mock("@/lib/git/remote", () => ({
  pushTag: mockPushTag,
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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function createMockRequest(body: unknown): Request {
  return new Request("http://localhost/api/projects/proj_1/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */
describe("Release creation with pushToGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.insertCalls = [];
    mockDbState.updateCalls = [];
    mockDbState.allQueue = [];
    mockDbState.getQueue = [];
  });

  it("creates a local-only release when pushToGitHub is false", async () => {
    // Setup: project without GitHub, selected epics, release result
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: null },
      { id: "test-release-id", version: "1.0.0" },
    ];
    mockDbState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc" }],
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

    const res = await POST(req as any, {
      params: Promise.resolve({ projectId: "proj_1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();

    // GitHub functions should NOT have been called
    expect(mockPushTag).not.toHaveBeenCalled();
    expect(mockCreateDraftRelease).not.toHaveBeenCalled();
    expect(mockLogSyncOperation).not.toHaveBeenCalled();
  });

  it("pushes tag and creates draft release when pushToGitHub is true", async () => {
    // Setup: project with GitHub configured
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: "owner/repo" },
      { id: "test-release-id", version: "1.0.0", githubReleaseId: 99, githubReleaseUrl: "https://github.com/owner/repo/releases/99" },
    ];
    mockDbState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc" }],
    ];

    mockPushTag.mockResolvedValue(undefined);
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

    const res = await POST(req as any, {
      params: Promise.resolve({ projectId: "proj_1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();

    // pushTag should have been called
    expect(mockPushTag).toHaveBeenCalledWith("/tmp/repo", "v1.0.0");

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
        operation: "tag",
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

  it("creates local release even when GitHub push fails", async () => {
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: "owner/repo" },
      { id: "test-release-id", version: "2.0.0" },
    ];
    mockDbState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc" }],
    ];

    mockPushTag.mockRejectedValue(new Error("Network error"));
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

    const res = await POST(req as any, {
      params: Promise.resolve({ projectId: "proj_1" }),
    });
    const json = await res.json();

    // Release still created successfully
    expect(res.status).toBe(201);
    expect(json.data).toBeDefined();

    // But errors reported
    expect(json.githubErrors).toBeDefined();
    expect(json.githubErrors).toHaveLength(2);
    expect(json.githubErrors[0]).toContain("Tag push failed");
    expect(json.githubErrors[1]).toContain("GitHub release creation failed");

    // Failures logged
    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "tag",
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
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", gitRepoPath: "/tmp/repo", githubOwnerRepo: null },
      { id: "test-release-id", version: "1.0.0" },
    ];
    mockDbState.allQueue = [
      [{ id: "ep_1", title: "Epic 1", description: "desc" }],
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

    const res = await POST(req as any, {
      params: Promise.resolve({ projectId: "proj_1" }),
    });

    expect(res.status).toBe(201);
    expect(mockPushTag).not.toHaveBeenCalled();
    expect(mockCreateDraftRelease).not.toHaveBeenCalled();
  });

  it("returns 400 when version is missing", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      epicIds: ["ep_1"],
    });

    const res = await POST(req as any, {
      params: Promise.resolve({ projectId: "proj_1" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("version");
  });

  it("returns 400 when epicIds is empty", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/route"
    );

    const req = createMockRequest({
      version: "1.0.0",
      epicIds: [],
    });

    const res = await POST(req as any, {
      params: Promise.resolve({ projectId: "proj_1" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("epicIds");
  });
});
