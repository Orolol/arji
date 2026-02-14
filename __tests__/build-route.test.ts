/**
 * Tests for the batch build route's team mode and provider parameter handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call counts to return different values for sequential .get() calls
let getCallCount = 0;

const mockResolveAgentByNamedId = vi.hoisted(() =>
  vi.fn(() => ({ provider: "claude-code" })),
);

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
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
  epics: { id: "id", epicId: "epicId", position: "position" },
  userStories: { epicId: "epicId", position: "position" },
  documents: { projectId: "projectId" },
  agentSessions: { id: "id", epicId: "epicId", mode: "mode", status: "status" },
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
    getStatus: vi.fn().mockReturnValue({
      status: "completed",
      result: { success: true, duration: 1000 },
    }),
  },
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: vi.fn().mockReturnValue("solo prompt"),
  buildTeamBuildPrompt: vi.fn().mockReturnValue("team prompt"),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("resolved system prompt"),
}));

vi.mock("@/lib/agent-config/providers", () => ({
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
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

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("Build Route", () => {
  beforeEach(() => {
    getCallCount = 0;
    mockResolveAgentByNamedId.mockReturnValue({ provider: "claude-code" });
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
});
