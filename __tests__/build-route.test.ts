/**
 * Tests for the batch build route's team mode and provider parameter handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call counts to return different values for sequential .get() calls
let getCallCount = 0;
const mockState = vi.hoisted(() => ({
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  epicStatus: "todo",
  processManagerResult: {
    success: true,
    duration: 1000,
  } as {
    success: boolean;
    duration: number;
    result?: string;
    error?: string;
    endedWithQuestion?: boolean;
  },
}));

const mockResolveAgentByNamedId = vi.hoisted(() =>
  vi.fn(() => ({ provider: "claude-code" })),
);

const mockHandleAskedQuestionOutcome = vi.hoisted(() => vi.fn());
const mockMarkSessionTerminal = vi.hoisted(() => vi.fn());
const mockPullTicketBackIfPromoted = vi.hoisted(() =>
  vi.fn(() => "in_progress" as string)
);

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    // `buildTransitionContext` reads the epic's session facts through a
    // projected subquery (`.as`) that it then groups.
    groupBy: vi.fn().mockReturnThis(),
    as: vi.fn().mockReturnThis(),
    get: vi.fn(() => {
      getCallCount++;
      // Call 1: project lookup → return project
      // Call 2+: epic/story lookups → return epic-like object
      if (getCallCount === 1) {
        return {
          id: "proj-1",
          name: "Test",
          gitRepoPath: "/repos/test",
          status: "building",
        };
      }
      // Remaining get() calls return epic-like objects
      return {
        id: "epic-1",
        title: "Test Epic",
        description: "A test epic",
        epicId: "epic-1",
        status: mockState.epicStatus,
      };
    }),
    all: vi.fn().mockReturnValue([]),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
    update: vi.fn((table: { _name?: string } | string) => {
      const tableName =
        typeof table === "string" ? table : table?._name ?? "unknown";
      return {
        set: vi.fn((values: Record<string, unknown>) => {
          mockState.updateCalls.push({ table: tableName, values });
          if (tableName === "epics" && typeof values.status === "string") {
            mockState.epicStatus = values.status;
          }
          return {
            where: vi.fn().mockReturnValue({ run: vi.fn() }),
          };
        }),
      };
    }),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  projects: { _name: "projects" },
  epics: { _name: "epics", id: "id", epicId: "epicId", projectId: "projectId", position: "position", status: "status" },
  userStories: { _name: "userStories", id: "id", epicId: "epicId", position: "position", status: "status" },
  documents: { projectId: "projectId" },
  agentSessions: { id: "id", epicId: "epicId", userStoryId: "userStoryId", mode: "mode", status: "status", agentType: "agentType" },
  reviewComments: {
    epicId: "epicId",
    status: "status",
    // Read by `cleanReviewVerdictSql`: findings rows of a session's own prove
    // its submit_findings channel worked.
    agentSessionId: "agentSessionId",
  },
  // Same rule reads the mcp_tools_enabled toggle to reconstruct the channel
  // of session rows written before `agent_sessions.mcp_channel` existed. It
  // is read while the facts query is BUILT, so it fires on every
  // buildTransitionContext, not only when a row needs the fallback.
  settings: { _name: "settings", key: "key", value: "value" },
  ticketActivityLog: { _name: "ticketActivityLog" },
  ticketComments: { userStoryId: "userStoryId", createdAt: "createdAt" },
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "test-session-id"),
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/epic-abc-test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn().mockReturnValue({
      sessionId: "test",
      status: "running",
      startedAt: new Date(),
    }),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: mockState.processManagerResult,
    })),
  },
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: vi.fn().mockReturnValue("solo prompt"),
  buildTeamBuildPrompt: vi.fn().mockReturnValue("team prompt"),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("resolved system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: mockMarkSessionTerminal,
  isSessionLifecycleConflictError: vi.fn(() => false),
  isSessionNotFoundError: vi.fn(() => false),
  recordSessionTransitionRefusal: vi.fn(),
}));

vi.mock("@/lib/workflow/agent-question", () => ({
  handleAskedQuestionOutcome: mockHandleAskedQuestionOutcome,
}));

// Only the pullback is stubbed: the team asked_question branch must log each
// coordinated epic with the status its own pullback actually left it in.
vi.mock("@/lib/workflow/automatic-transitions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/workflow/automatic-transitions")
    >();
  return { ...actual, pullTicketBackIfPromoted: mockPullTicketBackIfPromoted };
});

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join("/")),
  },
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 50));
}

describe("Build Route", () => {
  beforeEach(() => {
    getCallCount = 0;
    mockState.updateCalls = [];
    mockState.epicStatus = "todo";
    mockState.processManagerResult = { success: true, duration: 1000 };
    mockResolveAgentByNamedId.mockReturnValue({ provider: "claude-code" });
    mockHandleAskedQuestionOutcome.mockClear();
    mockMarkSessionTerminal.mockClear();
    mockPullTicketBackIfPromoted.mockClear();
    mockPullTicketBackIfPromoted.mockReturnValue("in_progress");
  });

  it("rejects team mode when resolved provider is not claude-code", async () => {
    mockResolveAgentByNamedId.mockReturnValue({ provider: "codex" });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(
      mockRequest({
        epicIds: ["epic-1", "epic-2"],
        team: true,
      }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain(
      "Team mode is only available with Claude Code"
    );
    expect(mockState.updateCalls).toEqual([]);
  });

  it("rejects empty epicIds", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(mockRequest({ epicIds: [] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain("epicIds array is required");
  });

  it("accepts team=true with claude-code provider", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(
      mockRequest({
        epicIds: ["epic-1", "epic-2"],
        team: true,
        provider: "claude-code",
      }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.orchestrationMode).toBe("team");
  });

  it("defaults to solo mode when team is not specified", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(mockRequest({ epicIds: ["epic-1"] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.orchestrationMode).toBe("solo");
  });

  it("uses resolved provider for solo mode", async () => {
    mockResolveAgentByNamedId.mockReturnValue({ provider: "codex" });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(
      mockRequest({ epicIds: ["epic-1"] }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.orchestrationMode).toBe("solo");
    expect(mockResolveAgentByNamedId).toHaveBeenCalledWith("build", "proj-1", null);
  });

  it("defaults provider to claude-code via resolveAgentByNamedId", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(mockRequest({ epicIds: ["epic-1"] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toBeDefined();
    expect(mockResolveAgentByNamedId).toHaveBeenCalledWith("build", "proj-1", null);
  });

  it("keeps statuses in progress when build ended with a question", async () => {
    mockState.processManagerResult = {
      success: true,
      duration: 1000,
      result: "Need clarification before continuing",
      endedWithQuestion: true,
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(mockRequest({ epicIds: ["epic-1"] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    const reviewUpdates = mockState.updateCalls.filter(
      (u) => u.values.status === "review"
    );
    expect(reviewUpdates).toHaveLength(0);
  });

  it("holds a team build's coordinated epic at the status its pullback really left", async () => {
    mockState.processManagerResult = {
      success: true,
      duration: 1000,
      result: "Which auth provider should the team use?",
      endedWithQuestion: true,
    };
    // The guarded pullback was refused, so the epic is still in review — the
    // hold entry must say so rather than assume in_progress.
    mockPullTicketBackIfPromoted.mockReturnValue("review");

    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(
      mockRequest({ epicIds: ["epic-1"], team: true, provider: "claude-code" }),
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    expect(mockPullTicketBackIfPromoted).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "epic-1", scope: "epic" })
    );
    expect(mockHandleAskedQuestionOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        sessionId: "test-session-id",
        ticketStatusByEpicId: { "epic-1": "review" },
      })
    );
    // The old hardcoded hold status is gone, not merely shadowed.
    const call = mockHandleAskedQuestionOutcome.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(call.ticketStatus).toBeUndefined();
  });

  it("persists the asked_question verdict and fires the workflow effects", async () => {
    mockState.processManagerResult = {
      success: true,
      duration: 1000,
      result: "Which auth provider should I integrate?",
      endedWithQuestion: true,
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(mockRequest({ epicIds: ["epic-1"] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    // The verdict is threaded through markSessionTerminal...
    expect(mockMarkSessionTerminal).toHaveBeenCalledWith(
      "test-session-id",
      expect.objectContaining({ success: true, outcome: "asked_question" }),
      expect.any(String)
    );

    // ...and the shared asked-question effects run for the held epic.
    expect(mockHandleAskedQuestionOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        epicIds: ["epic-1"],
        sessionId: "test-session-id",
        ticketStatus: "in_progress",
      })
    );
  });

  it("classifies a normal successful build as answered and skips the question effects", async () => {
    mockState.processManagerResult = {
      success: true,
      duration: 1000,
      result: "Implemented the feature; tests green.",
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/build/route"
    );

    const res = await POST(mockRequest({ epicIds: ["epic-1"] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    expect(mockMarkSessionTerminal).toHaveBeenCalledWith(
      "test-session-id",
      expect.objectContaining({ success: true, outcome: "answered" }),
      expect.any(String)
    );
    expect(mockHandleAskedQuestionOutcome).not.toHaveBeenCalled();

    const reviewUpdates = mockState.updateCalls.filter(
      (u) => u.values.status === "review"
    );
    expect(reviewUpdates.length).toBeGreaterThan(0);
  });
});
