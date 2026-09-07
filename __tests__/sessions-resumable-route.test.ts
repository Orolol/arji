import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

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
  vi.fn(() => ({ provider: "claude-code", namedAgentId: null as string | null })),
);
const mockResolveAgentByNamedId = vi.hoisted(() =>
  vi.fn(() => ({ provider: "claude-code", namedAgentId: null as string | null })),
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

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgent: mockResolveAgent,
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

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

  /**
   * The DB rows are deliberately non-empty: the endpoint must refuse on the
   * provider's capability, not just happen to find nothing.
   */
  it.each(["codex"])(
    "returns empty data for the non-resumable provider %s",
    async (provider) => {
      mockResolveAgent.mockReturnValue({ provider, namedAgentId: null });
      mockState.allQueue = [
        [
          {
            id: "sess-x",
            cliSessionId: "cli-x",
            provider,
            namedAgentId: null,
            agentType: "build",
            lastNonEmptyText: "done",
            completedAt: "2026-08-19T00:00:00.000Z",
          },
        ],
      ];

      const { GET } = await import(
        "@/app/api/projects/[projectId]/sessions/resumable/route"
      );
      const res = await GET(
        mockNextRequest({
          url: "http://localhost/api/projects/proj-1/sessions/resumable?agentType=build",
        }),
        mockRouteContext({ projectId: "proj-1" }),
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data).toEqual([]);
    },
  );

  it.each(["oh-my-pi"])(
    "filters to the resolved provider's own sessions for %s",
    async (provider) => {
      mockResolveAgent.mockReturnValue({ provider, namedAgentId: null });
      mockState.allQueue = [
        [
          {
            id: "sess-omp",
            cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
            provider,
            namedAgentId: null,
            agentType: "build",
            lastNonEmptyText: "done",
            completedAt: "2026-08-19T00:00:00.000Z",
          },
        ],
      ];

      const { GET } = await import(
        "@/app/api/projects/[projectId]/sessions/resumable/route"
      );
      const res = await GET(
        mockNextRequest({
          url: "http://localhost/api/projects/proj-1/sessions/resumable?agentType=build",
        }),
        mockRouteContext({ projectId: "proj-1" }),
      );

      const json = await res.json();
      expect(json.data).toHaveLength(1);
      // Without this filter an unrecognised provider dropped the WHERE clause
      // and other providers' sessions leaked in as resume candidates.
      expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.provider", provider);
    },
  );

  it("filters by resolved provider and named agent when agentType is present", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "oh-my-pi",
      namedAgentId: "agent-omp",
    });
    mockState.allQueue = [
      [
        {
          id: "sess-1",
          cliSessionId: "cli-1",
          claudeSessionId: null,
          provider: "oh-my-pi",
          namedAgentId: "agent-omp",
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
      mockNextRequest({
          url: "http://localhost/api/projects/proj-1/sessions/resumable?epicId=epic-1&userStoryId=story-1&agentType=ticket_build&namedAgentId=agent-omp&provider=claude-code",
      }),
      mockRouteContext({ projectId: "proj-1" }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe("sess-1");
    expect(mockResolveAgentByNamedId).toHaveBeenCalledWith(
      "ticket_build",
      "proj-1",
      "agent-omp",
    );
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.provider", "oh-my-pi");
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.namedAgentId", "agent-omp");
  });

  it("resolves provider and member from namedAgentId even when agentType is absent", async () => {
    mockState.getQueue = [{ id: "agent-omp" }];
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "oh-my-pi", namedAgentId: "agent-omp",
    });
    mockState.allQueue = [[{ id: "sess-2", cliSessionId: "cli-2" }]];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/resumable/route"
    );
    const res = await GET(
      mockNextRequest({
          url: "http://localhost/api/projects/proj-1/sessions/resumable?namedAgentId=agent-omp&provider=claude-code",
      }),
      mockRouteContext({ projectId: "proj-1" }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(mockResolveAgentByNamedId).toHaveBeenCalledWith("build", "proj-1", "agent-omp");
    expect(drizzle.eq).toHaveBeenCalledWith("namedAgents.id", "agent-omp");
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.provider", "oh-my-pi");
    expect(drizzle.eq).toHaveBeenCalledWith("agentSessions.namedAgentId", "agent-omp");
  });

  it("returns empty when namedAgentId is unknown and agentType is absent", async () => {
    mockState.getQueue = [null];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/resumable/route"
    );
    const res = await GET(
      mockNextRequest({
          url: "http://localhost/api/projects/proj-1/sessions/resumable?namedAgentId=missing-agent",
      }),
      mockRouteContext({ projectId: "proj-1" }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
  });
});
