/**
 * Tests that the epic build route returns 409 when a session lock is active.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let getCallCount = 0;

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

// Mock session lock — this is what we're testing
let mockLockResult = { locked: false };
vi.mock("@/lib/session-lock", () => ({
  checkSessionLock: vi.fn(() => mockLockResult),
}));

function mockRequest(body: Record<string, unknown> = {}) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("Epic Build Route - Concurrency Guard", () => {
  beforeEach(() => {
    getCallCount = 0;
    mockLockResult = { locked: false };
    vi.resetModules();
  });

  it("returns 409 when a session lock is active", async () => {
    mockLockResult = {
      locked: true,
      sessionId: "existing-session",
    } as typeof mockLockResult;

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
    );

    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("conflict");
    expect(json.message).toContain("already running");
    expect(json.sessionId).toBe("existing-session");
  });

  it("proceeds when no session lock is active", async () => {
    mockLockResult = { locked: false };

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
