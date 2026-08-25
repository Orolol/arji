/**
 * Regression contract for automatic ticket movement. These tests exercise the
 * shared workflow functions used by manual dispatch, pipeline and Full Auto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const askedQuestion = vi.hoisted(() => vi.fn());
const emitTicketMoved = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/events/emit", () => ({ emitTicketMoved }));
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
  transitionBuildCompleted,
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
  emitTicketMoved.mockReset();
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

  it("keeps a story added mid-build in todo without blocking epic review", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
      "todo",
    ]);

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "mid-build-story",
      success: true,
      outcome: "answered",
    });

    expect(result).toMatchObject({ kind: "promoted", epicPromoted: true });
    expect(epicStatus(epicId)).toBe("review");
    expect(storyStatus(storyIds[0])).toBe("review");
    expect(storyStatus(storyIds[1])).toBe("todo");
  });

  it("persists a refused outcome when another build still owns the ticket", () => {
    const { projectId, epicId } = seedEpic("in_progress");
    db.insert(agentSessions)
      .values([
        {
          id: "completed-terminal-session",
          projectId,
          epicId,
          status: "completed",
          outcome: "answered",
          agentType: "build",
          mode: "code",
        },
        {
          id: "other-active-session",
          projectId,
          epicId,
          status: "running",
          agentType: "build",
          mode: "code",
        },
      ])
      .run();

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "completed-terminal-session",
      success: true,
      outcome: "answered",
    });

    expect(result).toMatchObject({
      kind: "refused",
      error: expect.stringContaining("queued or running"),
    });
    expect(epicStatus(epicId)).toBe("in_progress");
    expect(
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, "completed-terminal-session"))
        .get()
    ).toMatchObject({
      status: "completed",
      outcome: "transition_refused",
      error: expect.stringContaining("queued or running"),
    });
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, epicId))
        .all()
    ).toContainEqual(
      expect.objectContaining({
        fromStatus: "in_progress",
        toStatus: "in_progress",
        reason: expect.stringContaining("review promotion was refused"),
        sessionId: "completed-terminal-session",
      })
    );
  });

  it("uses the persisted epic status and never revives a released ticket", () => {
    const { projectId, epicId } = seedEpic("released");

    const result = transitionBuildCompleted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "late-terminal-retry",
    });

    expect(result).toMatchObject({
      valid: false,
      error: expect.stringContaining("released"),
    });
    expect(epicStatus(epicId)).toBe("released");
  });

  it("isolates team-build promotion refusals so later epics still advance", () => {
    const blocked = seedEpic("in_progress");
    const promotable = seedEpic("in_progress", ["in_progress"]);
    db.insert(agentSessions)
      .values({
        id: "other-active-build",
        projectId: blocked.projectId,
        epicId: blocked.epicId,
        status: "queued",
        agentType: "ticket_build",
        mode: "code",
      })
      .run();

    const results = [blocked, promotable].map(({ projectId, epicId }) =>
      transitionBuildCompleted({
        projectId,
        epicId,
        scope: "epic",
        sessionId: "team-terminal",
        reason: "Team build completed successfully",
      })
    );

    expect(results[0]).toMatchObject({ valid: false });
    expect(results[1]).toMatchObject({ valid: true, epicPromoted: true });
    expect(epicStatus(blocked.epicId)).toBe("in_progress");
    expect(epicStatus(promotable.epicId)).toBe("review");
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

describe("terminal rollback of mid-run review promotions", () => {
  // The owning-session exemption lets a live build move its own ticket to
  // Review before settling. When the run then ends without delivering, the
  // ticket must not stay parked in Review and the hold entry must name the
  // status it actually holds.

  function seedRunningBuild(projectId: string, epicId: string, sessionId: string, userStoryId?: string) {
    db.insert(agentSessions)
      .values({
        id: sessionId,
        projectId,
        epicId,
        userStoryId: userStoryId ?? null,
        status: "running",
        agentType: userStoryId ? "ticket_build" : "build",
        mode: "code",
      })
      .run();
  }

  it("pulls a failed epic build's ticket back out of review", () => {
    const { projectId, epicId } = seedEpic("in_progress");
    seedRunningBuild(projectId, epicId, "rolled-back-failure");
    // The agent promoted its own ticket mid-run (owning-session exemption).
    db.update(epics).set({ status: "review" }).where(eq(epics.id, epicId)).run();

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "rolled-back-failure",
      success: false,
      outcome: "error",
      error: "tests exploded",
    });

    expect(result.kind).toBe("failed");
    expect(epicStatus(epicId)).toBe("in_progress");

    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    // The pullback is audited as a real transition…
    expect(activity).toContainEqual(
      expect.objectContaining({
        fromStatus: "review",
        toStatus: "in_progress",
        actor: "agent",
        sessionId: "rolled-back-failure",
        reason: expect.stringContaining("tests exploded"),
      })
    );
    // …and the hold entry names the status it actually held.
    expect(activity).toContainEqual(
      expect.objectContaining({
        fromStatus: "in_progress",
        toStatus: "in_progress",
        reason: expect.stringContaining("ticket held in in_progress"),
      })
    );
  });

  it("pulls a failed story build's story back out of review without touching the epic", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", ["in_progress", "todo"]);
    seedRunningBuild(projectId, epicId, "story-fail", storyIds[0]);
    // The story agent promoted its own story mid-run.
    db.update(userStories).set({ status: "review" }).where(eq(userStories.id, storyIds[0])).run();

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "story",
      userStoryId: storyIds[0],
      sessionId: "story-fail",
      success: false,
      outcome: "error",
      error: "story tests exploded",
    });

    expect(result.kind).toBe("failed");
    // The story comes back; the epic and its sibling never move.
    expect(storyStatus(storyIds[0])).toBe("in_progress");
    expect(storyStatus(storyIds[1])).toBe("todo");
    expect(epicStatus(epicId)).toBe("in_progress");
  });

  it("returns the ticket before recording an open-question hold", () => {
    const { projectId, epicId } = seedEpic("in_progress");
    seedRunningBuild(projectId, epicId, "question-rollback");
    db.update(epics).set({ status: "review" }).where(eq(epics.id, epicId)).run();

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "question-rollback",
      success: true,
      outcome: "asked_question",
    });

    expect(result.kind).toBe("awaiting_reply");
    expect(epicStatus(epicId)).toBe("in_progress");
    expect(askedQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "question-rollback", ticketStatus: "in_progress" })
    );
  });

  it("survives a throwing pullback on the failure path", () => {
    // The failure handler runs inside a background completion block that does
    // not wrap it (see agent-question.ts): a throw here would reject
    // runBuildSession and lose the agent's output comment. emitTicketMoved is
    // the realistic thrower — applyTransition calls it unguarded after the
    // status write.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { projectId, epicId } = seedEpic("in_progress");
    seedRunningBuild(projectId, epicId, "emit-blows-up");
    db.update(epics).set({ status: "review" }).where(eq(epics.id, epicId)).run();
    emitTicketMoved.mockImplementationOnce(() => {
      throw new Error("SSE bus down");
    });

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "emit-blows-up",
      success: false,
      outcome: "error",
      error: "tests exploded",
    });

    expect(result.kind).toBe("failed");
    expect(warnSpy).toHaveBeenCalled();
    // The status write landed before the emit threw, so the degraded reader
    // reports the real column and the hold entry stays truthful.
    expect(epicStatus(epicId)).toBe("in_progress");
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activity).toContainEqual(
      expect.objectContaining({
        reason: expect.stringContaining("ticket held in in_progress"),
      })
    );
    warnSpy.mockRestore();
  });

  it("survives a throwing pullback on the open-question path", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { projectId, epicId } = seedEpic("in_progress");
    seedRunningBuild(projectId, epicId, "question-emit-blows-up");
    db.update(epics).set({ status: "review" }).where(eq(epics.id, epicId)).run();
    emitTicketMoved.mockImplementationOnce(() => {
      throw new Error("SSE bus down");
    });

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "question-emit-blows-up",
      success: true,
      outcome: "asked_question",
    });

    // The reply hold and its notification still happen.
    expect(result.kind).toBe("awaiting_reply");
    expect(askedQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "question-emit-blows-up",
        ticketStatus: "in_progress",
      })
    );
    warnSpy.mockRestore();
  });

  it("names the real status in the hold entry when the ticket never left its column", () => {
    // A ticket found outside in_progress/review (weird pre-existing state)
    // is left alone — and the hold entry says where it really is.
    const { projectId, epicId } = seedEpic("todo");
    seedRunningBuild(projectId, epicId, "odd-state-failure");

    const result = finalizeBuildTerminalOutcome({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "odd-state-failure",
      success: false,
      outcome: "error",
      error: "CLI vanished",
    });

    expect(result.kind).toBe("failed");
    expect(epicStatus(epicId)).toBe("todo");
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activity).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("ticket held in todo") })
    );
    expect(activity).not.toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("ticket held in in_progress") })
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
