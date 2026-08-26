/**
 * Resolve-merge route, background agent path: what happens when the agent
 * reports success but the FINAL merge into main still fails (e.g. the agent
 * committed the conflict markers, tripping mergeWorktree's marker guard).
 *
 * This runs in a fire-and-forget closure with no HTTP response left to carry
 * the failure — exactly the silent swallow this route exists to kill. The
 * pinned contract: the epic is NOT closed, a ticket comment explains the
 * failed final merge, and a merge-retry-failed notification is created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mocks = vi.hoisted(() => ({
  mergeWorktree: vi.fn(),
  createWorktree: vi.fn(),
  attachWorktree: vi.fn(),
  isGitRepo: vi.fn(),
  startMergeInWorktree: vi.fn(),
  waitForProcessCompletion: vi.fn(),
  applyTransition: vi.fn(),
  createMergeRetryFailedNotification: vi.fn(),
  tryExportArjiJson: vi.fn(),
  getRunningSessionForTarget: vi.fn(),
  tryLockProjectMerge: vi.fn(),
  unlockProjectMerge: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/workflow/transition-service", () => ({
  applyTransition: mocks.applyTransition,
  applyStoryTransition: vi.fn(),
  logWorkflowDecision: vi.fn(),
}));

vi.mock("@/lib/auto-mode/registry", () => ({
  autoModeRegistry: {
    tryLockProjectMerge: mocks.tryLockProjectMerge,
    unlockProjectMerge: mocks.unlockProjectMerge,
  },
}));

vi.mock("@/lib/git/manager", () => ({
  mergeWorktree: mocks.mergeWorktree,
  createWorktree: mocks.createWorktree,
  attachWorktree: mocks.attachWorktree,
  isGitRepo: mocks.isGitRepo,
  startMergeInWorktree: mocks.startMergeInWorktree,
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { start: vi.fn() },
}));

vi.mock("@/lib/agent-sessions/wait-for-completion", () => ({
  waitForProcessCompletion: mocks.waitForProcessCompletion,
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildMergeResolutionPrompt: vi.fn(() => "resolve the conflicts"),
}));

vi.mock("@/lib/claude/resolve-session-output", () => ({
  classifySessionOutcome: vi.fn(() => "completed"),
  extractSessionUsage: vi.fn(() => null),
  resolveSessionOutput: vi.fn(() => "agent output"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    model: null,
    namedAgentId: null,
    name: null,
  })),
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mocks.tryExportArjiJson,
}));

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: mocks.getRunningSessionForTarget,
  createAgentAlreadyRunningPayload: vi.fn(() => ({
    error: "running",
    code: "AGENT_ALREADY_RUNNING",
  })),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

vi.mock("@/lib/agent-sessions/validate-resume", () => ({
  validateResumeSession: vi.fn(() => null),
}));

vi.mock("@/lib/agent-sessions/resume-capability", () => ({
  isResumableProvider: vi.fn(() => false),
  providerAcceptsAssignedSessionId: vi.fn(() => false),
}));

vi.mock("@/lib/notifications/create", () => ({
  createMergeRetryFailedNotification:
    mocks.createMergeRetryFailedNotification,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "session-1"),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

const mockProject = {
  id: "p1",
  gitRepoPath: "/tmp/repo",
  defaultBranch: "main",
};

const mockEpic = {
  id: "epic-1",
  title: "Test Epic",
  branchName: "feature/epic-abc",
  status: "review",
};

/**
 * Seed the db-mock queues in the route's read order:
 *   get #1 → project (getProjectOr404), get #2 → epic (getEpicOr404),
 *   get #3 → settings row (global prompt).
 */
function seed() {
  dbMockState.getQueue.push(mockProject, mockEpic, null);
}

async function callResolveMerge() {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/epics/[epicId]/resolve-merge/route"
  );
  return POST(
    mockJsonRequest({}),
    mockRouteContext({ projectId: "p1", epicId: "epic-1" })
  );
}

