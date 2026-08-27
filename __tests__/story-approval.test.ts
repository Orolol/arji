/**
 * Tests for the user-story approve route.
 *
 * Contract: approving a story is a review verdict on that story ALONE. The
 * story goes done through the transition service (source "approve", the
 * explicit human decision that needs no separate review-agent session), and
 * nothing else moves: no git, no merge, no epic close. The parent epic
 * reaches Done exclusively through its merge (to_merge → done) — when the
 * approval closed the last open story, the route records a decision line
 * saying exactly that instead of merging anything.
 *
 * The mergeWorktree / notification / registry mocks stay in place as
 * regression tripwires: if the merge ever creeps back into this route, the
 * not-called assertions below are what catches it.
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
  applyStoryTransition: vi.fn(),
  logWorkflowDecision: vi.fn(),
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
  applyStoryTransition: mocks.applyStoryTransition,
  logWorkflowDecision: mocks.logWorkflowDecision,
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

/**
 * Seed the db-mock queues in the route's read order:
 *   get #1 → { story } (getStoryOr404's joined row shape),
 *   get #2 → epic (the epicComplete bookkeeping),
 *   all #1 → sibling stories.
 * No project read, no session read: the route never touches git.
 */
function seed({
  story = mockStory,
  epic = mockEpic,
  siblings = [mockStory],
}: {
  story?: Record<string, unknown>;
  epic?: Record<string, unknown> | null;
  siblings?: Record<string, unknown>[];
} = {}) {
  dbMockState.getQueue.push({ story }, epic);
  dbMockState.allQueue.push(siblings);
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

describe("Story approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mocks.mergeWorktree.mockResolvedValue({ merged: true, commitHash: "abc123" });
    mocks.applyStoryTransition.mockReturnValue({ valid: true });
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
    // The story verdict is the service's write (validated first, then
    // applied); the epic row is untouched and nothing else runs.
    expect(mocks.applyStoryTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        userStoryId: "us-1",
        fromStatus: "review",
        toStatus: "done",
        source: "approve",
        actor: "user",
        // Explicit human approval IS the review decision for the story.
        requireCompletedReview: false,
      })
    );
    expect(mocks.mergeWorktree).not.toHaveBeenCalled();
    expect(mocks.logWorkflowDecision).not.toHaveBeenCalled();
    expect(dbMockState.updateCalls).toEqual([]);
    expect(mocks.tryExportArjiJson).toHaveBeenCalledWith("p1");
  });

  it("reports the engine's refusal of the story close as a 400", async () => {
    mocks.applyStoryTransition.mockReturnValue({
      valid: false,
      error: "Cannot move while a build session is queued or running.",
    });
    seed();
    const res = await callApprove();

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("queued or running");
    expect(dbMockState.updateCalls).toEqual([]);
    expect(mocks.tryExportArjiJson).not.toHaveBeenCalled();
  });

  describe("last story approved — the epic stays put", () => {
    it("closes only the story and reports epicComplete without merging", async () => {
      seed();
      const res = await callApprove();

      expect(res.status).toBe(200);
      const json = await res.json();
      // No `mergeError`, no `commitHash`: the response shape itself says the
      // route has no merge to report on.
      expect(json.data).toEqual({
        approved: true,
        epicComplete: true,
        merged: false,
      });

      // Nothing git- or epic-related ran: the epic closes through its own
      // merge route, never through a story approval.
      expect(mocks.mergeWorktree).not.toHaveBeenCalled();
      expect(mocks.beginMergeWork).not.toHaveBeenCalled();
      expect(mocks.createApproveMergeFailedNotification).not.toHaveBeenCalled();
      expect(dbMockState.updateCalls).toEqual([]);
      expect(dbMockState.insertCalls).toEqual([]);
    });

    it("records the decision line pointing at the merge instead of moving the epic", async () => {
      seed();
      await callApprove();

      expect(mocks.logWorkflowDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          epicId: "epic-1",
          status: "review",
          actor: "user",
          reason: expect.stringContaining("closes through its merge"),
        })
      );
    });

    it("counts done siblings as closed when deciding epicComplete", async () => {
      seed({
        siblings: [mockStory, { id: "us-2", epicId: "epic-1", status: "done" }],
      });
      const res = await callApprove();

      const json = await res.json();
      expect(json.data.epicComplete).toBe(true);
      expect(mocks.logWorkflowDecision).toHaveBeenCalled();
    });

    it("keeps the epic's own status in the decision line, whatever column it is in", async () => {
      // A story approved late, after the epic already reached the merge
      // boundary: the decision line must name the real column.
      seed({ epic: { ...mockEpic, status: "to_merge" } });
      await callApprove();

      expect(mocks.logWorkflowDecision).toHaveBeenCalledWith(
        expect.objectContaining({ status: "to_merge" })
      );
    });
  });
});
