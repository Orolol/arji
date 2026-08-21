/**
 * Tests for the user-story approve route.
 *
 * Contract: the story itself ALWAYS goes done — approving one story is a
 * verdict on that story and must never be blocked by git. Only when the last
 * open story is approved does the epic close, and closing the epic requires
 * its branch to land first (mergeWorktree, merge-before-done). A failed epic
 * merge leaves the epic status untouched and reports the partial outcome
 * with 200 + mergeError — the story approval itself DID succeed.
 *
 * Every status write (story → done, epic → done) goes through the
 * transition service, so the engine's guards still apply: an epic whose
 * completion the engine refuses stays put and the refusal is reported back
 * to the caller instead of force-closing it.
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
  applyStoryTransition: vi.fn(),
  logWorkflowDecision: vi.fn(),
  logTransition: vi.fn(),
  createApproveMergeFailedNotification: vi.fn(),
  tryExportArjiJson: vi.fn(),
  beginMergeWork: vi.fn(),
  endMergeWork: vi.fn(),
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
  applyStoryTransition: mocks.applyStoryTransition,
  logWorkflowDecision: mocks.logWorkflowDecision,
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
  },
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "new-id"),
}));

const mockStory = {
  id: "us-1",
  epicId: "epic-1",
  title: "Test Story",
  status: "review",
};

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
 *   get #1 → { story } (getStoryOr404's joined row shape),
 *   get #2 → epic,
 *   all #1 → sibling stories,
 *   get #3 → project (only when the epic is complete),
 *   all #2 → agent sessions (worktree lookup, merge path only).
 */
function seed({
  story = mockStory,
  epic = mockEpic,
  siblings = [mockStory],
  project = mockProject,
  sessions = [{ worktreePath: "/tmp/worktrees/epic-abc" }],
}: {
  story?: Record<string, unknown>;
  epic?: Record<string, unknown> | null;
  siblings?: Record<string, unknown>[];
  project?: Record<string, unknown> | null;
  sessions?: Record<string, unknown>[];
} = {}) {
  dbMockState.getQueue.push({ story }, epic, project);
  dbMockState.allQueue.push(siblings, sessions);
}

async function callApprove(projectId = "p1", storyId = "us-1") {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/stories/[storyId]/approve/route"
  );
  const req = mockNextRequest({
    url: "http://localhost/api/test",
    method: "POST",
  });
  return POST(req, mockRouteContext({ projectId, storyId }));
}

/** Update payloads that touch the epic row (they carry updatedAt). */
function epicUpdates() {
  return dbMockState.updateCalls.filter(
    (c) => "updatedAt" in (c as Record<string, unknown>)
  ) as Record<string, unknown>[];
}

/** The service call that closes the epic (absent when the epic is held). */
function epicCloseCall() {
  return mocks.applyTransition.mock.calls.find(
    (c) => (c[0] as Record<string, unknown>).toStatus === "done" &&
      !("validateOnly" in (c[0] as object))
  )?.[0] as Record<string, unknown> | undefined;
}

