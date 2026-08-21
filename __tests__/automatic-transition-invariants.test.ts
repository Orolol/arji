/**
 * Regression contract for automatic ticket movement. These tests exercise the
 * shared workflow functions used by manual dispatch, pipeline and Full Auto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const askedQuestion = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/events/emit", () => ({ emitTicketMoved: vi.fn() }));
vi.mock("@/lib/workflow/agent-question", () => ({
  handleAskedQuestionOutcome: askedQuestion,
}));

const { db } = await import("@/lib/db");
const {
  agentSessions,
  epics,
  projects,
  ticketActivityLog,
  userStories,
} = await import("@/lib/db/schema");
const {
  finalizeBuildTerminalOutcome,
  transitionBuildStarted,
  transitionReviewRejected,
} = await import("@/lib/workflow/automatic-transitions");
const { createQueuedSession } = await import("@/lib/agent-sessions/lifecycle");

let sequence = 0;

function seedEpic(status: string, storyStatuses: string[] = []) {
  sequence += 1;
  const projectId = `project-${sequence}`;
  const epicId = `epic-${sequence}`;
  db.insert(projects).values({ id: projectId, name: "Transitions" }).run();
  db.insert(epics)
    .values({ id: epicId, projectId, title: "Ticket", status })
    .run();
  const storyIds = storyStatuses.map((storyStatus, index) => {
    const id = `story-${sequence}-${index + 1}`;
    db.insert(userStories)
      .values({ id, epicId, title: `Story ${index + 1}`, status: storyStatus })
      .run();
    return id;
  });
  return { projectId, epicId, storyIds };
}

function epicStatus(epicId: string) {
  return db.select().from(epics).where(eq(epics.id, epicId)).get()?.status;
}

function storyStatus(storyId: string) {
  return db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get()?.status;
}

beforeEach(() => {
  db.delete(ticketActivityLog).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  askedQuestion.mockReset();
});

describe("no orphaned build sessions", () => {
  it("preflights a multi-ticket dispatch without moving the ticket", () => {
    const { projectId, epicId, storyIds } = seedEpic("backlog", ["todo"]);

    transitionBuildStarted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "team-preflight",
      validateOnly: true,
    });

    expect(epicStatus(epicId)).toBe("backlog");
    expect(storyStatus(storyIds[0])).toBe("todo");
  });

  it.each(["backlog", "todo"])(
    "moves an epic from %s to in_progress before its queued session exists",
    (fromStatus) => {
      const { projectId, epicId } = seedEpic(fromStatus);
      const sessionId = `session-${fromStatus}`;

      transitionBuildStarted({
        projectId,
        epicId,
        scope: "epic",
        sessionId,
      });
      expect(epicStatus(epicId)).toBe("in_progress");

      createQueuedSession({
        id: sessionId,
        projectId,
        epicId,
        agentType: "build",
        mode: "code",
      });
      expect(
        db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
      ).toMatchObject({ status: "queued", epicId });
      expect(epicStatus(epicId)).toBe("in_progress");
    }
  );

  it("moves a story and its backlog parent together before dispatch", () => {
    const { projectId, epicId, storyIds } = seedEpic("backlog", ["todo"]);
    transitionBuildStarted({
      projectId,
      epicId,
      scope: "story",
      userStoryId: storyIds[0],
      sessionId: "story-build",
    });

    expect(epicStatus(epicId)).toBe("in_progress");
    expect(storyStatus(storyIds[0])).toBe("in_progress");
  });
});

describe("deterministic build completion", () => {
  it.each([
    ["successful legacy outcome", null],
    ["answered outcome", "answered"],
  ])("promotes an epic after a %s", (_label, outcome) => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
    ]);
    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: `terminal-${String(outcome)}`,
      success: true,
      outcome,
    });

    expect(result.kind).toBe("promoted");
    expect(epicStatus(epicId)).toBe("review");
    expect(storyStatus(storyIds[0])).toBe("review");
  });

  it("reproduces B-arij-104: holds the epic with an explicit remaining-stories reason", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
      "todo",
    ]);
    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "story",
      userStoryId: storyIds[0],
      sessionId: "b-arij-104",
      success: true,
      outcome: "answered",
    });

    expect(result).toMatchObject({
      kind: "promoted",
      epicPromoted: false,
      remainingStories: 1,
    });
    expect(storyStatus(storyIds[0])).toBe("review");
    expect(epicStatus(epicId)).toBe("in_progress");
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activity).toContainEqual(
      expect.objectContaining({
        fromStatus: "in_progress",
        toStatus: "in_progress",
        reason: expect.stringContaining("1 story remains before epic review"),
        sessionId: "b-arij-104",
      })
    );
  });

  it("promotes the epic when the last incomplete story reaches review", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
      "done",
    ]);
    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "story",
      userStoryId: storyIds[0],
      sessionId: "last-story",
      success: true,
      outcome: "answered",
    });

    expect(result).toMatchObject({ kind: "promoted", epicPromoted: true });
    expect(epicStatus(epicId)).toBe("review");
  });

  it("keeps an errored build in progress and records why", () => {
    const { projectId, epicId } = seedEpic("in_progress");
    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "failed-build",
      success: false,
      outcome: "error",
      error: "CLI exited 1",
    });

    expect(result.kind).toBe("failed");
    expect(epicStatus(epicId)).toBe("in_progress");
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, epicId))
        .all()
    ).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("CLI exited 1") })
    );
  });

  it("keeps asked_question work in progress and invokes the reply hold", () => {
    const { projectId, epicId } = seedEpic("in_progress");
    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "asked-build",
      success: true,
      outcome: "asked_question",
    });

    expect(result.kind).toBe("awaiting_reply");
    expect(epicStatus(epicId)).toBe("in_progress");
    expect(askedQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "asked-build", ticketStatus: "in_progress" })
    );
  });
});

it("moves a rejected review back to in_progress without an active agent", () => {
  const { projectId, epicId, storyIds } = seedEpic("review", ["review"]);
  transitionReviewRejected({
    projectId,
    epicId,
    scope: "epic",
    sessionId: "completed-review",
    reason: "Review verdict: changes requested",
  });
  expect(epicStatus(epicId)).toBe("in_progress");
  expect(storyStatus(storyIds[0])).toBe("in_progress");
});
