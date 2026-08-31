import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockDetectGitHubRemote = vi.hoisted(() => vi.fn());
const mockWriteGitSyncLog = vi.hoisted(() => vi.fn());

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

// The real module is spread back in so `GitRepositoryUnavailableError` keeps
// its identity: the route branches on `instanceof`, which a bare factory
// would silently break.
vi.mock("@/lib/git/remote", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/git/remote")>("@/lib/git/remote");
  return { ...actual, detectGitHubRemote: mockDetectGitHubRemote };
});

vi.mock("@/lib/github/sync-log", () => ({
  writeGitSyncLog: mockWriteGitSyncLog,
}));

describe("GET /api/projects/[projectId]/github/detect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockDetectGitHubRemote.mockReset();
    mockWriteGitSyncLog.mockReset();
  });

  it("returns 404 when project does not exist", async () => {
    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(mockNextRequest({ url: "http://localhost/" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("Project not found");
  });

  it("returns 400 when project has no gitRepoPath", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: null }];
    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(mockNextRequest({ url: "http://localhost/" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Project has no git repository path configured");
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "detect",
        status: "failed",
      })
    );
  });

  it("returns detected=false when no GitHub remote is found", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repos/test" }];
    mockDetectGitHubRemote.mockResolvedValue(null);

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(mockNextRequest({ url: "http://localhost/" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ detected: false });
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "detect",
        status: "success",
      })
    );
  });

  it("returns 400 with the code when gitRepoPath is not a repository", async () => {
    const { GitRepositoryUnavailableError } = await import("@/lib/git/remote");
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repos/plain" }];
    mockDetectGitHubRemote.mockRejectedValue(
      new GitRepositoryUnavailableError("GIT_REPO_NOT_A_REPOSITORY", "/repos/plain")
    );

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(mockNextRequest({ url: "http://localhost/" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("GIT_REPO_NOT_A_REPOSITORY");
    expect(json.error).toContain("/repos/plain");
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "detect",
        status: "failed",
        detail: expect.objectContaining({ code: "GIT_REPO_NOT_A_REPOSITORY" }),
      })
    );
  });

  it("still returns 500 for an unexpected git failure", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repos/test" }];
    mockDetectGitHubRemote.mockRejectedValue(new Error("disk exploded"));

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(mockNextRequest({ url: "http://localhost/" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe("disk exploded");
  });

  it("returns owner/repo when a GitHub remote is detected", async () => {
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/repos/test" }];
    mockDetectGitHubRemote.mockResolvedValue({
      owner: "octocat",
      repo: "hello-world",
      ownerRepo: "octocat/hello-world",
      remoteName: "origin",
      remoteUrl: "git@github.com:octocat/hello-world.git",
    });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(mockNextRequest({ url: "http://localhost/" }), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.owner).toBe("octocat");
    expect(json.data.repo).toBe("hello-world");
    expect(json.data.ownerRepo).toBe("octocat/hello-world");
    expect(mockDetectGitHubRemote).toHaveBeenCalledWith("/repos/test");
    expect(mockWriteGitSyncLog).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        operation: "detect",
        status: "success",
      })
    );
  });
});
