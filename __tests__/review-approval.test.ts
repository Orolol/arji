/**
 * Tests for Review Completion & Approval (epic approve route).
 *
 * The route's contract is merge-first: the epic branch must land on the
 * default branch (via mergeWorktree) BEFORE any ticket state changes. A
 * failed merge must change NOTHING — comments stay open, the epic stays in
 * review — and surface a 409 plus a notification. Only a successful merge
 * (or having nothing to merge) lets the approval resolve comments and close
 * the ticket.
 *
 * Closing the ticket itself goes through the transition service: the epic
 * → done write (and the child stories' → done writes) are the service's
 * status writes, and every child transition is pre-flighted before the
 * merge. Stories that never reached review are left unchanged and reported
 * as `skippedStories` instead of invalidating the approval.
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
  tryExportArjiJson: vi.fn(),
  beginMergeWork: vi.fn(),
  endMergeWork: vi.fn(),
  tryLockProjectMerge: vi.fn(),
  unlockProjectMerge: vi.fn(),
  getRunningSessionForTarget: vi.fn(),
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
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mocks.tryExportArjiJson,
}));

vi.mock("@/lib/auto-mode/registry", () => ({
  autoModeRegistry: {
    beginMergeWork: mocks.beginMergeWork,
    endMergeWork: mocks.endMergeWork,
    tryLockProjectMerge: mocks.tryLockProjectMerge,
    unlockProjectMerge: mocks.unlockProjectMerge,
  },
}));

vi.mock("@/lib/agents/concurrency", async () => {
  const shared = await import("@/lib/agents/concurrency-shared");
  return {
    ...shared,
    getRunningSessionForTarget: mocks.getRunningSessionForTarget,
    createAgentAlreadyRunningPayload: (
      target: unknown,
      activeSession: { id: string },
      errorMessage: string,
    ) => ({
      error: errorMessage,
      code: shared.AGENT_ALREADY_RUNNING_CODE,
      data: { activeSessionId: activeSession.id, activeSession, target },
    }),
  };
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "new-id"),
}));

const mockEpic = {
  id: "epic-1",
  title: "Test Epic",
  branchName: "feature/epic-abc",
  status: "review",
};

const mockProject = {
  id: "p1",
  gitRepoPath: "/tmp/repo",
  defaultBranch: "main",
};

/**
 * Seed the db-mock queues in the route's read order:
 *   get #1 → epic (getEpicOr404), get #2 → project,
 *   all #1 → agent sessions (worktree lookup, merge path only).
 * Story synchronization now lives inside the mocked transition service.
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
  dbMockState.getQueue.push(epic, project);
  dbMockState.allQueue.push(sessions);
}

async function callApprove(projectId = "p1", epicId = "epic-1") {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
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

describe("Epic review approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "abc123" });
    mocks.applyTransition.mockReturnValue({ valid: true });
    mocks.beginMergeWork.mockReturnValue(true);
    mocks.tryLockProjectMerge.mockReturnValue(true);
    // Default: nothing else is working on the epic.
    mocks.getRunningSessionForTarget.mockReturnValue(null);
  });

  describe("an agent still owns the epic", () => {
    /**
     * mergeWorktree runs `git worktree remove --force` before it merges, so
     * approving over a session that has not finished pulls the checkout out
     * from under it. A QUEUED session is the dangerous case: it has no
     * process yet, raises no agent chip, and starts into a directory that is
     * already gone. beginMergeWork only serialises merge against merge.
     */
    const queuedSession = {
      id: "sess-queued",
      projectId: "p1",
      epicId: "epic-1",
      userStoryId: null,
      mode: "code",
      provider: "claude-code",
      startedAt: null,
    };

    it("refuses with 409 instead of merging", async () => {
      seed();
      mocks.getRunningSessionForTarget.mockReturnValue(queuedSession);

      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe("AGENT_ALREADY_RUNNING");
      expect(json.data.activeSessionId).toBe("sess-queued");
    });

    it("writes nothing at all — no merge, no lock, no transition", async () => {
      seed();
      mocks.getRunningSessionForTarget.mockReturnValue(queuedSession);

      await callApprove();

      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(mocks.beginMergeWork).not.toHaveBeenCalled();
      expect(mocks.applyTransition).not.toHaveBeenCalled();
      expect(mocks.tryExportArjiJson).not.toHaveBeenCalled();
    });

    it("checks the epic scope, so a story session on the epic counts too", async () => {
      seed();
      mocks.getRunningSessionForTarget.mockReturnValue({
        ...queuedSession,
        userStoryId: "story-1",
      });

      const res = await callApprove();

      expect(res.status).toBe(409);
      expect(mocks.getRunningSessionForTarget).toHaveBeenCalledWith({
        scope: "epic",
        projectId: "p1",
        epicId: "epic-1",
      });
    });
  });

  describe("merge success", () => {
    it("merges the branch via mergeWorktree before approving", async () => {
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      expect(mocks.mergeWorktree).toHaveBeenCalledWith(
        "/tmp/repo",
        "feature/epic-abc",
        "/tmp/worktrees/epic-abc",
        { defaultBranch: "main" }
      );
    });

    it("returns approved, merged and the commit hash", async () => {
      seed();
      const res = await callApprove();

      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        merged: true,
        commitHash: "abc123",
      });
    });

    it("resolves all open review comments on approve", async () => {
      seed();
      await callApprove();

      const reviewUpdate = dbMockState.updateCalls.find(
        (c) => (c as Record<string, unknown>).status === "resolved"
      );
      expect(reviewUpdate).toBeDefined();
    });

    it("posts an approval activity comment to ticket comments", async () => {
      seed();
      await callApprove();

      const approvalComment = dbMockState.insertCalls.find((c) =>
        String((c as Record<string, unknown>).content).includes("approved")
      ) as Record<string, unknown>;
      expect(approvalComment).toBeDefined();
      expect(approvalComment.author).toBe("user");
    });

    it("closes the epic through the transition service and clears the merged branch name", async () => {
      seed();
      await callApprove();

      // The status write is the service's (pre-flight excluded): review →
      // done, not validate-only.
      const close = lastEpicCall();
      expect(close).toMatchObject({
        fromStatus: "review",
        toStatus: "done",
        source: "approve",
      });
      expect("validateOnly" in (close ?? {})).toBe(false);

      // Branch cleanup is metadata only, kept out of the service on purpose.
      const branchClear = dbMockState.updateCalls.find(
        (c) => "branchName" in (c as Record<string, unknown>)
      ) as Record<string, unknown>;
      expect(branchClear).toBeDefined();
      expect(branchClear.branchName).toBeNull();
    });

    it("delegates the epic and story completion to the shared transition service", async () => {
      seed();
      await callApprove();

      expect(mocks.applyTransition).toHaveBeenLastCalledWith(
        expect.objectContaining({
          fromStatus: "review",
          toStatus: "done",
          source: "approve",
          actor: "user",
        })
      );
    });
  });

  describe("merge failure", () => {
    beforeEach(() => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "CONFLICTS: lib/foo.ts",
        reason: "conflict",
      });
    });

    it("returns 409 with mergeFailed and keeps the ticket in review", async () => {
      seed();
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("Merge failed");
      expect(json.error).toContain("CONFLICTS: lib/foo.ts");
      expect(json.mergeFailed).toBe(true);
    });

    it("changes NOTHING about ticket state (no updates at all)", async () => {
      seed();
      await callApprove();

      // No comment resolution, no epic/US status writes, no real transition
      // — the whole point of merge-first approval. The only applyTransition
      // call is the side-effect-free pre-flight validation.
      expect(dbMockState.updateCalls).toEqual([]);
      expect(mocks.applyTransition).toHaveBeenCalledTimes(1);
      expect(mocks.applyTransition).toHaveBeenCalledWith(
        expect.objectContaining({ validateOnly: true })
      );
    });

    it("re-exports arji.json so the failure comment reaches the file", async () => {
      seed();
      await callApprove();

      expect(mocks.tryExportArjiJson).toHaveBeenCalledWith("p1");
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
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.mergeFailed).toBe(true);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("releases the merge lock", async () => {
      seed();
      await callApprove();

      expect(mocks.beginMergeWork).toHaveBeenCalledWith("p1", "epic-1");
      expect(mocks.endMergeWork).toHaveBeenCalledWith("p1", "epic-1");
    });

    it("funnels a mergeWorktree THROW into the same failure path", async () => {
      // getGit can throw before mergeWorktree's try block when the repo
      // directory is gone — the route must not surface a raw 500 with no
      // trail.
      mocks.mergeWorktree.mockRejectedValue(
        new Error("Cannot use simple-git on a directory that does not exist")
      );
      seed();
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      // Throws yield reason: "error", which is not a conflict. The board must
      // NOT label this a conflict or offer Resolve merge.
      expect(json.mergeFailed).toBe(false);
      expect(json.error).toContain("does not exist");
      expect(dbMockState.updateCalls).toEqual([]);
      expect(mocks.createApproveMergeFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        error: "Cannot use simple-git on a directory that does not exist",
      });
      expect(mocks.endMergeWork).toHaveBeenCalledWith("p1", "epic-1");
    });

    it("does not flag branch-missing as a conflict or log approval merge blocked prefix", async () => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "Branch not found",
        reason: "branch-missing",
      });
      seed();
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.mergeFailed).toBe(false);
      expect(json.error).toContain("Branch not found");

      expect(mocks.logTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          epicId: "epic-1",
          fromStatus: "review",
          toStatus: "review",
          actor: "system",
          reason: expect.stringMatching(/merge failed \(branch-missing\)/),
        })
      );
      // Verify it does NOT start with APPROVAL_MERGE_BLOCKED_PREFIX
      const loggedReason = (mocks.logTransition.mock.calls[0][0] as { reason: string }).reason;
      expect(loggedReason).not.toContain("Approval blocked: merge of ");
    });

    it("returns mergeFailed: false for conflict-markers so it does not loop Resolve merge", async () => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "Unresolved conflict markers in lib/foo.ts",
        reason: "conflict-markers",
      });
      seed();
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.mergeFailed).toBe(false);
      expect(json.error).toContain("Unresolved conflict markers");
    });

    it("posts a ticket comment explaining the failed merge", async () => {
      seed();
      await callApprove();

      expect(dbMockState.insertCalls).toHaveLength(1);
      const comment = dbMockState.insertCalls[0] as Record<string, unknown>;
      expect(String(comment.content)).toContain("merge failed");
      expect(String(comment.content)).toContain("CONFLICTS: lib/foo.ts");
    });

    it("creates the approve-merge-failed notification", async () => {
      seed();
      await callApprove();

      expect(mocks.createApproveMergeFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        error: "CONFLICTS: lib/foo.ts",
      });
    });

    it("logs a review → review activity entry as system", async () => {
      seed();
      await callApprove();

      expect(mocks.logTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          epicId: "epic-1",
          fromStatus: "review",
          toStatus: "review",
          actor: "system",
        })
      );
    });
  });

  describe("story synchronization (epic-scoped approval)", () => {
    it("promotes every review story, leaves the rest untouched and reports them", async () => {
      seed();
      mocks.applyTransition.mockReturnValue({
        valid: true,
        skippedStories: [
          { id: "story-3", title: "Three", status: "todo" },
        ],
      });
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.skippedStories).toEqual([
        { id: "story-3", title: "Three", status: "todo" },
      ]);

      expect(mocks.applyTransition).toHaveBeenCalledTimes(2);
    });

    it("validates the child transitions BEFORE the merge and bounces 400 when one refuses", async () => {
      seed();
      // The shared completion pre-flight reports that one child guard refused
      // (e.g. a build session is still running on it).
      mocks.applyTransition.mockReturnValueOnce({
        valid: false,
        error: "Cannot move while a build session is running.",
      });
      const res = await callApprove();

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("build session");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(dbMockState.updateCalls).toEqual([]);
      expect(dbMockState.insertCalls).toEqual([]);
      expect(mocks.beginMergeWork).not.toHaveBeenCalled();
    });
  });

  describe("nothing to merge", () => {
    it("approves without a merge when the epic has no branch", async () => {
      seed({ epic: { ...mockEpic, branchName: null } });
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        merged: false,
        mergeSkipped: "no-branch",
      });
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();

      // The epic still closes through the service, it just has nothing to land.
      const close = lastEpicCall();
      expect(close).toMatchObject({ toStatus: "done" });
      expect("validateOnly" in (close ?? {})).toBe(false);
    });

    it("approves without a merge when the project has no git repo", async () => {
      seed({ project: { ...mockProject, gitRepoPath: null } });
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.mergeSkipped).toBe("no-branch");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
    });
  });

  it("rejects approval when epic is not in review status", async () => {
    seed({ epic: { ...mockEpic, status: "in_progress" } });
    const res = await callApprove();

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("review");
    expect(mocks.mergeWorktree).not.toHaveBeenCalled();
  });

  describe("pre-flight validation (before the merge)", () => {
    it("validates the transition BEFORE merging, treating open comments as resolved", async () => {
      seed();
      await callApprove();

      const [firstCall] = mocks.applyTransition.mock.calls;
      expect(firstCall[0]).toMatchObject({
        fromStatus: "review",
        toStatus: "done",
        source: "approve",
        validateOnly: true,
        assumeReviewCommentsResolved: true,
      });
      // Pre-flight strictly precedes the merge.
      expect(mocks.applyTransition.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.mergeWorktree.mock.invocationCallOrder[0]
      );
    });

    it("returns 400 without ANY side effects when the pre-flight refuses", async () => {
      // Deterministic refusal, e.g. the epic was dragged into review with no
      // completed review session. Merging first would change main, delete
      // the branch, and resolve the comments — then strand the epic in
      // review with a stale branchName.
      mocks.applyTransition.mockReturnValue({
        valid: false,
        error: "Cannot move to Done: no completed review found.",
      });
      seed();
      const res = await callApprove();

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("no completed review");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(dbMockState.updateCalls).toEqual([]);
      expect(dbMockState.insertCalls).toEqual([]);
      expect(mocks.beginMergeWork).not.toHaveBeenCalled();
      expect(mocks.tryExportArjiJson).not.toHaveBeenCalled();
    });
  });

  describe("merge lock", () => {
    it("returns 409 without side effects when a merge is already in flight", async () => {
      mocks.beginMergeWork.mockReturnValue(false);
      seed();
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("already in flight");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(dbMockState.updateCalls).toEqual([]);
      expect(dbMockState.insertCalls).toEqual([]);
      // Never acquired, so never released.
      expect(mocks.endMergeWork).not.toHaveBeenCalled();
    });

    it("returns 409 when another merge is in progress in the project repository", async () => {
      mocks.tryLockProjectMerge.mockReturnValue(false);
      seed();
      const res = await callApprove();

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain("Another merge is in progress in this repository");
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(mocks.unlockProjectMerge).not.toHaveBeenCalled();
    });

    it("acquires and releases the lock around a successful merge", async () => {
      seed();
      await callApprove();

      expect(mocks.beginMergeWork).toHaveBeenCalledWith("p1", "epic-1");
      expect(mocks.endMergeWork).toHaveBeenCalledWith("p1", "epic-1");
      expect(mocks.beginMergeWork.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.mergeWorktree.mock.invocationCallOrder[0]
      );
    });

    it("does not take the lock when there is nothing to merge", async () => {
      seed({ epic: { ...mockEpic, branchName: null } });
      await callApprove();

      expect(mocks.beginMergeWork).not.toHaveBeenCalled();
      expect(mocks.endMergeWork).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when the transition is refused after a successful merge", async () => {
    // Genuinely rare race now that the guards are pre-flighted: the pre-check
    // passed, the merge landed, then a guard refused review → done. The merge
    // route's precedent applies — surface the validation error.
    mocks.applyTransition
      .mockReturnValueOnce({ valid: true }) // pre-flight
      .mockReturnValueOnce({
        valid: false,
        error: "Epic has open review comments",
      });
    seed();
    const res = await callApprove();

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Epic has open review comments");
    // The lock is still released through the finally.
    expect(mocks.endMergeWork).toHaveBeenCalledWith("p1", "epic-1");
  });
});
