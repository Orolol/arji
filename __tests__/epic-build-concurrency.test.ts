/**
 * Tests that the epic build route returns 409 when a session lock is active.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let getCallCount = 0;
const mockGetRunningForTarget = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    get: vi.fn(() => {
      getCallCount++;
      if (getCallCount === 1) {
        // Epic lookup
        return {
          id: "epic-1",
          title: "Test Epic",
          status: "in_progress",
          branchName: "feature/test",
        };
      }
      // Project lookup
      return {
        id: "proj-1",
        name: "Test Project",
        gitRepoPath: "/repos/test",
      };
    }),
    all: vi.fn().mockReturnValue([]),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  projects: {},
  epics: { id: "id" },
  userStories: { epicId: "epicId", position: "position", status: "status" },
  documents: { projectId: "projectId" },
  agentSessions: {
    id: "id",
    epicId: "epicId",
    userStoryId: "userStoryId",
    mode: "mode",
    status: "status",
  },
  ticketComments: {},
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "test-session-id"),
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      status: "completed",
      result: { success: true },
    }),
  },
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/providers", () => ({
  resolveAgent: vi.fn(() => ({ provider: "claude-code", namedAgentId: null })),
  resolveAgentByNamedId: vi.fn(() => ({ provider: "claude-code", namedAgentId: null })),
}));

vi.mock("@/lib/claude/json-parser", () => ({
  parseClaudeOutput: vi.fn().mockReturnValue({ content: "output" }),
}));

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

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: mockGetRunningForTarget,
  createAgentAlreadyRunningPayload: vi.fn((_target, conflict) => ({
    error: "Another agent is already running for this epic.",
    code: "AGENT_ALREADY_RUNNING",
    data: {
      activeSessionId: conflict.id,
      activeSession: conflict,
      sessionUrl: "/projects/proj-1/sessions/existing-session",
      target: { scope: "epic", projectId: "proj-1", epicId: "epic-1" },
    },
  })),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

function mockRequest(body: Record<string, unknown> = {}) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("Epic Build Route - Concurrency Guard", () => {
  beforeEach(() => {
    getCallCount = 0;
    mockGetRunningForTarget.mockReturnValue(null);
    vi.resetModules();
  });

  it("returns 409 when a session lock is active", async () => {
    mockGetRunningForTarget.mockReturnValue({
      id: "existing-session",
      projectId: "proj-1",
      epicId: "epic-1",
      userStoryId: null,
      mode: "code",
      provider: "claude-code",
      startedAt: "2026-02-12T10:00:00.000Z",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
    );

    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("existing-session");
  });

  it("proceeds when no session lock is active", async () => {
    mockGetRunningForTarget.mockReturnValue(null);

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
    );

    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toBeDefined();
    expect(json.data.sessionId).toBeDefined();
  });
});
