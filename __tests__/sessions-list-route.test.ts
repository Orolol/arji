import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  getDbChainMock,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const { mockLastSessionChunkAt } = vi.hoisted(() => ({
  mockLastSessionChunkAt: vi.fn(),
}));

// The route runs two sequential list queries (agent sessions, then chat
// conversations); chunk activity uses the indexed SessionChunkStore helper.
// Real drizzle-orm + real @/lib/db/schema, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/chunks", () => ({
  lastSessionChunkAt: mockLastSessionChunkAt,
}));

function setupSessionsChain(data: unknown[]) {
  dbMockState.allQueue[0] = data;
}

function setupConversationsChain(data: unknown[]) {
  dbMockState.allQueue[1] = data;
}

describe("sessions list route (unified)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockLastSessionChunkAt.mockReturnValue(null);
  });

  it("returns agent sessions with kind='agent_session'", async () => {
    setupSessionsChain([
      {
        id: "sess-1",
        status: "running",
        producedOutput: 1,
        createdAt: "2026-02-12T00:00:00.000Z",
      },
    ]);
    setupConversationsChain([]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].kind).toBe("agent_session");
    // The text itself never leaves the database: the list only ever asked
    // whether the run had spoken.
    expect(json.data[0]).not.toHaveProperty("lastNonEmptyText");
  });

  it("returns chat conversations with kind='chat_session'", async () => {
    setupSessionsChain([]);
    setupConversationsChain([
      {
        id: "conv-1",
        type: "brainstorm",
        label: "My Chat",
        status: "active",
        provider: "claude-code",
        namedAgentName: null,
        messageCount: 5,
        lastMessagePreview: "Hello world",
        lastMessageAt: "2026-02-12T02:00:00.000Z",
        createdAt: "2026-02-12T01:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

    const json = await response.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].kind).toBe("chat_session");
    expect(json.data[0].label).toBe("My Chat");
    expect(json.data[0].messageCount).toBe(5);
    expect(json.data[0].lastMessagePreview).toBe("Hello world");
    expect(json.data[0].lastActivityAt).toBe("2026-02-12T02:00:00.000Z");
    expect(json.data[0]).not.toHaveProperty("lastMessageAt");
  });

  it("merges and sorts both types by createdAt descending", async () => {
    setupSessionsChain([
      {
        id: "sess-1",
        status: "completed",
        createdAt: "2026-02-12T00:00:00.000Z",
      },
      {
        id: "sess-2",
        status: "running",
        createdAt: "2026-02-12T03:00:00.000Z",
      },
    ]);
    setupConversationsChain([
      {
        id: "conv-1",
        type: "epic",
        label: "Epic Chat",
        status: "generated",
        createdAt: "2026-02-12T01:00:00.000Z",
        messageCount: 3,
        lastMessagePreview: null,
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

    const json = await response.json();
    expect(json.data).toHaveLength(3);
    // Sorted desc: sess-2 (03:00), conv-1 (01:00), sess-1 (00:00)
    expect(json.data[0].id).toBe("sess-2");
    expect(json.data[0].kind).toBe("agent_session");
    expect(json.data[1].id).toBe("conv-1");
    expect(json.data[1].kind).toBe("chat_session");
    expect(json.data[2].id).toBe("sess-1");
    expect(json.data[2].kind).toBe("agent_session");
  });

  it("preserves existing agent session shape (backward compatible)", async () => {
    setupSessionsChain([
      {
        id: "sess-1",
        status: "completed",
        mode: "code",
        provider: "claude-code",
        agentType: "build",
        branchName: "feat/test",
        model: "opus-4",
        error: null,
        createdAt: "2026-02-12T00:00:00.000Z",
      },
    ]);
    setupConversationsChain([]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

    const json = await response.json();
    const session = json.data[0];
    expect(session.mode).toBe("code");
    expect(session.provider).toBe("claude-code");
    expect(session.agentType).toBe("build");
    expect(session.branchName).toBe("feat/test");
    expect(session.model).toBe("opus-4");
  });

  it("derives agent last activity from output and lifecycle timestamps", async () => {
    setupSessionsChain([
      {
        id: "sess-output",
        status: "running",
        createdAt: "2026-02-12 00:00:00",
        startedAt: "2026-02-12T01:00:00.000Z",
        endedAt: null,
        completedAt: null,
      },
      {
        id: "sess-terminal",
        status: "completed",
        createdAt: "2026-02-12T00:00:00.000Z",
        startedAt: "2026-02-12T01:00:00.000Z",
        endedAt: "2026-02-12T04:00:00.000Z",
        completedAt: "2026-02-12T04:00:00.000Z",
      },
    ]);
    mockLastSessionChunkAt.mockImplementation((sessionId: string) =>
      sessionId === "sess-output" ? "2026-02-12T05:00:00.000Z" : null
    );
    setupConversationsChain([]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "proj-1" })
    );

    const json = await response.json();
    expect(
      json.data.find((item: { id: string }) => item.id === "sess-output")
    ).toMatchObject({ lastActivityAt: "2026-02-12T05:00:00.000Z" });
    expect(
      json.data.find((item: { id: string }) => item.id === "sess-terminal")
    ).toMatchObject({ lastActivityAt: "2026-02-12T04:00:00.000Z" });
    expect(mockLastSessionChunkAt).toHaveBeenCalledTimes(1);
    expect(mockLastSessionChunkAt).toHaveBeenCalledWith("sess-output");

    // This route is polled by the board. Last activity must not turn that
    // polling path into a project-independent scan of the whole chunk table.
    expect(getDbChainMock().groupBy).not.toHaveBeenCalled();
  });

  it("selects an explicit projection that leaves the prompt behind", async () => {
    setupSessionsChain([{ id: "sess-1", status: "completed", createdAt: null }]);
    setupConversationsChain([]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

    // `select()` with no argument is what made this route read every column of
    // every session — on the live board that was ~40 MB per request, 99% of it
    // `prompt`, materialised synchronously on the one shared connection.
    const [sessionProjection] = getDbChainMock().select.mock.calls[0];
    expect(sessionProjection).toBeTypeOf("object");

    const selected = Object.keys(sessionProjection as Record<string, unknown>);
    expect(selected).not.toContain("prompt");
    // Fat columns the list has never rendered; the detail route still has them.
    expect(selected).not.toContain("logsPath");
    expect(selected).not.toContain("worktreePath");
    expect(selected).not.toContain("cliCommand");
    expect(selected).not.toContain("cliOptions");
    expect(selected).not.toContain("estimatedPromptBreakdown");
    // Uncapped at the write side and only ever read as "did the run speak" —
    // reduced to `producedOutput` in SQL rather than selected.
    expect(selected).not.toContain("lastNonEmptyText");
    // What the Sessions page, the board's failure badges and the cli-session
    // fallback do read.
    expect(selected).toEqual(
      expect.arrayContaining([
        "id",
        "epicId",
        "userStoryId",
        "status",
        "mode",
        "provider",
        "agentType",
        "branchName",
        "startedAt",
        "endedAt",
        "completedAt",
        "createdAt",
        "producedOutput",
        "error",
        "errorLength",
        "outcome",
        "totalCostUsd",
        "batchRunId",
        "namedAgentId",
        "namedAgentName",
        "cliSessionId",
        "claudeSessionId",
      ])
    );

    // The two text columns the list keeps are cut in SQL, not in JavaScript:
    // a value that never crosses into the process cannot blow the budget on
    // the way in either.
    const projection = sessionProjection as Record<
      string,
      { queryChunks?: unknown[] }
    >;
    // Drizzle keeps the literal SQL of a `sql` fragment as StringChunks; the
    // other chunks are columns and bound params, which carry no text.
    const sqlOf = (key: string) =>
      (projection[key]?.queryChunks ?? [])
        .map((chunk) => {
          const value = (chunk as { value?: unknown }).value;
          return Array.isArray(value) ? value.join("") : "";
        })
        .join(" ");
    expect(sqlOf("error")).toContain("substr");
    expect(sqlOf("errorLength")).toContain("length");
    expect(sqlOf("producedOutput")).toContain("trim");
  });

  it("bounds both list queries to one page", async () => {
    setupSessionsChain([]);
    setupConversationsChain([]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    await GET(
      mockNextRequest({ searchParams: { limit: "50" } }),
      mockRouteContext({ projectId: "proj-1" })
    );

    // One row beyond the page, on both streams: that extra row is how an
    // exhausted stream is told apart from a full one.
    expect(getDbChainMock().limit.mock.calls).toEqual([[51], [51]]);
  });

  it("keeps the list available when the chunk store cannot be read", async () => {
    setupSessionsChain([
      {
        id: "sess-live",
        status: "running",
        createdAt: "2026-02-12T00:00:00.000Z",
        startedAt: "2026-02-12T01:00:00.000Z",
      },
    ]);
    setupConversationsChain([]);
    mockLastSessionChunkAt.mockImplementation(() => {
      throw new Error("chunk store unavailable");
    });

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          id: "sess-live",
          lastActivityAt: "2026-02-12T01:00:00.000Z",
        }),
      ],
    });
  });
});
