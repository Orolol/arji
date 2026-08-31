/**
 * Route tests for GET /api/agent-config/named-agents/[agentId]/stats:
 * the `{ data }` envelope, a 404 for an unknown agent, a 500 `{ error }` when
 * the aggregate throws, and the `all` sentinel serving the roster payload from
 * the same file rather than a second route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const mockStats = vi.hoisted(() => ({
  getAgentDayStats: vi.fn(),
  getNamedAgentStats: vi.fn(),
  getNamedAgent: vi.fn(),
}));

vi.mock("@/lib/agent-config/agent-stats", () => ({
  getAgentDayStats: mockStats.getAgentDayStats,
  getNamedAgentStats: mockStats.getNamedAgentStats,
}));

vi.mock("@/lib/agent-config/named-agents", () => ({
  getNamedAgent: mockStats.getNamedAgent,
}));

const { GET } = await import(
  "@/app/api/agent-config/named-agents/[agentId]/stats/route"
);

const DAY_ROW = {
  namedAgentId: "agent-1",
  runsToday: 9,
  cleanRate: 0.89,
  costTodayUsd: 6.1,
  liveSessions: 2,
};

const AGENT_STATS = {
  windowDays: 14,
  runCount: 61,
  completedCount: 51,
  failedCount: 10,
  cleanRate: 0.84,
  medianDurationMs: 400_000,
  totalCostUsd: 41.2,
  escalationCount: 3,
  days: [],
  byRole: [],
};

describe("GET /api/agent-config/named-agents/[agentId]/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStats.getAgentDayStats.mockReturnValue([DAY_ROW]);
    mockStats.getNamedAgentStats.mockReturnValue(AGENT_STATS);
    mockStats.getNamedAgent.mockResolvedValue({ id: "agent-1" });
  });

  it("returns { data } with the 14-day payload for one agent", async () => {
    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ agentId: "agent-1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual(AGENT_STATS);
    expect(mockStats.getNamedAgentStats).toHaveBeenCalledWith("agent-1");
    expect(mockStats.getAgentDayStats).not.toHaveBeenCalled();
  });

  it("serves the roster payload for the `all` sentinel", async () => {
    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ agentId: "all" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ agents: [DAY_ROW] });
    // The sentinel must never be looked up as a real agent.
    expect(mockStats.getNamedAgent).not.toHaveBeenCalled();
    expect(mockStats.getNamedAgentStats).not.toHaveBeenCalled();
  });

  it("returns { error } with status 404 for an unknown agent", async () => {
    mockStats.getNamedAgent.mockResolvedValue(null);

    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ agentId: "nope" }),
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("Named agent not found");
    expect(mockStats.getNamedAgentStats).not.toHaveBeenCalled();
  });

  it("returns { error } with status 500 when aggregation fails", async () => {
    mockStats.getNamedAgentStats.mockImplementation(() => {
      throw new Error("no such table: agent_sessions");
    });

    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ agentId: "agent-1" }),
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe("no such table: agent_sessions");
  });

  it("returns { error } with status 500 when the roster aggregate fails", async () => {
    mockStats.getAgentDayStats.mockImplementation(() => {
      throw new Error("boom");
    });

    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ agentId: "all" }),
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});
