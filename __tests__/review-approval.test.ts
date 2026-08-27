/**
 * Tests for Review Completion & the Merge (epic merge route).
 *
 * The manual approve route is gone: the merge IS the approval. The route's
 * contract is guard-first: the workflow pre-flight (to_merge → done, source
 * "merge") must pass BEFORE any git work, and a failed merge must change
 * NOTHING — comments stay open, the epic stays in To Merge — while leaving a
 * failure trail (ticket comment, notification, same-status activity entry).
 * Only a successful merge resolves the open review comments and closes the
 * ticket.
 *
 * Closing the ticket itself goes through the transition service: the epic
 * → done write (and the child stories' → done writes) are the service's
 * status writes. Stories that never reached review are left unchanged and
 * reported as `skippedStories` instead of invalidating the merge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mocks = vi.hoisted(() => ({
  mergeWorktree: vi.fn(),
  applyTransition: vi.fn(),
  logTransition: vi.fn(),
  createApproveMergeFailedNotification: vi.fn(),
  createMergeRetryFailedNotification: vi.fn(),
  tryExportArjiJson: vi.fn(),
  getRunningSessionForTarget: vi.fn(),
  processStart: vi.fn(),
  schedulerSubmit: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/git/manager", () => ({
  mergeWorktree: mocks.mergeWorktree,
}));

vi.mock("@/lib/workflow/transition-service", () => ({
  applyTransition: mocks.applyTransition,
}));

vi.mock("@/lib/workflow/log", () => ({
  logTransition: mocks.logTransition,
}));

vi.mock("@/lib/notifications/create", () => ({
  createApproveMergeFailedNotification:
    mocks.createApproveMergeFailedNotification,
  createMergeRetryFailedNotification: mocks.createMergeRetryFailedNotification,
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mocks.tryExportArjiJson,
}));

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: mocks.getRunningSessionForTarget,
}));

vi.mock("@/lib/agents/scheduler", () => ({
  agentScheduler: { submit: mocks.schedulerSubmit },
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { start: mocks.processStart, getStatus: vi.fn() },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn(async () => "Merge system prompt"),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

vi.mock("@/lib/agent-sessions/wait-for-completion", () => ({
  waitForProcessCompletion: vi.fn(),
}));

vi.mock("@/lib/claude/resolve-session-output", () => ({
  classifySessionOutcome: vi.fn(() => "answered"),
  extractSessionUsage: vi.fn(() => null),
  resolveSessionOutput: vi.fn(() => "output"),
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "new-id"),
}));

const mockEpic = {
  id: "epic-1",
  title: "Test Epic",
  branchName: "feature/epic-abc",
  status: "to_merge",
};

const mockProject = {
  id: "p1",
  gitRepoPath: "/tmp/repo",
  defaultBranch: "main",
};

/**
 * Seed the db-mock queues in the route's read order:
 *   get #1 → project (getProjectOr404), get #2 → epic (getEpicOr404),
 *   all #1 → agent sessions (worktree lookup).
 * Story synchronization lives inside the mocked transition service.
 */
function seed({
  epic = mockEpic,
  project = mockProject,
  sessions = [{ worktreePath: "/tmp/worktrees/epic-abc" }],
}: {
  epic?: Record<string, unknown> | null;
  project?: Record<string, unknown> | null;
  sessions?: Record<string, unknown>[];
} = {}) {
  dbMockState.getQueue.push(project, epic);
  dbMockState.allQueue.push(sessions);
}

async function callMerge(projectId = "p1", epicId = "epic-1") {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/epics/[epicId]/merge/route"
  );
  const req = mockNextRequest({
    url: "http://localhost/api/test",
    method: "POST",
  });
  return POST(req, mockRouteContext({ projectId, epicId }));
}

