/**
 * The batch "Build as Team" dispatch, driven for real.
 *
 * `__tests__/bug-image-agent-dispatch.test.ts` covers the solo route, which
 * gets the screenshots for free: it hands `buildBuildPrompt` the whole Drizzle
 * epic row. Team mode is the exception — it copies a handful of fields into a
 * `TeamEpic` literal, so the screenshots reach the agent only if this route
 * explicitly forwards `projectId` and `images`. It once did not, and every
 * builder-level test still passed.
 *
 * The prompt builder is deliberately NOT mocked here: the assertion is on the
 * text `processManager.start()` is actually spawned with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import {
  dbMockState,
  mockJsonRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";
import { POST as batchBuild } from "@/app/api/projects/[projectId]/build/route";

const projectId = "proj-1";
const screenshot = `data/uploads/${projectId}/abc123-blank-board.png`;
const absoluteScreenshot = path.join(
  process.cwd(),
  "data",
  "uploads",
  projectId,
  "abc123-blank-board.png"
);

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/documents/memory", () => ({
  getProjectMemoryContent: vi.fn(() => null),
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
  // Team mode is Claude Code exclusive; the route rejects anything else before
  // a prompt is ever composed, so there is no per-provider variant to pin.
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
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
    submit: vi.fn(
      (_projectId: string, _sessionId: string, run: () => Promise<unknown>) => {
        scheduledRuns.pending.push(run());
      }
    ),
  },
}));

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));
vi.mock("@/lib/workflow/log", () => ({ logTransition: vi.fn() }));
// The build route's workflow bookkeeping is out of scope for a prompt-text
// test: stub it out so the real transition engine (and its extra DB reads)
// cannot interfere with the seeded row queue.
vi.mock("@/lib/workflow/automatic-transitions", () => ({
  transitionBuildStarted: vi.fn(),
  finalizeBuildTerminalOutcome: vi.fn(() => ({ kind: "completed" })),
  holdFailedBuild: vi.fn(),
  resolveBuildSessionResult: vi.fn(() => ({ success: true, error: null })),
  WorkflowTransitionError: class WorkflowTransitionError extends Error {},
}));
vi.mock("@/lib/workflow/agent-question", () => ({
  handleAskedQuestionOutcome: vi.fn(() => false),
}));

vi.mock("fs", () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

/**
 * Seeds the team branch's lookups: the project row, then one epic row per
 * batched id (`.all()` for user stories falls through to `allRows`).
 */
function seedRows(...epicImages: Array<string | null>) {
  dbMockState.getQueue.push({
    id: projectId,
    name: "Arij",
    spec: "## Spec",
    gitRepoPath: "/repos/arij",
    defaultBranch: "main",
  });

  epicImages.forEach((images, index) => {
    dbMockState.getQueue.push({
      id: `bug-${index + 1}`,
      projectId,
      title: `Board renders blank ${index + 1}`,
      description: "Opening the board shows nothing after login",
      type: "bug",
      status: "backlog",
      images,
    });
  });
}

async function dispatchTeamBuild(epicIds: string[]): Promise<string> {
  const res = await batchBuild(
    mockJsonRequest({ epicIds, team: true }),
    mockRouteContext({ projectId })
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

describe("a bug batched into a team build reaches the agent with its screenshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    scheduledRuns.pending = [];
  });

  it("puts the screenshot's local path in the team lead's prompt", async () => {
    seedRows(JSON.stringify([screenshot]));

    const prompt = await dispatchTeamBuild(["bug-1"]);

    expect(prompt).toContain("Attached Screenshots");
    expect(prompt).toContain(absoluteScreenshot);
  });

  it("stores that same prompt on the team session row", async () => {
    seedRows(JSON.stringify([screenshot]));

    const prompt = await dispatchTeamBuild(["bug-1"]);

    expect(mockCreateQueuedSession).toHaveBeenCalledWith(
      expect.objectContaining({ prompt, orchestrationMode: "team" })
    );
  });

  it("attaches the paths to the batched epic that actually carries them", async () => {
    seedRows(null, JSON.stringify([screenshot]));

    const prompt = await dispatchTeamBuild(["feature-1", "bug-2"]);

    const pathAt = prompt.indexOf(absoluteScreenshot);
    expect(pathAt).toBeGreaterThan(prompt.indexOf("### Epic 2:"));
  });

  it("says nothing about screenshots when no batched epic has one", async () => {
    seedRows(null, null);

    const prompt = await dispatchTeamBuild(["feature-1", "feature-2"]);

    expect(prompt).not.toContain("Attached Screenshots");
    expect(prompt).not.toContain("data/uploads");
  });
});
