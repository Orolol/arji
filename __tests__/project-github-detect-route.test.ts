import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  getQueue: [] as unknown[],
}));

const mockDetectGitHubRemote = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDb.getQueue.shift() ?? null),
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
  detectGitHubRemote: mockDetectGitHubRemote,
}));

describe("GET /api/projects/[projectId]/github/detect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getQueue = [];
    mockDetectGitHubRemote.mockReset();
  });

  it("returns 404 when project does not exist", async () => {
    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("Project not found");
  });

  it("returns 400 when project has no gitRepoPath", async () => {
    mockDb.getQueue = [{ id: "proj-1", gitRepoPath: null }];
    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Project has no git repository path configured.");
  });

  it("returns detected=false when no GitHub remote is found", async () => {
    mockDb.getQueue = [{ id: "proj-1", gitRepoPath: "/repos/test" }];
    mockDetectGitHubRemote.mockResolvedValue(null);

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/detect/route"
    );

    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ detected: false });
  });

  it("returns owner/repo when a GitHub remote is detected", async () => {
    mockDb.getQueue = [{ id: "proj-1", gitRepoPath: "/repos/test" }];
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

    const res = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.owner).toBe("octocat");
    expect(json.data.repo).toBe("hello-world");
    expect(json.data.ownerRepo).toBe("octocat/hello-world");
    expect(mockDetectGitHubRemote).toHaveBeenCalledWith("/repos/test");
  });
});
