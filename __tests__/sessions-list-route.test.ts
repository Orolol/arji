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
        lastNonEmptyText: "Applying migrations",
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
    expect(json.data[0].lastNonEmptyText).toBe("Applying migrations");
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
