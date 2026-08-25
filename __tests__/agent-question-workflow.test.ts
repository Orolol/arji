/**
 * Workflow effects for the asked_question delivery verdict:
 * `handleAskedQuestionOutcome` must create the "Agent asked a question"
 * notification (deep-linking to the epic) and log a held from==to activity
 * entry with actor "system" — without ever throwing into the caller's
 * background completion block.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

const mockWebhook = vi.hoisted(() => ({
  sendProjectWebhook: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return {
    ...dbModuleMock(),
    sqlite: {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ cnt: 1 })) })),
      exec: vi.fn(),
    },
  };
});

vi.mock("@/lib/webhooks/send", () => ({
  sendProjectWebhook: mockWebhook.sendProjectWebhook,
  durationMsBetween: vi.fn(() => 60000),
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "generated-id"),
}));

const { handleAskedQuestionOutcome, AGENT_ASKED_QUESTION_REASON } =
  await import("@/lib/workflow/agent-question");

function seedSessionContext(overrides: Record<string, unknown> = {}) {
  dbMockState.getQueue.push(
    {
      id: "sess-1",
      projectId: "proj-1",
      epicId: "epic-1",
      status: "completed",
      agentType: "build",
      outcome: "asked_question",
      startedAt: "2026-08-16T09:00:00.000Z",
      endedAt: "2026-08-16T09:05:00.000Z",
      error: null,
      ...overrides,
    },
    { name: "My Project" },
    { title: "Login feature", readableId: "E-proj-003" }
  );
}

beforeEach(() => {
  resetDbMockState();
  vi.clearAllMocks();
});

describe("handleAskedQuestionOutcome", () => {
  it("creates the question notification and a system activity entry", () => {
    seedSessionContext();

    handleAskedQuestionOutcome({
      projectId: "proj-1",
      epicIds: ["epic-1"],
      sessionId: "sess-1",
      ticketStatus: "in_progress",
    });

    expect(dbMockState.insertCalls).toHaveLength(2);

    const notification = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(notification.title).toBe(
      "Agent asked a question on E-proj-003: Login feature"
    );
    expect(notification.targetUrl).toBe("/projects/proj-1?ticket=epic-1");
    expect(notification.status).toBe("completed");
    expect(notification.sessionId).toBe("sess-1");

    const activity = dbMockState.insertCalls[1] as Record<string, unknown>;
    expect(activity).toMatchObject({
      projectId: "proj-1",
      epicId: "epic-1",
      fromStatus: "in_progress",
      toStatus: "in_progress",
      actor: "system",
      reason: AGENT_ASKED_QUESTION_REASON,
      sessionId: "sess-1",
    });
  });

  it("fires the session.completed webhook pointing at the epic", () => {
    seedSessionContext();

    handleAskedQuestionOutcome({
      projectId: "proj-1",
      epicIds: ["epic-1"],
      sessionId: "sess-1",
    });

    expect(mockWebhook.sendProjectWebhook).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        event: "session.completed",
        sessionId: "sess-1",
        path: "/projects/proj-1?ticket=epic-1",
      })
    );
  });

  it("logs one entry per held epic but a single notification (team builds)", () => {
    // Team sessions have no epicId of their own.
    seedSessionContext({ epicId: null });

    handleAskedQuestionOutcome({
      projectId: "proj-1",
      epicIds: ["epic-1", "epic-2", null],
      sessionId: "sess-1",
      ticketStatus: "in_progress",
    });

    // 1 notification + 2 activity entries (nullish epic ignored)
    expect(dbMockState.insertCalls).toHaveLength(3);

    const notification = dbMockState.insertCalls[0] as Record<string, unknown>;
    // No single epic to deep-link: falls back to the session detail.
    expect(notification.targetUrl).toBe("/projects/proj-1/sessions/sess-1");

    const epicIds = dbMockState.insertCalls
      .slice(1)
      .map((call) => (call as Record<string, unknown>).epicId);
    expect(epicIds).toEqual(["epic-1", "epic-2"]);
  });

  it("logs each held epic with its own status (team builds straddling columns)", () => {
    // A team session coordinates several epics; their pullbacks can land in
    // different columns (one returned to in_progress, one whose guarded
    // pullback was refused). A single shared status would stamp a false
    // hold entry on every feed but the first.
    seedSessionContext({ epicId: null });

    handleAskedQuestionOutcome({
      projectId: "proj-1",
      epicIds: ["epic-1", "epic-2", "epic-3"],
      sessionId: "sess-1",
      ticketStatus: "in_progress",
      ticketStatusByEpicId: { "epic-1": "in_progress", "epic-2": "review" },
    });

    const activity = dbMockState.insertCalls
      .slice(1)
      .map((call) => call as Record<string, unknown>);
    expect(
      activity.map((entry) => [entry.epicId, entry.fromStatus, entry.toStatus])
    ).toEqual([
      ["epic-1", "in_progress", "in_progress"],
      ["epic-2", "review", "review"],
      // epic-3 is absent from the map: falls back to ticketStatus.
      ["epic-3", "in_progress", "in_progress"],
    ]);
  });

  it("defaults the held status to in_progress", () => {
    seedSessionContext();

    handleAskedQuestionOutcome({
      projectId: "proj-1",
      epicIds: ["epic-1"],
      sessionId: "sess-1",
    });

    const activity = dbMockState.insertCalls[1] as Record<string, unknown>;
    expect(activity.fromStatus).toBe("in_progress");
    expect(activity.toStatus).toBe("in_progress");
  });

  it("still logs the activity entry when notification creation fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No session row -> notification creator returns without inserting.
    dbMockState.getQueue = [];

    handleAskedQuestionOutcome({
      projectId: "proj-1",
      epicIds: ["epic-1"],
      sessionId: "sess-gone",
      ticketStatus: "review",
    });

    expect(dbMockState.insertCalls).toHaveLength(1);
    expect(dbMockState.insertCalls[0]).toMatchObject({
      actor: "system",
      reason: AGENT_ASKED_QUESTION_REASON,
      fromStatus: "review",
      toStatus: "review",
    });
    warnSpy.mockRestore();
  });
});
