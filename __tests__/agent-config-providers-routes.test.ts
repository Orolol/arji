import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockProviderHelpers = vi.hoisted(() => ({
  listGlobalAgentProviders: vi.fn(),
  listMergedProjectAgentProviders: vi.fn(),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  listGlobalAgentProviders: mockProviderHelpers.listGlobalAgentProviders,
  listMergedProjectAgentProviders: mockProviderHelpers.listMergedProjectAgentProviders,
}));

// Real @/lib/db/schema: side-effect-free pure builders that the chain mock
// ignores. No fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "apd-1"),
}));

describe("Agent provider default routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockProviderHelpers.listGlobalAgentProviders.mockResolvedValue([]);
    mockProviderHelpers.listMergedProjectAgentProviders.mockResolvedValue([]);
  });

  it("GET /api/agent-config/providers returns defaults for all agent types", async () => {
    mockProviderHelpers.listGlobalAgentProviders.mockResolvedValue([
      {
        agentType: "build",
        provider: "claude-code",
        source: "builtin",
        scope: "global",
      },
    ]);

    const { GET } = await import("@/app/api/agent-config/providers/route");
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data[0].agentType).toBe("build");
  });

  it("PUT /api/agent-config/providers/[agentType] validates provider values", async () => {
    const { PUT } = await import(
      "@/app/api/agent-config/providers/[agentType]/route"
    );

    const res = await PUT(mockJsonRequest({ provider: "invalid" }), mockRouteContext({ agentType: "build" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("invalid provider");
  });

  it("PUT /api/agent-config/providers/[agentType] upserts global defaults", async () => {
    const { PUT } = await import(
      "@/app/api/agent-config/providers/[agentType]/route"
    );
    dbMockState.getQueue = [
      null,
      {
        id: "apd-1",
        agentType: "build",
        provider: "codex",
        scope: "global",
      },
    ];

    const res = await PUT(mockJsonRequest({ provider: "codex" }), mockRouteContext({ agentType: "build" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.provider).toBe("codex");
  });

  it("PUT assigns a named agent to a global role", async () => {
    const { PUT } = await import(
      "@/app/api/agent-config/providers/[agentType]/route"
    );
    dbMockState.getQueue = [
      { id: "agent-1", provider: "codex" },
      null,
      {
        id: "apd-1",
        agentType: "build",
        provider: "codex",
        namedAgentId: "agent-1",
        scope: "global",
      },
    ];

    const res = await PUT(
      mockJsonRequest({ namedAgentId: "agent-1" }),
      mockRouteContext({ agentType: "build" })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.namedAgentId).toBe("agent-1");
  });

  it("DELETE clears a global role assignment", async () => {
    const { DELETE } = await import(
      "@/app/api/agent-config/providers/[agentType]/route"
    );

    const res = await DELETE(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ agentType: "build" })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.ok).toBe(true);
  });

  it("GET /api/projects/[projectId]/agent-config/providers returns merged defaults", async () => {
    dbMockState.getQueue = [{ id: "proj-1" }];
    mockProviderHelpers.listMergedProjectAgentProviders.mockResolvedValue([
      {
        agentType: "build",
        provider: "codex",
        source: "project",
        scope: "proj-1",
      },
      {
        agentType: "chat",
        provider: "claude-code",
        source: "builtin",
        scope: "global",
      },
    ]);

    const { GET } = await import(
      "@/app/api/projects/[projectId]/agent-config/providers/route"
    );
    const res = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data[0].source).toBe("project");
    expect(json.data[1].provider).toBe("claude-code");
  });

  it("PUT /api/projects/[projectId]/agent-config/providers/[agentType] sets project override", async () => {
    const { PUT } = await import(
      "@/app/api/projects/[projectId]/agent-config/providers/[agentType]/route"
    );
    dbMockState.getQueue = [
      { id: "proj-1" },
      null,
      {
        id: "apd-1",
        agentType: "chat",
        provider: "codex",
        scope: "proj-1",
      },
    ];

    const res = await PUT(mockJsonRequest({ provider: "codex" }), mockRouteContext({ projectId: "proj-1", agentType: "chat" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.scope).toBe("proj-1");
    expect(json.data.provider).toBe("codex");
  });

  it("DELETE clears a project role assignment", async () => {
    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/agent-config/providers/[agentType]/route"
    );
    dbMockState.getQueue = [{ id: "proj-1" }];

    const res = await DELETE(
      mockNextRequest({ method: "DELETE" }),
      mockRouteContext({ projectId: "proj-1", agentType: "chat" })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.ok).toBe(true);
  });
});
