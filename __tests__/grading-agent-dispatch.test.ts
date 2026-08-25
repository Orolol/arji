/**
 * Grader-agent dispatch contract against the real migrated schema.
 *
 * The CLI and worktree manager are the only fakes: dispatch itself writes a
 * real queued session row, uses the real scheduler/lifecycle, and records the
 * no-op in the real ticket activity table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const resolutionMocks = vi.hoisted(() => ({
  resolveAgentForDispatch: vi.fn(async () => ({
    provider: "codex",
    namedAgentId: null as string | null,
    name: null as string | null,
    model: null as string | null,
    segregated: true,
    builderProvider: "claude-code",
  })),
}));

const processManagerState = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null,
  onStart: null as ((sessionId: string) => void) | null,
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/grading-worktree",
    branchName: "feature/grading-test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn((sessionId: string) => processManagerState.onStart?.(sessionId)),
    getStatus: vi.fn(() => processManagerState.status),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("Grade objectively."),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentForDispatch: resolutionMocks.resolveAgentForDispatch,
}));

vi.mock("@/lib/events/emit", () => ({
  emitSessionStarted: vi.fn(),
  emitSessionCompleted: vi.fn(),
  emitSessionFailed: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

const { db } = await import("@/lib/db");
const {
  projects,
  epics,
  userStories,
  agentSessions,
  gradingReports,
  ticketActivityLog,
} = await import("@/lib/db/schema");
const { processManager } = await import("@/lib/claude/process-manager");
const { POST } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/grading/route"
);
const { dispatchGradingSession } = await import("@/lib/grading/dispatch");
const { AGENT_TYPE_LABELS, isAgentType } = await import(
  "@/lib/agent-config/constants"
);

let counter = 0;

function seedEpic(criteria: Array<string | null>) {
  counter += 1;
  const projectId = `project-grading-${counter}`;
  const epicId = `epic-grading-${counter}`;

  db.insert(projects)
    .values({
      id: projectId,
      name: "Grading Project",
      gitRepoPath: "/repos/grading",
      spec: "Acceptance evidence must be concrete.",
    })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Structured outcomes",
      status: "review",
      position: 0,
      readableId: `E-grade-${counter}`,
    })
    .run();

  const storyIds = criteria.map((acceptanceCriteria, index) => {
    const id = `story-grading-${counter}-${index}`;
    db.insert(userStories)
      .values({
        id,
        epicId,
        title: `Story ${index + 1}`,
        acceptanceCriteria,
        status: "review",
        position: index,
      })
      .run();
    return id;
  });

  return { projectId, epicId, storyIds };
}

beforeEach(() => {
  vi.clearAllMocks();
  processManagerState.status = null;
  processManagerState.onStart = null;
});

describe("manual grading dispatch", () => {
  it("registers grading as a first-class agent type", () => {
    expect(isAgentType("grading")).toBe(true);
    expect(AGENT_TYPE_LABELS.grading).toBe("Acceptance Grading");
  });

  it.each([
    ["no user stories", [] as Array<string | null>],
    ["no non-empty acceptance criteria", [null, "   "]],
  ])("journals a successful no-op for an epic with %s", async (_label, criteria) => {
    const { projectId, epicId } = seedEpic(criteria);

    const response = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ skipped: true });
    expect(json.data.reason).toContain("Grading skipped");

    const sessions = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.epicId, epicId))
      .all();
    expect(sessions).toHaveLength(0);

    const activities = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, epicId))
      .all();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      fromStatus: "review",
      toStatus: "review",
      actor: "system",
    });
    expect(activities[0].reason).toContain("Grading skipped");

    const { createWorktree } = await import("@/lib/git/manager");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(resolutionMocks.resolveAgentForDispatch).not.toHaveBeenCalled();
  });

  it("starts a segregated plan-mode grading session with story IDs and criteria", async () => {
    const { projectId, epicId, storyIds } = seedEpic([
      "- The API rejects invalid states\n- The report includes evidence",
    ]);

    const response = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId, epicId })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      skipped: false,
      provider: "codex",
      segregated: true,
      builderProvider: "claude-code",
    });

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, json.data.sessionId))
      .get();
    expect(session).toMatchObject({
      projectId,
      epicId,
      agentType: "grading",
      mode: "plan",
      provider: "codex",
      worktreePath: "/tmp/grading-worktree",
      branchName: "feature/grading-test",
    });
    expect(session?.prompt).toContain(storyIds[0]);
    expect(session?.prompt).toContain("The API rejects invalid states");
    expect(session?.prompt).toContain("submit_grading");
    expect(session?.prompt).toContain("MUST call");

    expect(resolutionMocks.resolveAgentForDispatch).toHaveBeenCalledWith(
      "grading",
      projectId,
      null,
      { purpose: "grading", projectId, epicId }
    );
    expect(processManager.start).toHaveBeenCalledWith(
      json.data.sessionId,
      expect.objectContaining({
        mode: "plan",
        cwd: "/tmp/grading-worktree",
      }),
      "codex"
    );

    const unchangedEpic = db
      .select()
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    expect(unchangedEpic?.status).toBe("review");
  });

  it("only completes successfully when submit_grading saved a report", async () => {
    const { projectId, epicId, storyIds } = seedEpic(["- The flow works"]);
    processManagerState.onStart = (sessionId) => {
      db.insert(gradingReports)
        .values({
          id: `report-${counter}`,
          epicId,
          agentSessionId: sessionId,
          gradings: JSON.stringify([
            {
              storyId: storyIds[0],
              criterion: "The flow works",
              status: "met",
              evidence: "Focused test passed.",
            },
          ]),
          summary: "All criteria met.",
          createdAt: new Date().toISOString(),
        })
        .run();
    };
    processManagerState.status = {
      status: "completed",
      result: {
        success: true,
        result: JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Structured grading submitted.",
        }),
      },
    };

    const handle = await dispatchGradingSession({ projectId, epicId });
    expect(handle.skipped).toBe(false);
    if (handle.skipped) throw new Error("Expected a grading session");

    const terminal = await handle.settled;
    expect(terminal).toMatchObject({
      success: true,
      outcome: "answered",
      error: null,
      reportId: `report-${counter}`,
    });

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, handle.sessionId))
      .get();
    expect(session?.status).toBe("completed");
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, epicId))
        .all(),
    ).toHaveLength(0);
  });
});
