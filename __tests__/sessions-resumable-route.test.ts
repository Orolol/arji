import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
}));

const drizzle = vi.hoisted(() => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
}));

const mockResolveAgent = vi.hoisted(() =>
  vi.fn(() => ({ provider: "claude-code", namedAgentId: null })),
);
const mockResolveAgentByNamedId = vi.hoisted(() =>
  vi.fn(() => ({ provider: "claude-code", namedAgentId: null })),
);

vi.mock("drizzle-orm", () => drizzle);

vi.mock("@/lib/db", () => {
  const chain: {
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
  } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.get.mockImplementation(() => mockState.getQueue.shift() ?? null);
  chain.all.mockImplementation(() => mockState.allQueue.shift() ?? []);

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "agentSessions.id",
    projectId: "agentSessions.projectId",
    status: "agentSessions.status",
    cliSessionId: "agentSessions.cliSessionId",
    epicId: "agentSessions.epicId",
    userStoryId: "agentSessions.userStoryId",
    agentType: "agentSessions.agentType",
    provider: "agentSessions.provider",
    namedAgentId: "agentSessions.namedAgentId",
    claudeSessionId: "agentSessions.claudeSessionId",
    lastNonEmptyText: "agentSessions.lastNonEmptyText",
    completedAt: "agentSessions.completedAt",
  },
  namedAgents: {
    id: "namedAgents.id",
    provider: "namedAgents.provider",
  },
}));

vi.mock("@/lib/agent-config/providers", () => ({
  resolveAgent: mockResolveAgent,
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

function mockRequest(url: string) {
  return { url } as unknown as import("next/server").NextRequest;
}

describe("sessions/resumable route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.getQueue = [];
    mockState.allQueue = [];
    mockResolveAgent.mockReturnValue({ provider: "claude-code", namedAgentId: null });
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      namedAgentId: null,
    });
  });

  it("returns empty data when resolved provider is codex", async () => {
    mockResolveAgent.mockReturnValue({ provider: "codex", namedAgentId: null });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/resumable/route"
    );
    const res = await GET(
      mockRequest(
        "http://localhost/api/projects/proj-1/sessions/resumable?agentType=build",
      ),
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
  });

  it("filters by resolved provider and named agent when agentType is present", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "gemini-cli",
      namedAgentId: "agent-gem",
    });
    mockState.allQueue = [
      [
        {
          id: "sess-1",
          cliSessionId: "cli-1",
          claudeSessionId: null,
          provider: "gemini-cli",
          namedAgentId: "agent-gem",
          agentType: "ticket_build",
          lastNonEmptyText: "done",
          completedAt: "2026-02-14T00:00:00.000Z",
        },
      ],
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/resumable/route"
    );
    const res = await GET(
      mockRequest(
        "http://localhost/api/projects/proj-1/sessions/resumable?epicId=epic-1&userStoryId=story-1&agentType=ticket_build&namedAgentId=agent-gem&provider=claude-code",
      ),
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe("sess-1");
    expect(mockResolveAgentByNamedId).toHaveBeenCalledWith(
      "ticket_build",
      "proj-1",
      "agent-gem",
    );
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.provider", "gemini-cli");
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.namedAgentId", "agent-gem");
  });

  it("resolves provider from namedAgentId when agentType is absent", async () => {
    mockState.getQueue = [{ id: "agent-gem", provider: "gemini-cli" }];
    mockState.allQueue = [[{ id: "sess-2", cliSessionId: "cli-2" }]];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/resumable/route"
    );
    const res = await GET(
      mockRequest(
        "http://localhost/api/projects/proj-1/sessions/resumable?namedAgentId=agent-gem&provider=claude-code",
      ),
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(drizzle.eq).toHaveBeenCalledWith("namedAgents.id", "agent-gem");
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.provider", "gemini-cli");
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.namedAgentId", "agent-gem");
  });

  it("returns empty when namedAgentId is unknown and agentType is absent", async () => {
    mockState.getQueue = [null];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/resumable/route"
    );
    const res = await GET(
      mockRequest(
        "http://localhost/api/projects/proj-1/sessions/resumable?namedAgentId=missing-agent",
      ),
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
  });
});