describe("Story approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "abc123" });
    mocks.applyTransition.mockReturnValue({ valid: true });
    mocks.applyStoryTransition.mockReturnValue({ valid: true });
    mocks.beginMergeWork.mockReturnValue(true);
  });

  it("rejects approval when the story is not in review status", async () => {
    seed({ story: { ...mockStory, status: "in_progress" } });
    const res = await callApprove();

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("review");
    expect(dbMockState.updateCalls).toEqual([]);
    expect(mocks.applyStoryTransition).not.toHaveBeenCalled();
  });

  it("moves the story to done without closing the epic when siblings remain", async () => {
    seed({
      siblings: [mockStory, { id: "us-2", epicId: "epic-1", status: "review" }],
    });
    const res = await callApprove();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({
      approved: true,
      epicComplete: false,
      merged: false,
    });
    expect(mocks.mergeWorktree).not.toHaveBeenCalled();
    // The story verdict is the service's write; the epic row is untouched
    // and the epic transition is never even validated.
    expect(mocks.applyStoryTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        userStoryId: "us-1",
        fromStatus: "review",
        toStatus: "done",
      })
    );
    expect(mocks.applyTransition).not.toHaveBeenCalled();
    expect(dbMockState.updateCalls).toEqual([]);
  });

  describe("last story approved — epic merge success", () => {
    it("merges via mergeWorktree, then closes the epic and clears its branch", async () => {
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      expect(mocks.mergeWorktree).toHaveBeenCalledWith(
        "/tmp/repo",
        "feature/epic-abc",
        "/tmp/worktrees/epic-abc",
        { defaultBranch: "main" }
      );

      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        epicComplete: true,
        merged: true,
        commitHash: "abc123",
      });

      // The status write is the service's; the route only clears the branch.
      expect(epicCloseCall()).toMatchObject({
        fromStatus: "review",
        toStatus: "done",
        source: "approve",
      });
      const [branchClear] = epicUpdates();
      expect(branchClear).toMatchObject({ branchName: null });
    });

    it("acquires and releases the per-epic merge lock", async () => {
      seed();
      await callApprove();

      expect(mocks.beginMergeWork).toHaveBeenCalledWith("p1", "epic-1");
      expect(mocks.endMergeWork).toHaveBeenCalledWith("p1", "epic-1");
      expect(mocks.beginMergeWork.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.mergeWorktree.mock.invocationCallOrder[0]
      );
    });
  });

  describe("last story approved — merge already in flight", () => {
    it("keeps the story done, leaves the epic alone, reports via mergeError", async () => {
      mocks.beginMergeWork.mockReturnValue(false);
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        epicComplete: true,
        merged: false,
        mergeError:
          "A merge is already in flight for this epic — retry in a moment.",
      });
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      // The story verdict stands (service write); the epic row and its
      // comments are untouched, and no spurious failure trail was written
      // for a healthy epic.
      expect(dbMockState.updateCalls).toEqual([]);
      expect(dbMockState.insertCalls).toEqual([]);
      expect(mocks.createApproveMergeFailedNotification).not.toHaveBeenCalled();
      // Never acquired, so never released.
      expect(mocks.endMergeWork).not.toHaveBeenCalled();
    });
  });

  describe("last story approved — engine refuses the epic close", () => {
    it("holds the epic in place and reports the refusal instead of force-closing", async () => {
      mocks.applyTransition.mockReturnValue({
        valid: false,
        error: "Cannot move to Done: no completed review found.",
      });
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        epicComplete: false,
        epicHoldReason: "Cannot move to Done: no completed review found.",
        merged: false,
      });

      // Nothing git-related ran and the epic row was never written.
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(mocks.beginMergeWork).not.toHaveBeenCalled();
      expect(dbMockState.updateCalls).toEqual([]);
      // The hold is named in the activity log, not left implicit.
      expect(mocks.logWorkflowDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          epicId: "epic-1",
          actor: "user",
          reason: expect.stringContaining("no completed review"),
        })
      );
    });
  });

  describe("last story approved — epic merge failure", () => {
    beforeEach(() => {
      mocks.mergeWorktree.mockResolvedValue({
        merged: false,
        error: "CONFLICTS: lib/foo.ts",
        reason: "conflict",
      });
    });

    it("keeps the story approval but reports the merge error with 200", async () => {
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        epicComplete: true,
        merged: false,
        mergeError: "CONFLICTS: lib/foo.ts",
      });
    });

    it("leaves the epic status unchanged", async () => {
      seed();
      await callApprove();

      // The story went done (service write); nothing was written to the epic
      // row — the branch-clear only happens when the merge lands.
      expect(epicUpdates()).toEqual([]);
      expect(dbMockState.updateCalls).toEqual([]);
    });

    it("posts a ticket comment, notification, and same-status log entry", async () => {
      seed();
      await callApprove();

      expect(dbMockState.insertCalls).toHaveLength(1);
      const comment = dbMockState.insertCalls[0] as Record<string, unknown>;
      expect(comment.epicId).toBe("epic-1");
      expect(String(comment.content)).toContain("merge failed");

      expect(mocks.createApproveMergeFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        error: "CONFLICTS: lib/foo.ts",
      });

      expect(mocks.logTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          epicId: "epic-1",
          fromStatus: "review",
          toStatus: "review",
          actor: "system",
        })
      );
    });

    it("funnels a mergeWorktree THROW into the same failure path", async () => {
      // getGit can throw before mergeWorktree's try block when the repo
      // directory is gone — the story is already done at that point, so a
      // raw 500 with no trail would strand a half-applied approval.
      mocks.mergeWorktree.mockRejectedValue(
        new Error("Cannot use simple-git on a directory that does not exist")
      );
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toMatchObject({
        approved: true,
        epicComplete: true,
        merged: false,
        mergeError: "Cannot use simple-git on a directory that does not exist",
      });
      expect(epicUpdates()).toEqual([]);
      expect(mocks.createApproveMergeFailedNotification).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "epic-1",
        error: "Cannot use simple-git on a directory that does not exist",
      });
      expect(mocks.endMergeWork).toHaveBeenCalledWith("p1", "epic-1");
    });

    it("keeps the 200 contract when writing the failure trail throws", async () => {
      // SQLITE_BUSY on the trail writes must not turn the contractual 200
      // into a generic 500 — the trail is best-effort.
      mocks.createApproveMergeFailedNotification.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY");
      });
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.mergeError).toBe("CONFLICTS: lib/foo.ts");
      expect(epicUpdates()).toEqual([]);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe("last story approved — nothing to merge", () => {
    it("closes the epic without a merge when it has no branch", async () => {
      seed({ epic: { ...mockEpic, branchName: null } });
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        approved: true,
        epicComplete: true,
        merged: false,
      });
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();

      // The epic still closes through the service, it just has nothing to
      // land — and no branch-name cleanup runs.
      expect(epicCloseCall()).toMatchObject({ toStatus: "done" });
      expect(dbMockState.updateCalls).toEqual([]);
    });

    it("closes the epic without a merge when the project has no git repo", async () => {
      seed({ project: { ...mockProject, gitRepoPath: null } });
      const res = await callApprove();

      const json = await res.json();
      expect(json.data.merged).toBe(false);
      expect(json.data.epicComplete).toBe(true);
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
    });
  });
});