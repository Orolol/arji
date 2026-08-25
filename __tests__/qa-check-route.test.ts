import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockCreateId = vi.hoisted(() => vi.fn());

const mockLifecycle = vi.hoisted(() => ({
  createQueuedSession: vi.fn(),
  markSessionRunning: vi.fn(),
  markSessionTerminal: vi.fn(),
  isSessionLifecycleConflictError: vi.fn(() => false),
}));

const mockProcessManager = vi.hoisted(() => ({
  start: vi.fn(),
  getStatus: vi.fn(),
}));

const mockResolvers = vi.hoisted(() => ({
  resolveAgentPrompt: vi.fn(),
  resolveAgentByNamedId: vi.fn(),
}));

const mockPromptBuilders = vi.hoisted(() => ({
  buildTechCheckPrompt: vi.fn(() => "TECH_CHECK_PROMPT"),
  buildE2eTestPrompt: vi.fn(() => "E2E_TEST_PROMPT"),
  buildFailureDigestPrompt: vi.fn(() => "FAILURE_DIGEST_PROMPT"),
}));

const mockCollectFailureDigestEvidence = vi.hoisted(() => vi.fn());

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: mockCreateId,
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildTechCheckPrompt: mockPromptBuilders.buildTechCheckPrompt,
  buildE2eTestPrompt: mockPromptBuilders.buildE2eTestPrompt,
  buildFailureDigestPrompt: mockPromptBuilders.buildFailureDigestPrompt,
}));

vi.mock("@/lib/telescope/collect", () => ({
  collectFailureDigestEvidence: mockCollectFailureDigestEvidence,
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: mockResolvers.resolveAgentPrompt,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: mockResolvers.resolveAgentByNamedId,
}));

// listProjectTextDocuments is no longer used by the QA check route —
// QA prompts intentionally exclude project documents.

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  createQueuedSession: mockLifecycle.createQueuedSession,
  markSessionRunning: mockLifecycle.markSessionRunning,
  markSessionTerminal: mockLifecycle.markSessionTerminal,
  isSessionLifecycleConflictError: mockLifecycle.isSessionLifecycleConflictError,
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: mockProcessManager,
}));

vi.mock("@/lib/claude/json-parser", () => ({
  parseClaudeOutput: vi.fn(() => ({ content: "Parsed content" })),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn((...parts: string[]) => parts.join("/")),
  },
}));

