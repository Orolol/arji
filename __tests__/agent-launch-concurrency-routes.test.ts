import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
}));

const mockInsertWithGuard = vi.hoisted(() => vi.fn());
const mockGetRunningForTarget = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  notInArray: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain: {
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    all: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.insert.mockReturnValue({
    values: vi.fn(() => ({ run: vi.fn() })),
  });
  chain.update.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ run: vi.fn() })),
    })),
  });

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  projects: { id: "id", gitRepoPath: "gitRepoPath" },
  epics: {
    id: "id",
    status: "status",
    branchName: "branchName",
    title: "title",
    description: "description",
    updatedAt: "updatedAt",
  },
  userStories: {
    id: "id",
    epicId: "epicId",
    status: "status",
    position: "position",
  },
  documents: { projectId: "projectId" },
  agentSessions: {
    id: "id",
    epicId: "epicId",
    userStoryId: "userStoryId",
    status: "status",
    mode: "mode",
    createdAt: "createdAt",
  },
  ticketComments: { userStoryId: "userStoryId", createdAt: "createdAt" },
  settings: { key: "key", value: "value" },
}));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
  startMergeInWorktree: vi.fn().mockResolvedValue({
    conflicted: true,
    output: "merge conflict",
  }),
  mergeWorktree: vi.fn().mockResolvedValue({ merged: true, commitHash: "abc123" }),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ status: "completed", result: { success: true } }),
  },
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: vi.fn(() => "prompt"),
  buildTicketBuildPrompt: vi.fn(() => "prompt"),
  buildEpicReviewPrompt: vi.fn(() => "prompt"),
  buildReviewPrompt: vi.fn(() => "prompt"),
  buildMergeResolutionPrompt: vi.fn(() => "prompt"),
  buildTeamBuildPrompt: vi.fn(() => "prompt"),
}));

vi.mock("@/lib/claude/json-parser", () => ({
  parseClaudeOutput: vi.fn(() => ({ content: "ok" })),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/session-lock", () => ({
  checkSessionLock: vi.fn(() => ({ locked: false })),
}));

vi.mock("@/lib/agent-config/constants", () => ({
  REVIEW_TYPE_TO_AGENT_TYPE: {
    security: "review_security",
    code_review: "review_code",
    compliance: "review_compliance",
  },
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "session-1"),
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("@/lib/agents/concurrency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agents/concurrency")>(
    "@/lib/agents/concurrency"
  );
  return {
    ...actual,
    insertRunningSessionWithGuard: mockInsertWithGuard,
    getRunningSessionForTarget: mockGetRunningForTarget,
  };
});

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

const CONFLICT = {
  id: "running-session-42",
  projectId: "proj-1",
  epicId: "epic-1",
  userStoryId: null,
  mode: "code",
  provider: "claude-code",
  startedAt: "2026-02-12T10:00:00.000Z",
};

describe("Agent launch routes concurrency conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockDbState.getQueue = [];
    mockDbState.allQueue = [];
    mockInsertWithGuard.mockReturnValue({ inserted: true });
    mockGetRunningForTarget.mockReturnValue(null);
  });

  it("returns AGENT_ALREADY_RUNNING for epic build launches", async () => {
    mockDbState.getQueue = [
      { id: "epic-1", status: "todo", title: "Epic 1" },
      { id: "proj-1", gitRepoPath: "/repo" },
    ];
    mockDbState.allQueue = [[], []];
    mockGetRunningForTarget.mockReturnValue(CONFLICT);

    const { POST } = await import("@/app/api/projects/[projectId]/epics/[epicId]/build/route");
    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("running-session-42");
    expect(json.data.target.scope).toBe("epic");
  });

  it("returns AGENT_ALREADY_RUNNING for story build launches", async () => {
    mockDbState.getQueue = [
      { id: "story-1", status: "todo", epicId: "epic-1", title: "Story 1" },
      { id: "epic-1", title: "Epic 1" },
      { id: "proj-1", gitRepoPath: "/repo" },
    ];
    mockDbState.allQueue = [[], []];
    mockGetRunningForTarget.mockReturnValue({
      ...CONFLICT,
      userStoryId: "story-1",
    });

    const { POST } = await import("@/app/api/projects/[projectId]/stories/[storyId]/build/route");
    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", storyId: "story-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("running-session-42");
    expect(json.data.target.scope).toBe("story");
    expect(json.data.target.storyId).toBe("story-1");
  });

  it("returns AGENT_ALREADY_RUNNING for epic review launches", async () => {
    mockDbState.getQueue = [
      { id: "epic-1", status: "review", title: "Epic 1" },
      { id: "proj-1", gitRepoPath: "/repo" },
    ];
    mockDbState.allQueue = [[], []];
    mockGetRunningForTarget.mockReturnValue(CONFLICT);

    const { POST } = await import("@/app/api/projects/[projectId]/epics/[epicId]/review/route");
    const res = await POST(mockRequest({ reviewTypes: ["security"] }), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("running-session-42");
  });

  it("returns AGENT_ALREADY_RUNNING for story review launches", async () => {
    mockDbState.getQueue = [
      { id: "story-1", status: "review", epicId: "epic-1" },
      { id: "epic-1", title: "Epic 1" },
      { id: "proj-1", gitRepoPath: "/repo" },
    ];
    mockDbState.allQueue = [[]];
    mockGetRunningForTarget.mockReturnValue({
      ...CONFLICT,
      userStoryId: "story-1",
    });

    const { POST } = await import("@/app/api/projects/[projectId]/stories/[storyId]/review/route");
    const res = await POST(mockRequest({ reviewTypes: ["security"] }), {
      params: Promise.resolve({ projectId: "proj-1", storyId: "story-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("running-session-42");
    expect(json.data.target.storyId).toBe("story-1");
  });

  it("returns AGENT_ALREADY_RUNNING for merge-resolution launches", async () => {
    mockDbState.getQueue = [
      { id: "proj-1", gitRepoPath: "/repo" },
      { id: "epic-1", title: "Epic 1", branchName: "feature/epic-1" },
      { key: "global_prompt", value: JSON.stringify("global") },
    ];
    mockDbState.allQueue = [[]];
    mockGetRunningForTarget.mockReturnValue(CONFLICT);

    const { POST } = await import("@/app/api/projects/[projectId]/epics/[epicId]/resolve-merge/route");
    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("running-session-42");
    expect(json.data.target.scope).toBe("epic");
  });

  it("returns AGENT_ALREADY_RUNNING for project batch build launches", async () => {
    mockGetRunningForTarget.mockReturnValue(CONFLICT);

    const { POST } = await import("@/app/api/projects/[projectId]/build/route");
    const res = await POST(mockRequest({ epicIds: ["epic-1"] }), {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("AGENT_ALREADY_RUNNING");
    expect(json.data.activeSessionId).toBe("running-session-42");
  });
});
