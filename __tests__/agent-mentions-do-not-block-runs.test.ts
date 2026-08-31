/**
 * `@name` is an Arij document reference only when a human typed it. Agents
 * write `@src/foo.ts` or `@README.md` about the project's own codebase, which
 * are not Arij uploads — resolving those used to fail the whole launch with
 * "Unknown document mention(s)", so a build or a review could be refused by
 * something an agent had written in a comment.
 *
 * Two rules, both exercised here against the epic build route:
 *   1. Only user-written text feeds mention resolution.
 *   2. An unresolved mention never blocks the run — it notifies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

/** `.get()` / `.all()` call counters, reset per test (survive resetModules). */
const getCalls = vi.hoisted(() => ({ count: 0 }));
const allCalls = vi.hoisted(() => ({ count: 0 }));
/** Ticket comments the route loads for the prompt. */
const commentState = vi.hoisted(() => ({
  rows: [] as Array<{ author: string; content: string; createdAt: string }>,
}));
const mockCreateUnresolvedMentionsNotification = vi.hoisted(() => vi.fn());
/** Arij has no documents at all, so every mention is unresolvable. */
const mockListProjectDocuments = vi.hoisted(() => vi.fn(() => []));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  const mod = dbModuleMock();
  mod.db.get.mockImplementation(() => {
    getCalls.count++;
    if (getCalls.count === 1) {
      return {
        id: "epic-1",
        title: "Test Epic",
        status: "in_progress",
        branchName: "feature/test",
      };
    }
    return { id: "proj-1", name: "Test Project", gitRepoPath: "/repos/test" };
  });
  mod.db.all.mockImplementation(() => {
    allCalls.count++;
    // 1. user stories, 2. ticket comments, 3+. open review comments
    return allCalls.count === 2 ? commentState.rows : [];
  });
  return mod;
});

vi.mock("@/lib/pipeline", () => ({
  resolvePipelineEnabled: vi.fn(() => false),
  startPipelineRun: vi.fn(() => ({ runId: "run-test" })),
}));

vi.mock("@/lib/documents/query", () => ({
  listProjectDocuments: mockListProjectDocuments,
}));

vi.mock("@/lib/notifications/create", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/notifications/create")
  >("@/lib/notifications/create");
  return {
    ...actual,
    createUnresolvedMentionsNotification:
      mockCreateUnresolvedMentionsNotification,
  };
});

vi.mock("@/lib/workflow/log", () => ({ logTransition: vi.fn() }));

vi.mock("@/lib/events/emit", () => ({
  emitTicketMoved: vi.fn(),
  emitTicketCreated: vi.fn(),
  emitSessionStarted: vi.fn(),
  emitSessionCompleted: vi.fn(),
  emitSessionFailed: vi.fn(),
  emitSessionProgress: vi.fn(),
}));

vi.mock("@/lib/utils/nanoid", () => ({ createId: vi.fn(() => "test-session-id") }));

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

const mockBuildBuildPrompt = vi.hoisted(() => vi.fn(() => "BUILD_PROMPT"));
vi.mock("@/lib/claude/prompt-builder", () => ({
  buildBuildPrompt: mockBuildBuildPrompt,
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgent: vi.fn(() => ({ provider: "claude-code", namedAgentId: null })),
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
  })),
}));

vi.mock("@/lib/claude/json-parser", () => ({
  parseClaudeOutput: vi.fn().mockReturnValue({ content: "output" }),
}));

vi.mock("fs", () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

vi.mock("path", () => ({
  default: { join: vi.fn((...args: string[]) => args.join("/")) },
}));

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: vi.fn(() => null),
  createAgentAlreadyRunningPayload: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
  isSessionNotFoundError: vi.fn(() => false),
  recordSessionTransitionRefusal: vi.fn(),
}));

async function postBuild(body: Record<string, unknown> = {}) {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/epics/[epicId]/build/route"
  );
  return POST(
    mockJsonRequest(body),
    mockRouteContext({ projectId: "proj-1", epicId: "epic-1" })
  );
}

describe("Agent-written @mentions never block a run", () => {
  beforeEach(() => {
    getCalls.count = 0;
    allCalls.count = 0;
    commentState.rows = [];
    mockCreateUnresolvedMentionsNotification.mockClear();
    vi.resetModules();
  });

  it("ignores an agent comment's mentions instead of refusing the build", async () => {
    commentState.rows = [
      {
        author: "agent",
        content: "I refactored @src/foo.ts and updated @README.md",
        createdAt: "2026-02-12T10:00:00.000Z",
      },
    ];

    const res = await postBuild({});

    expect(res.status).toBe(200);
    // Nothing to look up: the only mentions came from an agent.
    expect(mockListProjectDocuments).not.toHaveBeenCalled();
    expect(mockCreateUnresolvedMentionsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ missing: [] })
    );
  });

  it("launches anyway and notifies when a user mention cannot be resolved", async () => {
    const res = await postBuild({ comment: "follow @missing.md please" });

    expect(res.status).toBe(200);
    expect(mockCreateUnresolvedMentionsNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        missing: ["missing.md"],
        agentType: "build",
      })
    );
  });
});
