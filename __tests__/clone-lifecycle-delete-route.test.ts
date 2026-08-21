import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  getDbChainMock,
  mockNextRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

/**
 * Story: "As a user deleting a cloned project, I want the option to remove its
 * directory" — the route contract.
 *
 * The filesystem behaviour itself is covered against real repositories in
 * clone-lifecycle-cleanup.test.ts; here we pin what the route does with it:
 * when it calls removal at all, in what order relative to cancelling agents,
 * and what it reports back.
 */

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const mockGetProjectOr404 = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/route-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/route-helpers")>(
    "@/lib/api/route-helpers"
  );
  return { ...actual, getProjectOr404: mockGetProjectOr404 };
});

const mockRemoveProjectClone = vi.hoisted(() => vi.fn());
vi.mock("@/lib/projects/clone-cleanup", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/projects/clone-cleanup")
  >("@/lib/projects/clone-cleanup");
  return { ...actual, removeProjectClone: mockRemoveProjectClone };
});

const mockCancelProjectSessions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/projects/cancel-sessions", () => ({
  cancelProjectSessions: mockCancelProjectSessions,
}));

// Stubbed rather than exercised: the real one unlinks under `process.cwd()`,
// which in a test run is the working tree. Its behaviour is covered against a
// temporary directory in attachment-ownership.test.ts; what matters here is
// that the route calls it, and calls it before the row it depends on is gone.
const mockDeleteProjectUploads = vi.hoisted(() => vi.fn());
vi.mock("@/lib/uploads/attachment-ownership", () => ({
  deleteProjectUploads: mockDeleteProjectUploads,
}));

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

/** Order of side effects, so "cancelled before removal" is actually asserted. */
let callOrder: string[] = [];

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    name: "Demo",
    gitRepoPath: "/workspace/projects/owner-repo",
    cloneSource: "github",
    gitRemoteUrl: "https://github.com/owner/repo.git",
    ...overrides,
  };
}

