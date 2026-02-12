import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Hoisted mock state                                                  */
/* ------------------------------------------------------------------ */
const mockDbState = vi.hoisted(() => ({
  insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
  updateCalls: [] as Array<{ table: unknown; values: unknown }>,
  getQueue: [] as unknown[],
}));

const mockSchema = vi.hoisted(() => ({
  releases: { __name: "releases" },
  projects: { __name: "projects" },
  gitSyncLog: { __name: "git_sync_log" },
}));

/* ------------------------------------------------------------------ */
/* Mock external modules                                               */
/* ------------------------------------------------------------------ */
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __eq: args })),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    get: vi.fn(),
    run: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
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
  createId: vi.fn(() => "log-id"),
}));

const mockPublishRelease = vi.fn();
vi.mock("@/lib/github/releases", () => ({
  publishRelease: mockPublishRelease,
}));

const mockLogSyncOperation = vi.fn();
vi.mock("@/lib/github/sync-log", () => ({
  logSyncOperation: mockLogSyncOperation,
}));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function createMockRequest(): Request {
  return new Request(
    "http://localhost/api/projects/proj_1/releases/rel_1/publish",
    { method: "POST" }
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */
describe("Publish release endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.insertCalls = [];
    mockDbState.updateCalls = [];
    mockDbState.getQueue = [];
  });

  it("publishes a draft release successfully", async () => {
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", githubOwnerRepo: "owner/repo" },
      {
        id: "rel_1",
        projectId: "proj_1",
        githubReleaseId: 42,
        gitTag: "v1.0.0",
      },
    ];

    mockPublishRelease.mockResolvedValue({
      url: "https://github.com/owner/repo/releases/tag/v1.0.0",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/[releaseId]/publish/route"
    );

    const res = await POST(createMockRequest() as any, {
      params: Promise.resolve({ projectId: "proj_1", releaseId: "rel_1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.published).toBe(true);
    expect(json.data.url).toContain("github.com");

    expect(mockPublishRelease).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      releaseId: 42,
    });

    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        operation: "release",
        status: "success",
      })
    );

    // Verify the detail includes "publish"
    const logCall = mockLogSyncOperation.mock.calls[0][0];
    expect(logCall.detail).toContain("publish");
  });

  it("returns 404 when project not found", async () => {
    mockDbState.getQueue = [null];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/[releaseId]/publish/route"
    );

    const res = await POST(createMockRequest() as any, {
      params: Promise.resolve({ projectId: "proj_1", releaseId: "rel_1" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Project not found");
  });

  it("returns 400 when project has no GitHub config", async () => {
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", githubOwnerRepo: null },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/[releaseId]/publish/route"
    );

    const res = await POST(createMockRequest() as any, {
      params: Promise.resolve({ projectId: "proj_1", releaseId: "rel_1" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("GitHub integration not configured");
  });

  it("returns 404 when release not found", async () => {
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", githubOwnerRepo: "owner/repo" },
      null, // release not found
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/[releaseId]/publish/route"
    );

    const res = await POST(createMockRequest() as any, {
      params: Promise.resolve({ projectId: "proj_1", releaseId: "rel_1" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Release not found");
  });

  it("returns 400 when release has no GitHub draft", async () => {
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", githubOwnerRepo: "owner/repo" },
      { id: "rel_1", projectId: "proj_1", githubReleaseId: null },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/[releaseId]/publish/route"
    );

    const res = await POST(createMockRequest() as any, {
      params: Promise.resolve({ projectId: "proj_1", releaseId: "rel_1" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("no associated GitHub draft");
  });

  it("returns 500 and logs failure when publish fails", async () => {
    mockDbState.getQueue = [
      { id: "proj_1", name: "Test Project", githubOwnerRepo: "owner/repo" },
      {
        id: "rel_1",
        projectId: "proj_1",
        githubReleaseId: 42,
        gitTag: "v1.0.0",
      },
    ];

    mockPublishRelease.mockRejectedValue(new Error("API rate limited"));

    const { POST } = await import(
      "@/app/api/projects/[projectId]/releases/[releaseId]/publish/route"
    );

    const res = await POST(createMockRequest() as any, {
      params: Promise.resolve({ projectId: "proj_1", releaseId: "rel_1" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("API rate limited");

    expect(mockLogSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "release",
        status: "failure",
      })
    );

    const logCall = mockLogSyncOperation.mock.calls[0][0];
    expect(logCall.detail).toContain("publish");
    expect(logCall.detail).toContain("API rate limited");
  });
});
