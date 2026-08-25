/**
 * The last leg of a bug screenshot's journey: from `epics.images` into the
 * prompt an agent is actually spawned with.
 *
 * `__tests__/ticket-image-prompt.test.ts` pins the prompt builders in
 * isolation. This drives the real epic build route — the endpoint behind both
 * Send-to-Dev and the bug modal's "Create And Fix" — so a route that stopped
 * passing the epic row (or started passing a projection without `images`)
 * fails here rather than shipping an agent that cannot see the bug.
 *
 * Every provider is exercised: the injection happens in the shared prompt
 * builder, ahead of any provider branch, so all of them must receive the same
 * text. The provider is a parameter of a single `processManager.start()` call,
 * never a fork in how the prompt is composed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import {
  dbMockState,
  mockJsonRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";
import { POST as buildEpic } from "@/app/api/projects/[projectId]/epics/[epicId]/build/route";

const projectId = "proj-1";
const epicId = "bug-1";
const screenshot = `data/uploads/${projectId}/abc123-blank-board.png`;
const absoluteScreenshot = path.join(
  process.cwd(),
  "data",
  "uploads",
  projectId,
  "abc123-blank-board.png"
);

/** Provider chosen by the agent resolution, swapped per test. */
const agentState = vi.hoisted(() => ({ provider: "claude-code" }));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/documents/memory", () => ({
  getProjectMemoryContent: vi.fn(() => null),
}));

vi.mock("@/lib/documents/query", () => ({ listProjectDocuments: vi.fn(() => []) }));

vi.mock("@/lib/notifications/create", () => ({
  createUnresolvedMentionsNotification: vi.fn(),
  buildEpicTargetUrl: vi.fn(() => "/board"),
}));

vi.mock("@/lib/workflow/log", () => ({ logTransition: vi.fn() }));
// The build route's workflow bookkeeping is out of scope for a prompt-text
// test: stub it out so the real transition engine (and its extra DB reads)
// cannot interfere with the seeded row queue.
vi.mock("@/lib/workflow/automatic-transitions", () => ({
  transitionBuildStarted: vi.fn(),
  finalizeBuildTerminalOutcome: vi.fn(() => ({ kind: "completed" })),
  logBuildFailure: vi.fn(),
  resolveBuildSessionResult: vi.fn(() => ({ success: true, error: null })),
  WorkflowTransitionError: class WorkflowTransitionError extends Error {},
}));
vi.mock("@/lib/workflow/agent-question", () => ({
  handleAskedQuestionOutcome: vi.fn(() => false),
}));

vi.mock("@/lib/events/emit", () => ({
  emitTicketMoved: vi.fn(),
  emitSessionStarted: vi.fn(),
  emitSessionCompleted: vi.fn(),
  emitSessionFailed: vi.fn(),
}));

vi.mock("@/lib/utils/nanoid", () => ({ createId: vi.fn(() => "session-1") }));

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn().mockResolvedValue({
    worktreePath: "/tmp/worktree",
    branchName: "bug/blank-board",
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

const mockProcessStart = vi.hoisted(() => vi.fn());
vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { start: mockProcessStart },
}));

vi.mock("@/lib/agent-sessions/wait-for-completion", () => ({
  waitForProcessCompletion: vi
    .fn()
    .mockResolvedValue({ result: { success: true, result: "fixed" } }),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: agentState.provider,
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("@/lib/agents/concurrency", () => ({
  getRunningSessionForTarget: vi.fn(() => null),
  createAgentAlreadyRunningPayload: vi.fn(),
}));

const mockCreateQueuedSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: mockCreateQueuedSession,
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

/** Runs the launch closure inline so `processManager.start` is observable. */
const scheduledRuns = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));
vi.mock("@/lib/agents/scheduler", () => ({
  agentScheduler: {
    submit: vi.fn((_projectId: string, _sessionId: string, run: () => Promise<unknown>) => {
      scheduledRuns.pending.push(run());
    }),
  },
}));

vi.mock("@/lib/pipeline", () => ({
  resolvePipelineEnabled: vi.fn(() => false),
  startPipelineRun: vi.fn(),
}));

vi.mock("fs", () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

/** Seeds the two `.get()` lookups the route makes: the epic, then the project. */
function seedRows(images: string | null) {
  dbMockState.getQueue.push(
    {
      id: epicId,
      projectId,
      title: "Board renders blank",
      description: "Opening the board shows nothing after login",
      type: "bug",
      status: "backlog",
      images,
    },
    {
      id: projectId,
      name: "Arij",
      spec: "## Spec",
      gitRepoPath: "/repos/arij",
      defaultBranch: "main",
    }
  );
}

async function dispatchBuild(): Promise<string> {
  const res = await buildEpic(
    mockJsonRequest({}),
    mockRouteContext({ projectId, epicId })
  );
  expect(res.status).toBe(200);

  await Promise.all(scheduledRuns.pending);

  expect(mockProcessStart).toHaveBeenCalledTimes(1);
  const [, options] = mockProcessStart.mock.calls[0] as [
    string,
    { prompt: string },
  ];
  return options.prompt;
}

describe("a bug's screenshots reach the agent that is dispatched on it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    scheduledRuns.pending = [];
    agentState.provider = "claude-code";
  });

  it("puts the screenshot's local path in the prompt", async () => {
    seedRows(JSON.stringify([screenshot]));

    const prompt = await dispatchBuild();

    expect(prompt).toContain(absoluteScreenshot);
    // Nested inside `## Epic to Implement`, not a sibling that closes it.
    expect(prompt).toMatch(/^### Attached Screenshots$/m);
    expect(prompt).not.toMatch(/^## Attached Screenshots$/m);
  });

  it("stores that same prompt on the session row", async () => {
    seedRows(JSON.stringify([screenshot]));

    const prompt = await dispatchBuild();

    expect(mockCreateQueuedSession).toHaveBeenCalledWith(
      expect.objectContaining({ prompt })
    );
  });

  it("says nothing about screenshots when the bug has none", async () => {
    seedRows(null);

    const prompt = await dispatchBuild();

    expect(prompt).not.toContain("Attached Screenshots");
    expect(prompt).not.toContain("data/uploads");
  });

  it.each([
    "claude-code",
    "codex",
    "gemini-cli",
    "opencode",
    "qwen-code",
  ])("composes the identical prompt for the %s provider", async (provider) => {
    agentState.provider = provider;
    seedRows(JSON.stringify([screenshot]));

    const prompt = await dispatchBuild();

    expect(prompt).toContain(absoluteScreenshot);
    expect(mockProcessStart).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prompt }),
      provider
    );
  });
});
