/**
 * End-to-end workflow test for the asked_question delivery verdict on the
 * epic build route, against the real migrated schema (createTestDb):
 *
 *   - the ticket does NOT advance to review (stays in_progress),
 *   - exactly one "Agent asked a question" notification is created,
 *     deep-linking to the epic (no duplicate from emitSessionCompleted),
 *   - the hold decision is logged to ticket_activity_log (actor system),
 *   - the session row carries outcome = asked_question.
 *
 * A control case verifies the answered path still advances to review.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const processManagerState = vi.hoisted(() => ({
  result: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/pipeline", () => ({
  resolvePipelineEnabled: vi.fn(() => false),
  startPipelineRun: vi.fn(() => ({ runId: "run-test" })),
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/epic-question-test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerState.result,
    })),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: vi.fn(() => null),
  createAgentAlreadyRunningPayload: vi.fn(() => ({})),
}));

vi.mock("@/lib/events/emit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/events/emit")>(
    "@/lib/events/emit"
  );
  return {
    ...actual,
    emitSessionCompleted: vi.fn(actual.emitSessionCompleted),
    emitSessionFailed: vi.fn(actual.emitSessionFailed),
  };
});

vi.mock("fs", () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn(() => false) },
}));

const { db, sqlite } = await import("@/lib/db");
const {
  projects,
  epics,
  userStories,
  agentSessions,
  notifications,
  ticketActivityLog,
  ticketComments,
} = await import("@/lib/db/schema");
const { POST } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
);
const { emitSessionCompleted, emitSessionFailed } = await import(
  "@/lib/events/emit"
);

let counter = 0;

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function seedEpic() {
  counter += 1;
  const projectId = `proj-q-${counter}`;
  const epicId = `epic-q-${counter}`;
  const storyId = `story-q-${counter}`;

  db.insert(projects)
    .values({ id: projectId, name: "Question Project", gitRepoPath: "/repos/q" })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Login feature",
      status: "todo",
      position: 0,
      readableId: `E-q-${counter}`,
    })
    .run();
  db.insert(userStories)
    .values({
      id: storyId,
      epicId,
      title: "As a user I want to log in",
      status: "todo",
      position: 0,
    })
    .run();

  return { projectId, epicId, storyId };
}

async function dispatchBuild(projectId: string, epicId: string) {
  const res = await POST(
    mockJsonRequest({}),
    mockRouteContext({ projectId, epicId })
  );
  const json = await res.json();
  expect(res.status).toBe(200);
  await flushBackground();
  return json.data.sessionId as string;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("epic build route — asked_question workflow effects", () => {
  it("holds the ticket, notifies once with an epic deep link, and logs the decision", async () => {
    const { projectId, epicId, storyId } = seedEpic();
    processManagerState.result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Should the login flow support SSO?",
      }),
      endedWithQuestion: true,
      duration: 30000,
    };

    const sessionId = await dispatchBuild(projectId, epicId);

    // Session row: completed with the asked_question verdict.
    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    expect(session).toMatchObject({
      status: "completed",
      outcome: "asked_question",
    });

    // Ticket held: epic and story stay in_progress, never review.
    const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
    expect(epic!.status).toBe("in_progress");
    const story = db
      .select()
      .from(userStories)
      .where(eq(userStories.id, storyId))
      .get();
    expect(story!.status).toBe("in_progress");

    // Exactly one notification — the question one, deep-linking to the epic
    // (the generic completed notification is suppressed for this verdict).
    const notifs = db.select().from(notifications).all();
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      projectId,
      sessionId,
      status: "completed",
      targetUrl: `/projects/${projectId}?ticket=${epicId}`,
    });
    expect(notifs[0].title).toBe(
      `Agent asked a question on E-q-${counter}: Login feature`
    );

    // Activity log: the dispatch entry plus the system hold entry.
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    const holdEntry = activity.find((a) => a.actor === "system");
    expect(holdEntry).toMatchObject({
      projectId,
      epicId,
      fromStatus: "in_progress",
      toStatus: "in_progress",
      actor: "system",
      reason: "Agent asked a question",
      sessionId,
    });

    // The question still lands as the agent's comment on the epic.
    const comments = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, epicId))
      .all();
    expect(
      comments.some(
        (c) =>
          c.author === "agent" &&
          c.content.includes("Should the login flow support SSO?")
      )
    ).toBe(true);
  });

  it("still advances answered builds to review with no question effects", async () => {
    const { projectId, epicId } = seedEpic();
    processManagerState.result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Implemented login; 14 tests passing.",
      }),
      duration: 30000,
    };

    const sessionId = await dispatchBuild(projectId, epicId);

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    expect(session).toMatchObject({ status: "completed", outcome: "answered" });

    const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
    expect(epic!.status).toBe("review");

    // Generic completed notification, targeting the session detail.
    const notifs = db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toContain("Build completed");
    expect(notifs[0].targetUrl).toBe(`/projects/${projectId}/sessions/${sessionId}`);

    // No system hold entry for this epic.
    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activity.some((a) => a.actor === "system")).toBe(false);
  });

  it("advances the ticket and preserves agent output when finalization leaves the build running", async () => {
    // The session row is left 'running' because the terminal write failed.
    // The terminal handler acts for that owning session, whose
    // in_progress → review promotion is now permitted: the work is committed
    // and no other mover is live on the ticket.
    const { projectId, epicId } = seedEpic();
    processManagerState.result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Implementation finished even though lifecycle persistence failed.",
      }),
      duration: 30000,
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sqlite.exec(`
      CREATE TRIGGER fail_completed_session_update
      BEFORE UPDATE OF status ON agent_sessions
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'forced terminal write failure');
      END;
    `);

    try {
      const sessionId = await dispatchBuild(projectId, epicId);

      expect(
        db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
      ).toMatchObject({ status: "running" });
      expect(
        db.select().from(epics).where(eq(epics.id, epicId)).get()?.status
      ).toBe("review");

      const comments = db
        .select()
        .from(ticketComments)
        .where(eq(ticketComments.epicId, epicId))
        .all();
      expect(comments).toContainEqual(
        expect.objectContaining({
          agentSessionId: sessionId,
          content: "Implementation finished even though lifecycle persistence failed.",
        })
      );

      const activity = db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, epicId))
        .all();
      expect(activity).toContainEqual(
        expect.objectContaining({
          sessionId,
          reason: "Build completed successfully",
          fromStatus: "in_progress",
          toStatus: "review",
        })
      );
      expect(emitSessionCompleted).toHaveBeenCalledWith(
        projectId,
        epicId,
        sessionId
      );
      expect(emitSessionFailed).not.toHaveBeenCalled();
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS fail_completed_session_update");
      errorSpy.mockRestore();
    }
  });
});
