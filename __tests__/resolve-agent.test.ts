/**
 * Tests for resolveAgent() — named agent resolution with project/global/fallback chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  getQueue: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDb.getQueue.shift() ?? null),
    all: vi.fn(() => []),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  agentProviderDefaults: {
    agentType: "agentType",
    provider: "provider",
    namedAgentId: "namedAgentId",
    scope: "scope",
  },
  namedAgents: {
    id: "id",
    name: "name",
    provider: "provider",
    model: "model",
  },
}));

describe("resolveAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getQueue = [];
  });

  it("returns fallback provider when no defaults exist", async () => {
    // project scope: null, global scope: null
    mockDb.getQueue = [null, null];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");
    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });

  it("uses global default when no project default exists", async () => {
    // project scope: null
    // global scope: has default with no named agent
    mockDb.getQueue = [null, { provider: "codex", namedAgentId: null }];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");
    expect(result.provider).toBe("codex");
    expect(result.model).toBeUndefined();
  });

  it("uses project default over global default", async () => {
    // project scope: has default
    mockDb.getQueue = [{ provider: "gemini-cli", namedAgentId: null }];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");
    expect(result.provider).toBe("gemini-cli");
  });

  it("resolves named agent with model when namedAgentId is set", async () => {
    // project scope: has default with named agent
    // named agent lookup: returns agent details
    mockDb.getQueue = [
      { provider: "claude-code", namedAgentId: "agent-1" },
      {
        id: "agent-1",
        name: "CC Opus",
        provider: "claude-code",
        model: "claude-opus-4-6",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");
    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("CC Opus");
  });

  it("falls back to raw provider when named agent was deleted", async () => {
    // project scope: has default with namedAgentId that no longer exists
    // named agent lookup: returns null (deleted)
    mockDb.getQueue = [
      { provider: "codex", namedAgentId: "deleted-agent" },
      null, // named agent not found
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");
    expect(result.provider).toBe("codex");
    expect(result.model).toBeUndefined();
  });

  it("resolves gemini-cli named agent", async () => {
    mockDb.getQueue = [
      { provider: "gemini-cli", namedAgentId: "gem-agent" },
      {
        id: "gem-agent",
        name: "Gemini Flash",
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");
    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBe("gemini-2.0-flash");
    expect(result.name).toBe("Gemini Flash");
  });

  it("works without projectId (global-only resolution)", async () => {
    // global scope: has default
    mockDb.getQueue = [{ provider: "codex", namedAgentId: null }];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("chat");
    expect(result.provider).toBe("codex");
  });

  it("returns fallback when global has no default and no projectId", async () => {
    mockDb.getQueue = [null];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("chat");
    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });
});