describe("Resolve-merge: final merge fails after the agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mocks.applyTransition.mockReturnValue({ valid: true });
    mocks.getRunningSessionForTarget.mockReturnValue(null);
    mocks.tryLockProjectMerge.mockReturnValue(true);
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.attachWorktree.mockResolvedValue({
      worktreePath: "/tmp/worktrees/epic-abc",
      branchName: "feature/epic-abc",
    });
    // Conflicts exist, so the agent path (not the clean fast path) runs.
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: true,
      output: "CONFLICT (content): lib/foo.ts",
    });
    // The agent "succeeds"...
    mocks.waitForProcessCompletion.mockResolvedValue({
      status: "completed",
      result: { success: true },
    });
    // ...but the final merge still refuses (markers committed).
    mocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error:
        "Branch feature/epic-abc contains unresolved conflict markers in: lib/foo.ts",
      reason: "conflict-markers",
    });
  });

  it("leaves a comment + notification instead of swallowing the failure", async () => {
    seed();
    const res = await callResolveMerge();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ sessionId: "session-1", resolved: false });

    // The background closure settles in microtasks (every awaited mock
    // resolves immediately).
    await vi.waitFor(() => {
      expect(mocks.createMergeRetryFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        sessionId: "session-1",
        error:
          "Branch feature/epic-abc contains unresolved conflict markers in: lib/foo.ts",
      });
    });

    // The failure comment reached the ticket…
    const failureComment = dbMockState.insertCalls.find((c) =>
      String((c as Record<string, unknown>).content).includes(
        "final merge still failed"
      )
    ) as Record<string, unknown>;
    expect(failureComment).toBeDefined();
    expect(String(failureComment.content)).toContain("conflict markers");

    // …and the epic was NOT closed: the service never ran a close and no
    // branch-name cleanup touched the row.
    const closeCall = mocks.applyTransition.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).toStatus === "done" &&
        !("validateOnly" in (c[0] as object))
    );
    expect(closeCall).toBeUndefined();
    expect(dbMockState.updateCalls).toEqual([]);
    expect(mocks.tryExportArjiJson).not.toHaveBeenCalled();
  });

  it("refuses before touching git when an agent owns the epic", async () => {
    // The guard used to sit on the conflict branch only, so the CLEAN path
    // reached `mergeWorktree` — and its `git worktree remove --force` — over
    // a queued build. Both branches are covered now, which is why this asserts
    // on the clean setup specifically.
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: false,
      output: "Already up to date.",
    });
    mocks.getRunningSessionForTarget.mockReturnValue({
      id: "sess-queued",
      projectId: "p1",
      epicId: "epic-1",
      userStoryId: null,
      mode: "code",
      provider: "claude-code",
      startedAt: null,
    });
    seed();

    const res = await callResolveMerge();

    expect(res.status).toBe(409);
    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(mocks.startMergeInWorktree).not.toHaveBeenCalled();
    expect(mocks.mergeWorktree).not.toHaveBeenCalled();
  });

  it("surfaces conflicts against the project's default branch, not literal main", async () => {
    seed();
    await callResolveMerge();

    expect(mocks.startMergeInWorktree).toHaveBeenCalledWith(
      "/tmp/worktrees/epic-abc",
      "main"
    );

    // A repo whose default branch is not `main` must be compared against ITS
    // base — the same one `mergeWorktree` is handed moments later.
    vi.clearAllMocks();
    mocks.applyTransition.mockReturnValue({ valid: true });
    mocks.getRunningSessionForTarget.mockReturnValue(null);
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.createWorktree.mockResolvedValue({
      worktreePath: "/tmp/worktrees/epic-abc",
      branchName: "feature/epic-abc",
    });
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: true,
      output: "CONFLICT",
    });
    mocks.waitForProcessCompletion.mockResolvedValue({
      status: "completed",
      result: { success: false },
    });
    dbMockState.getQueue.push(
      { ...mockProject, defaultBranch: "trunk" },
      mockEpic,
      null
    );

    await callResolveMerge();

    expect(mocks.startMergeInWorktree).toHaveBeenCalledWith(
      "/tmp/worktrees/epic-abc",
      "trunk"
    );
  });

  it("flags the clean-path final merge failure with mergeFailed", async () => {
    // No conflicts to resolve, so the route merges straight away — and when
    // THAT refuses, the flag is what tells a caller git was the wall (the
    // board card keys "offer Resolve merge" off it, same as the approve
    // route's 409).
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: false,
      output: "Already up to date.",
    });
    mocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "CONFLICT (content): lib/foo.ts",
      reason: "conflict",
    });
    seed();

    const res = await callResolveMerge();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({
      error: "CONFLICT (content): lib/foo.ts",
      mergeFailed: true,
    });
  });

  it("returns mergeFailed: false on clean-path final merge non-conflict errors", async () => {
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: false,
      output: "Already up to date.",
    });
    mocks.mergeWorktree.mockResolvedValue({
      merged: false,
      error: "Git repository corrupted",
      reason: "error",
    });
    seed();

    const res = await callResolveMerge();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({
      error: "Git repository corrupted",
      mergeFailed: false,
    });
  });

  it("attaches to the exact branch stored on the epic even when the title was edited", async () => {
    // If the epic title was edited, createWorktree would re-derive the branch
    // from the new title and cut an empty branch off main. attachWorktree must
    // receive the epic's persisted branchName verbatim.
    mocks.attachWorktree.mockResolvedValue({
      worktreePath: "/tmp/worktrees/original-branch",
      branchName: "feature/original-branch-name",
    });
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: false,
      output: "Already up to date.",
    });
    mocks.mergeWorktree.mockResolvedValue({
      merged: true,
      commitHash: "xyz789",
    });
    dbMockState.getQueue.push(
      mockProject,
      { ...mockEpic, title: "Completely Edited Title", branchName: "feature/original-branch-name" },
      null
    );

    await callResolveMerge();

    expect(mocks.attachWorktree).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/original-branch-name"
    );
    expect(mocks.mergeWorktree).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/original-branch-name",
      "/tmp/worktrees/original-branch",
      expect.anything()
    );
  });

  it("returns status 400 when attachWorktree fails because the branch is gone", async () => {
    mocks.attachWorktree.mockRejectedValue(
      new Error("Branch feature/epic-abc not found")
    );
    seed();

    const res = await callResolveMerge();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Branch feature/epic-abc not found");
  });

  it("returns 409 when clean-path final merge cannot acquire project merge lock", async () => {
    mocks.startMergeInWorktree.mockResolvedValue({
      conflicted: false,
      output: "Already up to date.",
    });
    mocks.tryLockProjectMerge.mockReturnValue(false);
    seed();

    const res = await callResolveMerge();
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toContain("Another merge is in progress");
    expect(mocks.mergeWorktree).not.toHaveBeenCalled();
  });

  it("notifies failure when agent completion final merge cannot acquire project merge lock", async () => {
    mocks.tryLockProjectMerge.mockReturnValue(false);
    seed();

    await callResolveMerge();

    await vi.waitFor(() => {
      expect(mocks.createMergeRetryFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        sessionId: "session-1",
        error: expect.stringContaining("another merge is in progress"),
      });
    });
    expect(mocks.mergeWorktree).not.toHaveBeenCalled();
  });

  it("still closes the epic when the final merge lands (control)", async () => {
    mocks.mergeWorktree.mockResolvedValue({
      merged: true,
      commitHash: "abc123",
    });
    seed();
    await callResolveMerge();

    await vi.waitFor(() => {
      const closeCall = mocks.applyTransition.mock.calls.find(
        (c) => (c[0] as Record<string, unknown>).toStatus === "done" &&
          !("validateOnly" in (c[0] as object))
      );
      expect(closeCall).toBeDefined();
    });

    // The landing merge clears the branch on the epic row.
    await vi.waitFor(() => {
      const branchClear = dbMockState.updateCalls.find(
        (c) => (c as Record<string, unknown>).branchName === null
      );
      expect(branchClear).toBeDefined();
    });
    expect(mocks.createMergeRetryFailedNotification).not.toHaveBeenCalled();
  });
});
