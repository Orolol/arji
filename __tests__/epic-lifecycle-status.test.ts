/**
 * Tests for epic lifecycle status transitions:
 * - Build completion marks US and epic as "review" (not "done")
 * - Negative review reverts statuses to "in_progress"
 *
 * Each test uses vi.resetModules() + dynamic import to avoid
 * state leaking across tests from cached module-level background IIFEs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state — tracks all DB update/insert calls
// ---------------------------------------------------------------------------

interface DbUpdateCall {
  table: string;
  setValues: Record<string, unknown>;
}

let dbUpdates: DbUpdateCall[] = [];

// Configurable per-test: the mock data returned from DB reads
let mockEpic: Record<string, unknown> = {};
let mockStories: Record<string, unknown>[] = [];
let mockProject: Record<string, unknown> = {};

// Track which table a select().from() targets
let currentSelectTable = "";

// Process manager result — configurable per test
let processManagerResult: {
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
} = { success: true, duration: 1000 };

// ---------------------------------------------------------------------------
// DB mock — captures mutations for assertions
// ---------------------------------------------------------------------------
vi.mock("@/lib/db", () => {
  const createChain = () => {
    let _table = "";
    let _setValues: Record<string, unknown> = {};
    let _insertTable = "";

    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      from: vi.fn((table: { _name?: string } | string) => {
        const name =
          typeof table === "string"
            ? table
            : table?._name ?? JSON.stringify(table);
        _table = name;
        currentSelectTable = name;
        return chain;
      }),
      where: vi.fn((..._args: unknown[]) => {
        if (_setValues && Object.keys(_setValues).length > 0) {
          dbUpdates.push({ table: _table, setValues: { ..._setValues } });
          _setValues = {};
        }
        return chain;
      }),
      orderBy: vi.fn(() => chain),
      get: vi.fn(() => {
        if (currentSelectTable === "projects") return mockProject;
        if (currentSelectTable === "epics") return mockEpic;
        if (currentSelectTable === "userStories")
          return mockStories[0] ?? null;
        return null;
      }),
      all: vi.fn(() => {
        if (currentSelectTable === "userStories") return mockStories;
        if (currentSelectTable === "documents") return [];
        if (currentSelectTable === "ticketComments") return [];
        return [];
      }),
      set: vi.fn((values: Record<string, unknown>) => {
        _setValues = values;
        return chain;
      }),
      update: vi.fn((table: { _name?: string } | string) => {
        const name =
          typeof table === "string"
            ? table
            : table?._name ?? JSON.stringify(table);
        _table = name;
        _setValues = {};
        return chain;
      }),
      insert: vi.fn((table: { _name?: string } | string) => {
        const name =
          typeof table === "string"
            ? table
            : table?._name ?? JSON.stringify(table);
        _insertTable = name;
        return chain;
      }),
      values: vi.fn(() => chain),
      run: vi.fn(() => chain),
    };
    return chain;
  };
  return { db: createChain() };
});

vi.mock("@/lib/db/schema", () => ({
  projects: { _name: "projects" },
  epics: { _name: "epics", id: "id", epicId: "epicId" },
  userStories: {
    _name: "userStories",
    id: "id",
    epicId: "epicId",
    status: "status",
    position: "position",
  },
  documents: { _name: "documents", projectId: "projectId" },
  ticketComments: {
    _name: "ticketComments",
    epicId: "epicId",
    userStoryId: "userStoryId",
    createdAt: "createdAt",
  },
  agentSessions: { _name: "agentSessions" },
}));

vi.mock("@/lib/utils/nanoid", () => ({ createId: vi.fn(() => "test-id") }));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "feature/epic-1-test",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerResult,
    })),
  },
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: vi.fn().mockReturnValue("prompt"),
  buildTicketBuildPrompt: vi.fn().mockReturnValue("prompt"),
  buildEpicReviewPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/constants", () => ({
  REVIEW_TYPE_TO_AGENT_TYPE: {
    security: "security_reviewer",
    code_review: "code_reviewer",
    compliance: "compliance_reviewer",
    feature_review: "feature_reviewer",
  },
}));

vi.mock("@/lib/claude/json-parser", () => ({
  parseClaudeOutput: vi.fn((text: string) => ({ content: text })),
}));

vi.mock("@/lib/session-lock", () => ({
  checkSessionLock: vi.fn().mockReturnValue({ locked: false }),
}));

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: vi.fn().mockReturnValue(null),
  createAgentAlreadyRunningPayload: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

vi.mock("fs", () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

vi.mock("path", () => ({
  default: { join: vi.fn((...args: string[]) => args.join("/")) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 100));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Epic build — marks US & epic as review on success", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    processManagerResult = { success: true, duration: 1000 };
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "in_progress",
      branchName: "feature/epic-1-test",
    };
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "in_progress", title: "US 1" },
      { id: "us-2", epicId: "epic-1", status: "in_progress", title: "US 2" },
    ];
  });

  it("sets US to review and epic to review on build success", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
    );

    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    const usReview = dbUpdates.find(
      (u) => u.table === "userStories" && u.setValues.status === "review"
    );
    expect(usReview).toBeDefined();

    const epicReview = dbUpdates.find(
      (u) => u.table === "epics" && u.setValues.status === "review"
    );
    expect(epicReview).toBeDefined();
  });
});

describe("Epic build — failure does NOT mark done", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    processManagerResult = {
      success: false,
      error: "Build failed",
      duration: 500,
    };
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "in_progress",
      branchName: "feature/epic-1-test",
    };
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "in_progress", title: "US 1" },
    ];
  });

  it("does NOT set status to review on failure", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
    );

    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    const reviewUpdates = dbUpdates.filter(
      (u) => u.setValues.status === "review"
    );
    expect(reviewUpdates).toHaveLength(0);
  });
});

describe("Epic review — negative verdict reverts to in_progress", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "review",
      branchName: "feature/epic-1-test",
    };
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "review", title: "US 1" },
      { id: "us-2", epicId: "epic-1", status: "review", title: "US 2" },
    ];
  });

  it("reverts epic and US to in_progress on negative review", async () => {
    processManagerResult = {
      success: true,
      result: "Changes requested: the feature is not complete",
      duration: 1000,
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["feature_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    const epicRevert = dbUpdates.find(
      (u) => u.table === "epics" && u.setValues.status === "in_progress"
    );
    expect(epicRevert).toBeDefined();

    const usRevert = dbUpdates.find(
      (u) => u.table === "userStories" && u.setValues.status === "in_progress"
    );
    expect(usRevert).toBeDefined();
  });
});

describe("Epic review — positive verdict keeps review status", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "review",
      branchName: "feature/epic-1-test",
    };
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "review", title: "US 1" },
    ];
  });

  it("does NOT revert on positive review", async () => {
    processManagerResult = {
      success: true,
      result: "All acceptance criteria met. LGTM.",
      duration: 500,
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["feature_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    const revertUpdates = dbUpdates.filter(
      (u) => u.setValues.status === "in_progress"
    );
    expect(revertUpdates).toHaveLength(0);
  });
});

describe("Epic review — status gate", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockStories = [];
  });

  it("allows review when epic is in review", async () => {
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "review",
      branchName: "feature/epic-1-test",
    };
    processManagerResult = { success: true, result: "LGTM", duration: 500 };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["code_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }) }
    );

    expect(res.status).toBe(200);
  });

  it("rejects review when epic is in_progress", async () => {
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "in_progress",
      branchName: "feature/epic-1-test",
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["code_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }) }
    );

    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain("review or done");
  });
});

describe("Story build — marks story as review on success", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    processManagerResult = { success: true, duration: 1000 };
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "in_progress",
      branchName: "feature/epic-1-test",
    };
    // The first story returned by get() is the one being built
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "todo", title: "US 1" },
    ];
  });

  it("sets story to review on build success", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/stories/[storyId]/build/route"
    );

    const res = await POST(mockRequest({}), {
      params: Promise.resolve({ projectId: "proj-1", storyId: "us-1" }),
    });

    expect(res.status).toBe(200);
    await flushBackground();

    const storyReview = dbUpdates.find(
      (u) => u.table === "userStories" && u.setValues.status === "review"
    );
    expect(storyReview).toBeDefined();
  });
});

describe("Story review — negative verdict reverts story and epic", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "review",
      branchName: "feature/epic-1-test",
    };
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "review", title: "US 1" },
    ];
  });

  it("reverts story and parent epic on negative review", async () => {
    processManagerResult = {
      success: true,
      result: "This feature is not complete. Multiple criteria are missing.",
      duration: 1000,
    };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/stories/[storyId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["feature_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", storyId: "us-1" }) }
    );

    expect(res.status).toBe(200);
    await flushBackground();

    const storyRevert = dbUpdates.find(
      (u) => u.table === "userStories" && u.setValues.status === "in_progress"
    );
    expect(storyRevert).toBeDefined();

    const epicRevert = dbUpdates.find(
      (u) => u.table === "epics" && u.setValues.status === "in_progress"
    );
    expect(epicRevert).toBeDefined();
  });
});

describe("Story review — status gate", () => {
  beforeEach(() => {
    vi.resetModules();
    dbUpdates = [];
    mockProject = { id: "proj-1", name: "Test", gitRepoPath: "/repos/test" };
    mockEpic = {
      id: "epic-1",
      title: "Test Epic",
      status: "review",
      branchName: "feature/epic-1-test",
    };
  });

  it("allows review when story is in review", async () => {
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "review", title: "US 1" },
    ];
    processManagerResult = { success: true, result: "LGTM", duration: 500 };

    const { POST } = await import(
      "@/app/api/projects/[projectId]/stories/[storyId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["code_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", storyId: "us-1" }) }
    );

    expect(res.status).toBe(200);
  });

  it("rejects review when story is in_progress", async () => {
    mockStories = [
      { id: "us-1", epicId: "epic-1", status: "in_progress", title: "US 1" },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/stories/[storyId]/review/route"
    );

    const res = await POST(
      mockRequest({ reviewTypes: ["code_review"] }),
      { params: Promise.resolve({ projectId: "proj-1", storyId: "us-1" }) }
    );

    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain("review or done");
  });
});