function deleteRequest(searchParams: Record<string, string> = {}) {
  return mockNextRequest({
    url: "http://localhost:3000/api/projects/proj-1",
    method: "DELETE",
    searchParams,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
  callOrder = [];

  mockCancelProjectSessions.mockImplementation(() => {
    callOrder.push("cancel");
    return { sessions: ["sess-1"], activities: [] };
  });

  mockRemoveProjectClone.mockImplementation(async () => {
    callOrder.push("remove");
    return {
      removed: true,
      path: "/workspace/projects/owner-repo",
      worktreesRemoved: ["/workspace/projects/.arij-worktrees/feature-x"],
      worktreesPruned: 0,
    };
  });

  // Records nothing by default, so the existing `callOrder` assertions keep
  // meaning exactly what they meant; the ordering test opts in below.
  mockDeleteProjectUploads.mockReturnValue({
    rowsDeleted: 3,
    directoryRemoved: true,
  });

  mockGetProjectOr404.mockReturnValue({ project: project() });
});

async function callDelete(searchParams: Record<string, string> = {}) {
  const { DELETE } = await import("@/app/api/projects/[projectId]/route");
  return DELETE(deleteRequest(searchParams), mockRouteContext({ projectId: "proj-1" }));
}

describe("DELETE /api/projects/[projectId]", () => {
  it("without the flag, removes the DB row and no directory", async () => {
    const response = await callDelete();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.ok).toBe(true);
    expect(json.data.directoryRemoved).toBe(false);
    expect(json.data.directory).toBeNull();
    expect(mockRemoveProjectClone).not.toHaveBeenCalled();
    expect(getDbChainMock().delete).toHaveBeenCalled();
  });

  it("ignores a removeDirectory value that is not exactly \"true\"", async () => {
    for (const value of ["1", "yes", "TRUE", ""]) {
      vi.clearAllMocks();
      await callDelete({ removeDirectory: value });
      expect(mockRemoveProjectClone).not.toHaveBeenCalled();
    }
  });

  it("with the flag on a cloned project, removes the clone and its worktrees", async () => {
    const response = await callDelete({ removeDirectory: "true" });
    const json = await response.json();

    expect(mockRemoveProjectClone).toHaveBeenCalledWith({
      gitRepoPath: "/workspace/projects/owner-repo",
      cloneSource: "github",
    });
    expect(json.data.directoryRemoved).toBe(true);
    expect(json.data.directory.path).toBe("/workspace/projects/owner-repo");
    expect(json.data.directory.worktreesRemoved).toEqual([
      "/workspace/projects/.arij-worktrees/feature-x",
    ]);
  });

  it("with the flag on a user-supplied project, keeps the directory and says so", async () => {
    mockGetProjectOr404.mockReturnValue({
      project: project({ cloneSource: null }),
    });
    mockRemoveProjectClone.mockResolvedValue({
      removed: false,
      path: "/home/me/my-repo",
      worktreesRemoved: [],
      worktreesPruned: 0,
      reason: "not_managed",
      message:
        "Directory left untouched: this project's repository was supplied by you, not cloned by Arij.",
    });

    const response = await callDelete({ removeDirectory: "true" });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.ok).toBe(true);
    expect(json.data.directoryRemoved).toBe(false);
    expect(json.data.directory.reason).toBe("not_managed");
    expect(json.data.directory.message).toMatch(/left untouched/i);
  });

  it("reports a path that resolves outside the projects root as refused", async () => {
    mockRemoveProjectClone.mockResolvedValue({
      removed: false,
      path: "/etc",
      worktreesRemoved: [],
      worktreesPruned: 0,
      reason: "outside_projects_root",
      message: "Directory left untouched: it is outside the configured projects root.",
    });

    const json = await (await callDelete({ removeDirectory: "true" })).json();

    expect(json.data.directoryRemoved).toBe(false);
    expect(json.data.directory.reason).toBe("outside_projects_root");
  });

  it("still deletes the project when directory removal fails", async () => {
    mockRemoveProjectClone.mockResolvedValue({
      removed: false,
      path: "/workspace/projects/owner-repo",
      worktreesRemoved: [],
      worktreesPruned: 0,
      error: "EACCES: permission denied",
    });

    const response = await callDelete({ removeDirectory: "true" });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.ok).toBe(true);
    expect(json.data.directory.error).toContain("EACCES");
    expect(getDbChainMock().delete).toHaveBeenCalled();
  });

  it("cancels running agent sessions before removing the directory", async () => {
    const json = await (await callDelete({ removeDirectory: "true" })).json();

    expect(callOrder).toEqual(["cancel", "remove"]);
    expect(mockCancelProjectSessions).toHaveBeenCalledWith("proj-1", "Project deleted");
    expect(json.data.cancelledSessions).toEqual(["sess-1"]);
  });

  it("cancels running agent sessions even without the flag", async () => {
    await callDelete();

    expect(mockCancelProjectSessions).toHaveBeenCalledWith("proj-1", "Project deleted");
  });

  it("cleans up per-project settings keys", async () => {
    dbMockState.allQueue = [
      [
        { key: "agent_max_concurrent:proj-1" },
        { key: "webhook_url:proj-1" },
      ],
    ];

    const json = await (await callDelete()).json();

    expect(json.data.settingsRemoved).toEqual([
      "agent_max_concurrent:proj-1",
      "webhook_url:proj-1",
    ]);
    expect(getDbChainMock().delete).toHaveBeenCalled();
  });

  it("removes the project's uploads and reports what went", async () => {
    const json = await (await callDelete()).json();

    expect(mockDeleteProjectUploads).toHaveBeenCalledWith("proj-1");
    expect(json.data.uploadsRemoved).toBe(3);
    expect(json.data.uploadsDirectoryRemoved).toBe(true);
  });

  it("removes the uploads before the project row they hang off", async () => {
    // The attachment rows cascade away with the project, so afterwards nothing
    // names the files any more — the cleanup only reaches them from in front.
    mockDeleteProjectUploads.mockImplementation(() => {
      callOrder.push("uploads");
      return { rowsDeleted: 3, directoryRemoved: true };
    });
    getDbChainMock().delete.mockImplementation(() => {
      callOrder.push("delete-project");
      return getDbChainMock();
    });

    await callDelete();

    expect(callOrder.indexOf("uploads")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("uploads")).toBeLessThan(
      callOrder.lastIndexOf("delete-project")
    );
  });

  it("returns the 404 from the project lookup untouched", async () => {
    const { NextResponse } = await import("next/server");
    mockGetProjectOr404.mockReturnValue(
      NextResponse.json({ error: "Project not found" }, { status: 404 })
    );

    const response = await callDelete({ removeDirectory: "true" });

    expect(response.status).toBe(404);
    expect(mockCancelProjectSessions).not.toHaveBeenCalled();
    expect(mockRemoveProjectClone).not.toHaveBeenCalled();
    expect(mockDeleteProjectUploads).not.toHaveBeenCalled();
  });
});

describe("perProjectSettingKeys", () => {
  it("covers every per-project settings key builder in the codebase", async () => {
    const { perProjectSettingKeys } = await import(
      "@/lib/projects/project-settings-keys"
    );

    // Named explicitly by the acceptance criteria, plus the pipeline/night keys
    // that follow the same `<key>:<projectId>` convention.
    expect(perProjectSettingKeys("proj-1")).toEqual([
      "agent_max_concurrent:proj-1",
      "webhook_url:proj-1",
      "pipeline_enabled:proj-1",
      "pipeline_max_attempts:proj-1",
      "pipeline_max_fix_cycles:proj-1",
      "night_circuit_breaker:proj-1",
      "night_cost_cap_usd:proj-1",
    ]);
  });
});