/** Last transition-service epic call (the close, after the pre-flight). */
function lastEpicCall() {
  const calls = mocks.applyTransition.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

describe("Epic merge — the merge is the approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "abc123" });
    mocks.applyTransition.mockReturnValue({ valid: true });
  });

  describe("merge success", () => {
    it("merges the branch via mergeWorktree in the session's worktree", async () => {
      seed();
      const res = await callMerge();

      expect(res.status).toBe(200);
      expect(mocks.mergeWorktree).toHaveBeenCalledWith(
        "/tmp/repo",
        "feature/epic-abc",
        "/tmp/worktrees/epic-abc",
        { defaultBranch: "main" }
      );
    });

    it("returns merged and the commit hash", async () => {
      seed();
      const res = await callMerge();

      const json = await res.json();
      expect(json.data).toEqual({
        merged: true,
        commitHash: "abc123",
      });
    });

    it("resolves all open review comments — the merge accepts what stayed open", async () => {
      seed();
      await callMerge();

      const reviewUpdate = dbMockState.updateCalls.find(
        (c) => (c as Record<string, unknown>).status === "resolved"
      );
      expect(reviewUpdate).toBeDefined();
    });

    it("closes the epic through the transition service and clears the merged branch name", async () => {
      seed();
      await callMerge();

      // The status write is the service's (pre-flight excluded): to_merge →
      // done with source "merge", not validate-only.
      const close = lastEpicCall();
      expect(close).toMatchObject({
        fromStatus: "to_merge",
        toStatus: "done",
        source: "merge",
        actor: "user",
      });
      expect("validateOnly" in (close ?? {})).toBe(false);

      // Branch cleanup is metadata only, kept out of the service on purpose.
      const branchClear = dbMockState.updateCalls.find(
        (c) => "branchName" in (c as Record<string, unknown>)
      ) as Record<string, unknown>;
      expect(branchClear).toBeDefined();
      expect(branchClear.branchName).toBeNull();
      expect(mocks.tryExportArjiJson).toHaveBeenCalledWith("p1");
    });

    it("reports the stories the completion cascade left untouched", async () => {
      seed();
      mocks.applyTransition.mockReturnValue({
        valid: true,
        skippedStories: [{ id: "story-3", title: "Three", status: "todo" }],
      });
      const res = await callMerge();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.skippedStories).toEqual([
        { id: "story-3", title: "Three", status: "todo" },
      ]);
      // Pre-flight validation, then the real close.
      expect(mocks.applyTransition).toHaveBeenCalledTimes(2);
    });
  });

  describe("merge failure", () => {
    beforeEach(() => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "CONFLICTS: lib/foo.ts",
        reason: "conflict",
        conflictFiles: ["lib/foo.ts"],
      });
    });

    it("returns 409 with mergeFailed and the conflict files", async () => {
      seed();
      const res = await callMerge();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("Merge failed");
      expect(json.error).toContain("CONFLICTS: lib/foo.ts");
      expect(json.mergeFailed).toBe(true);
      expect(json.conflictFiles).toEqual(["lib/foo.ts"]);
    });

    it("changes NOTHING about ticket state (no comment resolution, no close)", async () => {
      seed();
      await callMerge();

      // No comment resolution, no epic/US status writes, no real transition
      // — the whole point of guard-first merging. The only applyTransition
      // call is the side-effect-free pre-flight validation.
      expect(dbMockState.updateCalls).toEqual([]);
      expect(mocks.applyTransition).toHaveBeenCalledTimes(1);
      expect(mocks.applyTransition).toHaveBeenCalledWith(
        expect.objectContaining({ validateOnly: true })
      );
    });

    it("posts a ticket comment explaining the failed merge", async () => {
      seed();
      await callMerge();

      expect(dbMockState.insertCalls).toHaveLength(1);
      const comment = dbMockState.insertCalls[0] as Record<string, unknown>;
      expect(String(comment.content)).toContain("Merge failed");
      expect(String(comment.content)).toContain("CONFLICTS: lib/foo.ts");
    });

    it("creates the merge-failed notification", async () => {
      seed();
      await callMerge();

      expect(mocks.createApproveMergeFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        error: "CONFLICTS: lib/foo.ts",
      });
    });

    it("logs a to_merge → to_merge activity entry as system", async () => {
      seed();
      await callMerge();

      expect(mocks.logTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          epicId: "epic-1",
          fromStatus: "to_merge",
          toStatus: "to_merge",
          actor: "system",
        })
      );
    });

    it("keeps the 409 contract when writing the failure trail throws", async () => {
      // SQLITE_BUSY on the trail writes must not turn the contractual 409
      // into a generic 500 — the trail is best-effort.
      mocks.createApproveMergeFailedNotification.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY");
      });
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      seed();
      const res = await callMerge();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.mergeFailed).toBe(true);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("returns mergeFailed: false for conflict-markers so it does not loop Resolve merge", async () => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "Unresolved conflict markers in lib/foo.ts",
        reason: "conflict-markers",
      });
      seed();
      const res = await callMerge();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.mergeFailed).toBe(false);
      expect(json.error).toContain("Unresolved conflict markers");
    });

    it("returns 500 with the reason for non-git-refusal failures", async () => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "Branch not found",
        reason: "branch-missing",
      });
      seed();
      const res = await callMerge();

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toContain("Branch not found");
      expect(json.reason).toBe("branch-missing");
    });
  });

  describe("nothing to merge", () => {
    it("refuses with 400 when the epic has no branch", async () => {
      seed({ epic: { ...mockEpic, branchName: null } });
      const res = await callMerge();

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("no branch to merge");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(mocks.applyTransition).not.toHaveBeenCalled();
    });

    it("refuses with 400 when the project has no git repo", async () => {
      seed({ project: { ...mockProject, gitRepoPath: null } });
      const res = await callMerge();

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("git repository");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("pre-flight validation (before the merge)", () => {
    it("validates to_merge → done with the merge source BEFORE any git work", async () => {
      seed();
      await callMerge();

      const [firstCall] = mocks.applyTransition.mock.calls;
      expect(firstCall[0]).toMatchObject({
        fromStatus: "to_merge",
        toStatus: "done",
        source: "merge",
        actor: "user",
        validateOnly: true,
      });
      // Pre-flight strictly precedes the merge.
      expect(mocks.applyTransition.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.mergeWorktree.mock.invocationCallOrder[0]
      );
    });

    it("returns 400 without ANY side effects when the pre-flight refuses", async () => {
      // Deterministic refusal, e.g. the epic is not at the merge boundary.
      // Merging first would change main, delete the branch, and resolve the
      // comments — then strand the ticket outside Done with a stale branch.
      mocks.applyTransition.mockReturnValue({
        valid: false,
        error:
          'Invalid transition: cannot move from "review" to "done". Allowed targets: in_progress, to_merge.',
      });
      seed({ epic: { ...mockEpic, status: "review" } });
      const res = await callMerge();

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Invalid transition");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(dbMockState.updateCalls).toEqual([]);
      expect(dbMockState.insertCalls).toEqual([]);
      expect(mocks.tryExportArjiJson).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when the transition is refused after a successful merge", async () => {
    // Genuinely rare race now that the guards are pre-flighted: the pre-check
    // passed, the merge landed, then a guard refused to_merge → done.
    // Surface the validation error rather than pretending the ticket closed.
    mocks.applyTransition
      .mockReturnValueOnce({ valid: true }) // pre-flight
      .mockReturnValueOnce({
        valid: false,
        error: "Cannot move while a build session is running.",
      });
    seed();
    const res = await callMerge();

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Cannot move while a build session is running.");
  });
});
