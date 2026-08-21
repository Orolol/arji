import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockPushGitBranch = vi.hoisted(() => vi.fn());
const mockCreatePullRequest = vi.hoisted(() => vi.fn());
const mockGeneratePrBody = vi.hoisted(() => vi.fn(() => "pr body"));
const mockGetGitHubTokenFromSettings = vi.hoisted(() => vi.fn());
const mockWriteGitSyncLog = vi.hoisted(() => vi.fn());
const mockResolveDefaultBranch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/github/client", () => ({
  getGitHubTokenFromSettings: mockGetGitHubTokenFromSettings,
}));

vi.mock("@/lib/git/remote", () => ({
  pushGitBranch: mockPushGitBranch,
}));

vi.mock("@/lib/git/manager", () => ({
  resolveDefaultBranch: mockResolveDefaultBranch,
}));

vi.mock("@/lib/github/pull-requests", () => ({
  generatePrBody: mockGeneratePrBody,
  createPullRequest: mockCreatePullRequest,
}));

vi.mock("@/lib/github/sync-log", () => ({
  writeGitSyncLog: mockWriteGitSyncLog,
}));

const prResult = {
  number: 42,
  url: "https://github.com/acme/gadget/pull/42",
  title: "Epic One",
  status: "open",
  headBranch: "feature/epic-1",
  baseBranch: "develop",
};

/**
 * POST /api/projects/[projectId]/epics/[epicId]/pr — base branch resolution.
 *
 * The PR must target a branch that exists on the remote. A hard-coded "main"
 * makes GitHub answer 422 "Base ref must be a branch" on a develop-default
 * clone, so the route decides the base from the project's stored
 * default_branch (authoritative for Arij-cloned projects), falling back to
 * asking the repository itself.
 */
describe("POST /api/projects/[projectId]/epics/[epicId]/pr — base branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockGetGitHubTokenFromSettings.mockReturnValue("pat-token");
    mockPushGitBranch.mockResolvedValue(undefined);
    mockCreatePullRequest.mockResolvedValue(prResult);
    mockResolveDefaultBranch.mockResolvedValue("develop");

    dbMockState.getQueue = [
      // getProjectOr404
      {
        id: "proj-1",
        gitRepoPath: "/repo",
        githubOwnerRepo: "acme/gadget",
        defaultBranch: "develop",
      },
      // getEpicOr404
      {
        id: "epic-1",
        projectId: "proj-1",
        title: "Epic One",
        branchName: "feature/epic-1",
      },
      // existing-PR lookup
      null,
      // final PR row for the response
      { id: "pr-1", ...prResult },
    ];
    dbMockState.allQueue = [[]]; // epic's user stories
  });

  async function postPr(body: unknown) {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/pr/route"
    );
    return POST(
      mockJsonRequest(body),
      mockRouteContext({ projectId: "proj-1", epicId: "epic-1" })
    );
  }

  it("targets the project's stored default branch by default", async () => {
    const res = await postPr({});

    expect(res.status).toBe(201);
    // The route hands the stored value to the resolver (which trusts it when
    // it exists locally) and uses the resolved value as the PR base.
    expect(mockResolveDefaultBranch).toHaveBeenCalledWith("/repo", "develop");
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "gadget",
        head: "feature/epic-1",
        base: "develop",
      })
    );
  });

  it("keeps an explicitly requested base branch over the stored default", async () => {
    const res = await postPr({ baseBranch: "release-1.0" });

    expect(res.status).toBe(201);
    expect(mockResolveDefaultBranch).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "release-1.0" })
    );
  });

  it("asks the repository itself when the project has no stored default", async () => {
    dbMockState.getQueue[0] = {
      id: "proj-1",
      gitRepoPath: "/repo",
      githubOwnerRepo: "acme/gadget",
      defaultBranch: null,
    };
    mockResolveDefaultBranch.mockResolvedValue("trunk");

    const res = await postPr({});

    expect(res.status).toBe(201);
    expect(mockResolveDefaultBranch).toHaveBeenCalledWith("/repo", undefined);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "trunk" })
    );
  });

  it("falls back to the historical main when the repository cannot be resolved", async () => {
    mockResolveDefaultBranch.mockRejectedValue(
      new Error("fatal: not a git repository")
    );

    const res = await postPr({});

    expect(res.status).toBe(201);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "main" })
    );
  });

  it("still rejects a project without a GitHub owner/repo", async () => {
    dbMockState.getQueue[0] = {
      id: "proj-1",
      gitRepoPath: "/repo",
      githubOwnerRepo: null,
      defaultBranch: "develop",
    };

    const res = await postPr({});

    expect(res.status).toBe(400);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });
});