describe("POST /api/projects/[projectId]/qa/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockCreateId
      .mockReset()
      .mockReturnValueOnce("session-1")
      .mockReturnValueOnce("report-1");
    mockResolvers.resolveAgentPrompt.mockResolvedValue("System prompt");
    mockResolvers.resolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: "claude-opus-4-1",
    });
    mockCollectFailureDigestEvidence.mockReset().mockReturnValue({
      projectId: "proj-1",
      windowDays: 14,
      sinceIso: "2026-08-11T12:00:00.000Z",
      untilIso: "2026-08-25T12:00:00.000Z",
      evidenceCount: 2,
      groupCount: 1,
      groups: [{ signature: "claude-code::build::failure", count: 2 }],
      omittedGroupCount: 0,
      payloadChars: 100,
      truncated: false,
    });
    mockProcessManager.start.mockReturnValue({
      sessionId: "session-1",
      status: "running",
      startedAt: new Date(),
    });
    mockProcessManager.getStatus.mockReturnValue(null);
  });

  it("returns 404 when project does not exist", async () => {
    dbMockState.getQueue = [null];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/check/route"
    );
    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId: "missing" }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain("Project not found");
  });

  it("returns 400 when project has no git repo path", async () => {
    dbMockState.getQueue = [
      { id: "proj-1", name: "Arij", gitRepoPath: null, spec: "Spec" },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/check/route"
    );
    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("git repository");
  });

  it("creates a running QA report and launches a tech_check session", async () => {
    dbMockState.getQueue = [
      { id: "proj-1", name: "Arij", gitRepoPath: "/tmp/repo", spec: "Spec" },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/check/route"
    );
    const res = await POST(
      mockJsonRequest({ customPrompt: "Focus on architecture" }),
      mockRouteContext({ projectId: "proj-1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.reportId).toBe("report-1");
    expect(json.data.sessionId).toBe("session-1");
    expect(mockLifecycle.createQueuedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        projectId: "proj-1",
        agentType: "tech_check",
      }),
    );
    expect(mockProcessManager.start).toHaveBeenCalledTimes(1);
  });

  it("launches a project-level failure_digest session in plan mode", async () => {
    dbMockState.getQueue = [
      { id: "proj-1", name: "Arij", gitRepoPath: "/tmp/repo", spec: "Spec" },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/check/route"
    );
    const res = await POST(
      mockJsonRequest({ checkType: "failure_digest", windowDays: 7 }),
      mockRouteContext({ projectId: "proj-1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({
      reportId: "report-1",
      sessionId: "session-1",
      noOp: false,
      evidenceCount: 2,
      windowDays: 14,
    });
    expect(mockCollectFailureDigestEvidence).toHaveBeenCalledWith("proj-1", {
      windowDays: 7,
    });
    expect(mockPromptBuilders.buildFailureDigestPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-1" }),
      expect.objectContaining({ evidenceCount: 2 }),
      null,
      "System prompt",
    );
    expect(mockLifecycle.createQueuedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        projectId: "proj-1",
        mode: "plan",
        agentType: "failure_digest",
      }),
    );
    expect(mockLifecycle.createQueuedSession.mock.calls[0][0]).not.toHaveProperty(
      "epicId",
    );
    expect(mockProcessManager.start).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ mode: "plan", prompt: "FAILURE_DIGEST_PROMPT" }),
      "claude-code",
    );
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        id: "report-1",
        checkType: "failure_digest",
        agentSessionId: "session-1",
        status: "running",
      }),
    );
  });

  it("bounds the failure digest window before collection", async () => {
    dbMockState.getQueue = [
      { id: "proj-1", name: "Arij", gitRepoPath: "/tmp/repo", spec: "Spec" },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/check/route"
    );
    const res = await POST(
      mockJsonRequest({
        checkType: "failure_digest",
        windowDays: 1_000_000_000,
      }),
      mockRouteContext({ projectId: "proj-1" }),
    );

    expect(res.status).toBe(200);
    expect(mockCollectFailureDigestEvidence).toHaveBeenCalledWith("proj-1", {
      windowDays: 365,
    });
  });

  it("journals an empty failure window without launching a session", async () => {
    mockCreateId.mockReset().mockReturnValueOnce("report-empty");
    mockCollectFailureDigestEvidence.mockReturnValue({
      projectId: "proj-1",
      windowDays: 14,
      sinceIso: "2026-08-11T12:00:00.000Z",
      untilIso: "2026-08-25T12:00:00.000Z",
      evidenceCount: 0,
      groupCount: 0,
      groups: [],
      omittedGroupCount: 0,
      payloadChars: 2,
      truncated: false,
    });
    dbMockState.getQueue = [
      { id: "proj-1", name: "Arij", gitRepoPath: "/tmp/repo", spec: "Spec" },
    ];
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/check/route"
    );
    const res = await POST(
      mockJsonRequest({ checkType: "failure_digest" }),
      mockRouteContext({ projectId: "proj-1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      reportId: "report-empty",
      sessionId: null,
      noOp: true,
      evidenceCount: 0,
      windowDays: 14,
    });
    expect(mockLifecycle.createQueuedSession).not.toHaveBeenCalled();
    expect(mockProcessManager.start).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toEqual([
      expect.objectContaining({
        id: "report-empty",
        status: "completed",
        agentSessionId: null,
        checkType: "failure_digest",
        summary: expect.stringContaining("no agent session launched"),
        reportContent: expect.stringContaining("No eligible recurring failure evidence"),
      }),
    ]);
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining("[failure-digest] skipped for project proj-1"),
    );
  });
});
