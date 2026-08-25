import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockSpawnClaude = vi.hoisted(() => vi.fn());
const mockExtractJson = vi.hoisted(() => vi.fn());
const mockResolveAgent = vi.hoisted(() => vi.fn());
const mockCreateId = vi.hoisted(() => vi.fn());
const mockGetProvider = vi.hoisted(() => vi.fn());
const mockIsResumableProvider = vi.hoisted(() => vi.fn());

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock records
// insert(...).values(payload) payloads in dbMockState.insertCalls and hands the
// same chain to transaction() callbacks.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: mockResolveAgent,
}));

vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: mockSpawnClaude,
}));

vi.mock("@/lib/claude/json-parser", () => ({
  extractJsonFromOutput: mockExtractJson,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: mockCreateId,
}));

vi.mock("@/lib/providers", () => ({
  getProvider: mockGetProvider,
}));

vi.mock("@/lib/agent-sessions/validate-resume", () => ({
  isResumableProvider: mockIsResumableProvider,
}));

describe("POST /api/projects/[projectId]/qa/reports/[reportId]/create-epics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockCreateId
      .mockReset()
      .mockReturnValueOnce("epic-1")
      .mockReturnValueOnce("story-1");
    mockResolveAgent.mockReturnValue({ provider: "claude-code", model: "claude-opus" });
    mockSpawnClaude.mockReturnValue({
      promise: Promise.resolve({ success: true, result: "AI JSON" }),
    });
    mockExtractJson.mockReturnValue([
      {
        title: "Stabilize Chat Resume Flow",
        description: "Fix resume failures and add fallback behavior.",
        priority: 2,
        userStories: [
          {
            title: "As a user, I want chat resumes to recover gracefully",
            description: "Ensure fallback to fresh prompt when expired.",
            acceptanceCriteria: "- [ ] Resume fallback works",
          },
        ],
      },
    ]);
    mockIsResumableProvider.mockReturnValue(false);
    mockGetProvider.mockReturnValue({
      spawn: vi.fn(() => ({
        promise: Promise.resolve({ success: true, result: "[]" }),
        kill: vi.fn(),
      })),
    });
  });

  it("returns 404 when report is missing or empty", async () => {
    // getQueue: project, report (null)
    dbMockState.getQueue = [{ id: "proj-1", gitRepoPath: "/tmp/repo" }, null];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "missing" }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain("Report not found");
  });

  it("creates epics and stories from parsed QA output", async () => {
    // getQueue: project, report, originalSession (null - no session), maxPosition
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      { id: "report-1", projectId: "proj-1", reportContent: "# Findings", namedAgentId: null, agentSessionId: null },
      // no originalSession lookup since agentSessionId is null
      { max: 3 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toHaveLength(1);
    expect(json.data.epics[0].id).toBe("epic-1");
    expect(dbMockState.insertCalls).toHaveLength(2);
    expect((dbMockState.insertCalls[0] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        id: "epic-1",
        title: "Stabilize Chat Resume Flow",
        type: "feature",
      }),
    );
    expect((dbMockState.insertCalls[1] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        id: "story-1",
        epicId: "epic-1",
      }),
    );
    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
  });

  it("creates a bug ticket from a failure digest cluster and references the source report", async () => {
    mockExtractJson.mockReturnValue([
      {
        title: "Stabilize recurring worker exits",
        description:
          "Observed 7 worker exits across tickets ARIJ-12 and ARIJ-29. Harden process cleanup and retry handling.",
        priority: 3,
        userStories: [
          {
            title: "Prevent the recurring worker exit cluster",
            description: "Implement and verify the proposed remediation.",
            acceptanceCriteria: "- [ ] Worker exits no longer recur",
          },
        ],
      },
    ]);
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      {
        id: "digest-report-1",
        projectId: "proj-1",
        reportContent:
          "## Cluster: Worker exits\n\nFrequency: 7\n\nAffected tickets: ARIJ-12, ARIJ-29",
        namedAgentId: null,
        agentSessionId: null,
        checkType: "failure_digest",
      },
      { max: 2 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(
      mockNextRequest(),
      mockRouteContext({ projectId: "proj-1", reportId: "digest-report-1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toEqual([
      { id: "epic-1", title: "Stabilize recurring worker exits" },
    ]);
    expect(mockResolveAgent).toHaveBeenCalledWith(
      "failure_digest",
      "proj-1",
      null,
    );
    expect(mockSpawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        prompt: expect.stringContaining(
          "generate one bug-fix ticket for each named failure cluster",
        ),
      }),
    );
    expect((dbMockState.insertCalls[0] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        id: "epic-1",
        type: "bug",
        description: expect.stringContaining(
          "Source: [Failure digest report `digest-report-1`](/projects/proj-1/qa?reportId=digest-report-1)",
        ),
      }),
    );
    expect((dbMockState.insertCalls[1] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        id: "story-1",
        epicId: "epic-1",
      }),
    );
    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
  });

  it("returns parse error with raw snippet when extracted JSON is non-object", async () => {
    const longOutput = "x".repeat(1301);
    mockSpawnClaude.mockReturnValue({
      promise: Promise.resolve({ success: true, result: longOutput }),
    });
    mockExtractJson.mockReturnValue("just text");
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      { id: "report-1", projectId: "proj-1", reportContent: "# Findings", namedAgentId: null, agentSessionId: null },
    ];

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe("Failed to parse epics JSON from agent response");
    expect(json.rawSnippet).toContain("[truncated]");
    expect(json.rawSnippet.length).toBeLessThan(longOutput.length);
    expect(dbMockState.insertCalls).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("forces type to 'feature' even when AI returns 'bug'", async () => {
    mockExtractJson.mockReturnValue([
      {
        title: "Fix Critical Security Issue",
        description: "Address XSS vulnerability in input handling.",
        priority: 3,
        type: "bug",
        userStories: [
          {
            title: "As a developer, I want inputs sanitized",
            description: "Sanitize all user inputs.",
            acceptanceCriteria: "- [ ] No XSS possible",
          },
        ],
      },
    ]);
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      { id: "report-1", projectId: "proj-1", reportContent: "# Findings", namedAgentId: null, agentSessionId: null },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toHaveLength(1);
    expect((dbMockState.insertCalls[0] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        type: "feature",
      }),
    );
  });

  it("normalizes epics payload with aliases and defaults", async () => {
    mockExtractJson.mockReturnValue({
      epics: [
        {
          title: "  Session Resume Reliability  ",
          description: "   ",
          priority: "10",
          type: "other",
          user_stories: [
            {
              title: "  Handle expired resume sessions  ",
              description: "  fallback to fresh prompt  ",
              acceptance_criteria: "  - [ ] Retry with fresh prompt  ",
            },
            { title: "   " },
          ],
        },
      ],
    });
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      { id: "report-1", projectId: "proj-1", reportContent: "# Findings", namedAgentId: null, agentSessionId: null },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toEqual([{ id: "epic-1", title: "Session Resume Reliability" }]);
    expect((dbMockState.insertCalls[0] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        id: "epic-1",
        title: "Session Resume Reliability",
        description: "Epic generated from QA report findings.",
        priority: 3,
        type: "feature",
      }),
    );
    expect((dbMockState.insertCalls[1] as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        id: "story-1",
        title: "Handle expired resume sessions",
        description: "fallback to fresh prompt",
        acceptanceCriteria: "- [ ] Retry with fresh prompt",
      }),
    );
  });

  it("uses the same agent and resumes session from the QA report's original session", async () => {
    mockIsResumableProvider.mockReturnValue(true);
    // getQueue: project, report, originalSession, maxPosition
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      {
        id: "report-1",
        projectId: "proj-1",
        reportContent: "# Findings\nSome issues found.",
        namedAgentId: "agent-42",
        agentSessionId: "session-original",
        checkType: "tech_check",
      },
      // originalSession lookup
      {
        provider: "claude-code",
        model: "claude-opus-4",
        cliSessionId: "cli-sess-abc",
        claudeSessionId: "claude-sess-abc",
        namedAgentId: "agent-42",
      },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toHaveLength(1);

    // Verify spawnClaude was called with resume options
    expect(mockSpawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        model: "claude-opus-4",
        cliSessionId: "cli-sess-abc",
        resumeSession: true,
      }),
    );

    // Verify the agent was resolved with the original session's namedAgentId
    expect(mockResolveAgent).toHaveBeenCalledWith(
      "tech_check",
      "proj-1",
      "agent-42",
    );
  });

  it("falls back to fresh prompt when resume fails", async () => {
    mockIsResumableProvider.mockReturnValue(true);
    // First call (resume) fails, second call (fresh) succeeds
    mockSpawnClaude
      .mockReturnValueOnce({
        promise: Promise.resolve({ success: false, error: "Session expired" }),
      })
      .mockReturnValueOnce({
        promise: Promise.resolve({ success: true, result: "AI JSON" }),
      });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // getQueue: project, report, originalSession, maxPosition
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      {
        id: "report-1",
        projectId: "proj-1",
        reportContent: "# Findings",
        namedAgentId: "agent-42",
        agentSessionId: "session-original",
      },
      {
        provider: "claude-code",
        model: "claude-opus-4",
        cliSessionId: "cli-sess-expired",
        claudeSessionId: null,
        namedAgentId: "agent-42",
      },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toHaveLength(1);

    // Should have been called twice: once with resume, once without
    expect(mockSpawnClaude).toHaveBeenCalledTimes(2);
    expect(mockSpawnClaude).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cliSessionId: "cli-sess-expired",
        resumeSession: true,
      }),
    );
    expect(mockSpawnClaude).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cliSessionId: undefined,
        resumeSession: false,
      }),
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[qa/create-epics] Resume failed, falling back to fresh prompt",
      expect.objectContaining({
        provider: "claude-code",
        cliSessionId: "cli-sess-expired",
      }),
    );
  });

  it("falls back to fresh prompt when resume succeeds with empty result", async () => {
    mockIsResumableProvider.mockReturnValue(true);
    // First call (resume) succeeds but with empty result (e.g. OpenCode exits 0 with ZodError in stderr)
    mockSpawnClaude
      .mockReturnValueOnce({
        promise: Promise.resolve({ success: true, result: "" }),
      })
      .mockReturnValueOnce({
        promise: Promise.resolve({ success: true, result: "AI JSON" }),
      });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // getQueue: project, report, originalSession, maxPosition
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      {
        id: "report-1",
        projectId: "proj-1",
        reportContent: "# Findings",
        namedAgentId: "agent-42",
        agentSessionId: "session-original",
      },
      {
        provider: "claude-code",
        model: "claude-opus-4",
        cliSessionId: "cli-sess-bad-format",
        claudeSessionId: null,
        namedAgentId: "agent-42",
      },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.epics).toHaveLength(1);

    // Should have been called twice: once with resume (empty result), once fresh
    expect(mockSpawnClaude).toHaveBeenCalledTimes(2);
    expect(mockSpawnClaude).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cliSessionId: "cli-sess-bad-format",
        resumeSession: true,
      }),
    );
    expect(mockSpawnClaude).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cliSessionId: undefined,
        resumeSession: false,
      }),
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[qa/create-epics] Resume failed, falling back to fresh prompt",
      expect.objectContaining({
        provider: "claude-code",
        cliSessionId: "cli-sess-bad-format",
      }),
    );
  });

  it("skips resume for non-resumable providers", async () => {
    mockIsResumableProvider.mockReturnValue(false);
    mockResolveAgent.mockReturnValue({ provider: "codex", model: "gpt-4o" });

    const mockProviderSpawn = vi.fn(() => ({
      promise: Promise.resolve({ success: true, result: "AI JSON" }),
      kill: vi.fn(),
    }));
    mockGetProvider.mockReturnValue({ spawn: mockProviderSpawn });

    // getQueue: project, report, originalSession, maxPosition
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      {
        id: "report-1",
        projectId: "proj-1",
        reportContent: "# Findings",
        namedAgentId: null,
        agentSessionId: "session-codex",
      },
      {
        provider: "codex",
        model: "gpt-4o",
        cliSessionId: "codex-sess-123",
        claudeSessionId: null,
        namedAgentId: null,
      },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);

    // Should use the dynamic provider (codex), not spawnClaude
    expect(mockSpawnClaude).not.toHaveBeenCalled();
    expect(mockGetProvider).toHaveBeenCalledWith("codex");
    expect(mockProviderSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        model: "gpt-4o",
        resumeSession: false,
      }),
    );
  });

  it("uses original session's provider and model even if different from resolved agent", async () => {
    mockIsResumableProvider.mockReturnValue(true);
    // resolveAgent returns default claude-code, but original session used gemini-cli
    mockResolveAgent.mockReturnValue({ provider: "claude-code", model: "claude-opus" });

    const mockProviderSpawn = vi.fn(() => ({
      promise: Promise.resolve({ success: true, result: "AI JSON" }),
      kill: vi.fn(),
    }));
    mockGetProvider.mockReturnValue({ spawn: mockProviderSpawn });

    // getQueue: project, report, originalSession, maxPosition
    dbMockState.getQueue = [
      { id: "proj-1", gitRepoPath: "/tmp/repo" },
      {
        id: "report-1",
        projectId: "proj-1",
        reportContent: "# Findings",
        namedAgentId: "agent-gemini",
        agentSessionId: "session-gemini",
      },
      {
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
        cliSessionId: "gemini-sess-xyz",
        claudeSessionId: null,
        namedAgentId: "agent-gemini",
      },
      { max: 0 },
    ];

    const { POST } = await import(
      "@/app/api/projects/[projectId]/qa/reports/[reportId]/create-epics/route"
    );
    const res = await POST(mockNextRequest(), mockRouteContext({ projectId: "proj-1", reportId: "report-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);

    // Should use gemini-cli provider (from original session), not claude-code
    expect(mockSpawnClaude).not.toHaveBeenCalled();
    expect(mockGetProvider).toHaveBeenCalledWith("gemini-cli");
    expect(mockProviderSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        model: "gemini-2.0-flash",
        cliSessionId: "gemini-sess-xyz",
        resumeSession: true,
      }),
    );
  });
});
