import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";
import { parseWorktreeList } from "@/lib/git/worktrees";

const mockListWorktrees = vi.hoisted(() => vi.fn());
const mockPruneOrphanWorktrees = vi.hoisted(() => vi.fn());
/**
 * The fixture path here is synthetic (`/repos/arij`), so the real
 * `assertGitRepository` guard the route now runs first would refuse every case
 * in this file for a reason it is not about. The guard's own behaviour — and
 * the 400 the routes answer for a path that is not a repository — is pinned
 * against real directories in
 * `__tests__/worktrees-route-not-a-repository.test.ts`.
 */
const mockAssertGitRepository = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

// Only the guard FUNCTION is replaced. The real module is spread back in so
// `GitRepositoryUnavailableError` keeps its identity: the route branches on
// `instanceof`, which a bare factory silently breaks.
vi.mock("@/lib/git/remote", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/git/remote")>("@/lib/git/remote");
  return { ...actual, assertGitRepository: mockAssertGitRepository };
});

vi.mock("@/lib/git/worktrees", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git/worktrees")>(
    "@/lib/git/worktrees"
  );
  return {
    ...actual,
    listWorktrees: mockListWorktrees,
    pruneOrphanWorktrees: mockPruneOrphanWorktrees,
  };
});

const PORCELAIN = [
  "worktree /repos/arij",
  "HEAD aaa111",
  "branch refs/heads/main",
  "",
  "worktree /repos/.arij-worktrees/feature-epic-1-payments",
  "HEAD bbb222",
  "branch refs/heads/feature/epic-1-payments",
  "",
  "worktree /repos/.arij-worktrees/feature-epic-2-gone",
  "HEAD ccc333",
  "branch refs/heads/feature/epic-2-gone",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

describe("parseWorktreeList", () => {
  it("classifies the main working tree apart from the agent worktrees", () => {
    const trees = parseWorktreeList(PORCELAIN, "/repos/arij", () => true);

    expect(trees).toHaveLength(3);
    expect(trees[0]).toMatchObject({
      path: "/repos/arij",
      branch: "main",
      isMain: true,
      orphaned: false,
    });
    expect(trees[1]).toMatchObject({
      branch: "feature/epic-1-payments",
      isMain: false,
      orphaned: false,
    });
  });

  it("marks a worktree git annotated as prunable", () => {
    const trees = parseWorktreeList(PORCELAIN, "/repos/arij", () => true);
    expect(trees[2]).toMatchObject({
      branch: "feature/epic-2-gone",
      orphaned: true,
    });
  });

  it("marks a worktree whose directory disappeared, without git's annotation", () => {
    const trees = parseWorktreeList(
      PORCELAIN,
      "/repos/arij",
      (candidate) => !candidate.endsWith("feature-epic-1-payments")
    );

    expect(trees[1]).toMatchObject({ exists: false, orphaned: true });
    // The repository's own working tree is never advertised as cleanable.
    expect(trees[0].orphaned).toBe(false);
  });

  it("handles a detached worktree with no branch line", () => {
    const trees = parseWorktreeList(
      ["worktree /repos/arij", "HEAD aaa111", "detached", ""].join("\n"),
      "/repos/arij",
      () => true
    );

    expect(trees).toHaveLength(1);
    expect(trees[0].branch).toBeNull();
  });
});

describe("GET /api/projects/[projectId]/worktrees", () => {
  const routeParams = mockRouteContext({ projectId: "proj1" });

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockAssertGitRepository.mockResolvedValue(undefined);
  });

  it("404s for an unknown project", async () => {
    dbMockState.getQueue = [null];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await GET(mockNextRequest(), routeParams);

    expect(res.status).toBe(404);
    expect(mockListWorktrees).not.toHaveBeenCalled();
  });

  it("400s when the project has no git repository", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: null }];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await GET(mockNextRequest(), routeParams);

    expect(res.status).toBe(400);
  });

  it("excludes the main working tree and resolves epics and running sessions", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: "/repos/arij" }];
    dbMockState.allQueue = [
      // epics with a branch
      [
        {
          id: "epic-1",
          branchName: "feature/epic-1-payments",
          readableId: "E-arij-006",
          title: "Payments",
        },
      ],
      // running sessions
      [{ branchName: "feature/epic-1-payments", worktreePath: null }],
    ];
    mockListWorktrees.mockResolvedValue(
      parseWorktreeList(PORCELAIN, "/repos/arij", () => true)
    );

    const { GET } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await GET(mockNextRequest(), routeParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.count).toBe(2);
    expect(json.data.orphanCount).toBe(1);
    expect(json.data.worktrees.map((w: { branch: string }) => w.branch)).toEqual(
      ["feature/epic-1-payments", "feature/epic-2-gone"]
    );
    expect(json.data.worktrees[0]).toMatchObject({
      state: "running",
      epicId: "epic-1",
      epicReadableId: "E-arij-006",
    });
    expect(json.data.worktrees[1]).toMatchObject({
      state: "orphan",
      epicId: null,
    });
  });

  it("reports an idle worktree when no session is running on its branch", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: "/repos/arij" }];
    dbMockState.allQueue = [
      [
        {
          id: "epic-1",
          branchName: "feature/epic-1-payments",
          readableId: "E-arij-006",
          title: "Payments",
        },
      ],
      [],
    ];
    mockListWorktrees.mockResolvedValue(
      parseWorktreeList(PORCELAIN, "/repos/arij", () => true)
    );

    const { GET } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const json = await (await GET(mockNextRequest(), routeParams)).json();

    expect(json.data.worktrees[0].state).toBe("idle");
  });

  it("refuses with 400 before shelling out when the path is not a repository", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: "/repos/arij" }];
    const { GitRepositoryUnavailableError } = await import("@/lib/git/remote");
    mockAssertGitRepository.mockRejectedValue(
      new GitRepositoryUnavailableError(
        "GIT_REPO_NOT_A_REPOSITORY",
        "/repos/arij"
      )
    );

    const { GET } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await GET(mockNextRequest(), routeParams);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
    expect(mockListWorktrees).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected git failure instead of pretending there are zero worktrees", async () => {
    // An untyped failure from a path that IS a repository — a corrupt object
    // store, a dubious-ownership refusal. Only the typed
    // `GitRepositoryUnavailableError` is a recoverable configuration state;
    // everything else stays a fault.
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: "/repos/arij" }];
    mockListWorktrees.mockRejectedValue(new Error("fatal: bad object HEAD"));

    const { GET } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await GET(mockNextRequest(), routeParams);

    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("POST /api/projects/[projectId]/worktrees", () => {
  const routeParams = mockRouteContext({ projectId: "proj1" });

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockAssertGitRepository.mockResolvedValue(undefined);
  });

  it("prunes orphans and returns the remaining worktrees", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: "/repos/arij" }];
    dbMockState.allQueue = [[], []];
    mockPruneOrphanWorktrees.mockResolvedValue({
      pruned: 1,
      remaining: parseWorktreeList(
        [
          "worktree /repos/arij",
          "HEAD aaa111",
          "branch refs/heads/main",
          "",
          "worktree /repos/.arij-worktrees/feature-epic-1-payments",
          "HEAD bbb222",
          "branch refs/heads/feature/epic-1-payments",
          "",
        ].join("\n"),
        "/repos/arij",
        () => true
      ),
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await POST(mockNextRequest({ method: "POST" }), routeParams);
    const json = await res.json();

    expect(mockPruneOrphanWorktrees).toHaveBeenCalledWith("/repos/arij");
    expect(json.data.pruned).toBe(1);
    expect(json.data.count).toBe(1);
    expect(json.data.orphanCount).toBe(0);
  });

  it("never prunes when the path is not a repository", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: "/repos/arij" }];
    const { GitRepositoryUnavailableError } = await import("@/lib/git/remote");
    mockAssertGitRepository.mockRejectedValue(
      new GitRepositoryUnavailableError(
        "GIT_REPO_NOT_A_REPOSITORY",
        "/repos/arij"
      )
    );

    const { POST } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await POST(mockNextRequest({ method: "POST" }), routeParams);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
    expect(mockPruneOrphanWorktrees).not.toHaveBeenCalled();
  });

  it("never prunes for a project without a git repository", async () => {
    dbMockState.getQueue = [{ id: "proj1", gitRepoPath: null }];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/worktrees/route"
    );
    const res = await POST(mockNextRequest({ method: "POST" }), routeParams);

    expect(res.status).toBe(400);
    expect(mockPruneOrphanWorktrees).not.toHaveBeenCalled();
  });
});
