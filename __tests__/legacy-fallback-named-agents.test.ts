/**
 * Tests for legacy fallback behavior of the named agent resolution system.
 *
 * Covers:
 * - resolveAgentByNamedId() with valid, invalid, and null namedAgentId
 * - resolveAgent() full fallback chain: project -> global -> seeded "Claude Code" -> FALLBACK_PROVIDER
 * - Seeded global default agent ("Claude Code") as the final named-agent fallback
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

// ---------------------------------------------------------------------------
// resolveAgentByNamedId
// ---------------------------------------------------------------------------

describe("resolveAgentByNamedId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getQueue = [];
  });

  it("returns the named agent's provider, model, and name when namedAgentId is valid", async () => {
    // Named agent lookup returns a valid row
    mockDb.getQueue = [
      {
        id: "named-1",
        name: "CC Opus",
        provider: "claude-code",
        model: "claude-opus-4-6",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("build", "proj-1", "named-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("CC Opus");
  });

  it("returns codex named agent correctly", async () => {
    mockDb.getQueue = [
      {
        id: "codex-agent",
        name: "Codex Fast",
        provider: "codex",
        model: "o3-mini",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("chat", undefined, "codex-agent");

    expect(result.provider).toBe("codex");
    expect(result.model).toBe("o3-mini");
    expect(result.name).toBe("Codex Fast");
  });

  it("returns gemini-cli named agent correctly", async () => {
    mockDb.getQueue = [
      {
        id: "gem-1",
        name: "Gemini Pro",
        provider: "gemini-cli",
        model: "gemini-2.5-pro",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("build", "proj-1", "gem-1");

    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.name).toBe("Gemini Pro");
  });

  it("falls through to resolveAgent when namedAgentId is invalid (not found)", async () => {
    // Named agent lookup: null (not found)
    // resolveAgent project scope: null
    // resolveAgent global scope: has a default
    mockDb.getQueue = [
      null, // named agent not found for "deleted-id"
      null, // project scope default not found
      { provider: "codex", namedAgentId: null }, // global scope default
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("build", "proj-1", "deleted-id");

    expect(result.provider).toBe("codex");
    expect(result.model).toBeUndefined();
    expect(result.name).toBeUndefined();
  });

  it("falls through to resolveAgent when namedAgentId is null", async () => {
    // No named agent lookup at all — goes straight to resolveAgent
    // resolveAgent project scope: null
    // resolveAgent global scope: has a default with namedAgentId
    mockDb.getQueue = [
      null, // project scope default not found
      { provider: "claude-code", namedAgentId: "global-agent" }, // global scope default
      {
        id: "global-agent",
        name: "Global CC",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("build", "proj-1", null);

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Global CC");
  });

  it("falls through to resolveAgent when namedAgentId is undefined", async () => {
    // No named agent lookup — goes straight to resolveAgent
    // resolveAgent global scope: has a default (no projectId provided)
    mockDb.getQueue = [
      { provider: "gemini-cli", namedAgentId: null }, // global scope default
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("chat", undefined, undefined);

    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBeUndefined();
  });

  it("falls through to resolveAgent when namedAgentId is empty string", async () => {
    // Empty string is falsy, so no named agent lookup
    // resolveAgent: no project scope, global scope has default
    mockDb.getQueue = [
      { provider: "codex", namedAgentId: null }, // global scope default
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("chat", undefined, "");

    expect(result.provider).toBe("codex");
    expect(result.model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveAgent fallback chain
// ---------------------------------------------------------------------------

describe("resolveAgent fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getQueue = [];
  });

  it("uses project default when available", async () => {
    mockDb.getQueue = [
      { provider: "gemini-cli", namedAgentId: null }, // project scope
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBeUndefined();
  });

  it("uses project default with named agent", async () => {
    mockDb.getQueue = [
      { provider: "claude-code", namedAgentId: "proj-agent" }, // project scope
      {
        id: "proj-agent",
        name: "Project Agent",
        provider: "codex",
        model: "o3",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("codex");
    expect(result.model).toBe("o3");
    expect(result.name).toBe("Project Agent");
  });

  it("falls to global default when project default is missing", async () => {
    mockDb.getQueue = [
      null, // project scope: not found
      { provider: "codex", namedAgentId: null }, // global scope
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("codex");
    expect(result.model).toBeUndefined();
  });

  it("falls to global default with named agent when project default is missing", async () => {
    mockDb.getQueue = [
      null, // project scope: not found
      { provider: "claude-code", namedAgentId: "global-agent" }, // global scope
      {
        id: "global-agent",
        name: "Global Opus",
        provider: "claude-code",
        model: "claude-opus-4-6",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("Global Opus");
  });

  it("falls to seeded 'Claude Code' named agent when no defaults exist", async () => {
    // project scope: null, global scope: null
    // seeded default agent lookup: returns the "Claude Code" agent
    mockDb.getQueue = [
      null, // project scope
      null, // global scope
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("falls to seeded 'Claude Code' agent without projectId", async () => {
    // global scope: null
    // seeded default agent lookup: returns the "Claude Code" agent
    mockDb.getQueue = [
      null, // global scope
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("chat");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("returns FALLBACK_PROVIDER when no defaults and no seeded agent exist", async () => {
    // project scope: null, global scope: null, seeded agent: null
    mockDb.getQueue = [null, null, null];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });

  it("returns FALLBACK_PROVIDER without projectId when nothing exists", async () => {
    // global scope: null, seeded agent: null
    mockDb.getQueue = [null, null];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("chat");

    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });

  it("falls back to raw provider when project default has deleted named agent", async () => {
    // project scope: has default referencing a deleted named agent
    // named agent lookup: null (deleted)
    mockDb.getQueue = [
      { provider: "codex", namedAgentId: "deleted-agent" },
      null, // named agent not found
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("codex");
    expect(result.model).toBeUndefined();
    expect(result.name).toBeUndefined();
  });

  it("falls back to raw provider when global default has deleted named agent", async () => {
    // project scope: null
    // global scope: has default referencing a deleted named agent
    // named agent lookup: null (deleted)
    mockDb.getQueue = [
      null, // project scope
      { provider: "gemini-cli", namedAgentId: "deleted-agent" },
      null, // named agent not found
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBeUndefined();
    expect(result.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Seeded global default agent
// ---------------------------------------------------------------------------

describe("seeded global default agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getQueue = [];
  });

  it("GLOBAL_DEFAULT_AGENT_NAME is 'Claude Code'", async () => {
    const { GLOBAL_DEFAULT_AGENT_NAME } = await import(
      "@/lib/agent-config/providers"
    );
    expect(GLOBAL_DEFAULT_AGENT_NAME).toBe("Claude Code");
  });

  it("seeded agent is used as last-resort before bare FALLBACK_PROVIDER", async () => {
    // No project, no global default — only the seeded "Claude Code" agent exists
    mockDb.getQueue = [
      null, // global scope default
      {
        id: "seed-1",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/providers");
    const result = resolveAgent("spec_generation");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("resolveAgentByNamedId reaches seeded agent when namedAgentId is null and no defaults", async () => {
    // Falls through to resolveAgent -> seeded agent
    mockDb.getQueue = [
      null, // global scope default
      {
        id: "seed-1",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId("review_code", undefined, null);

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("resolveAgentByNamedId reaches FALLBACK_PROVIDER when seeded agent also missing", async () => {
    // Falls through resolveAgent -> seeded agent not found -> bare FALLBACK_PROVIDER
    mockDb.getQueue = [
      null, // named agent lookup (invalid id)
      null, // project scope default
      null, // global scope default
      null, // seeded "Claude Code" agent not found
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/providers"
    );
    const result = resolveAgentByNamedId(
      "team_build",
      "proj-1",
      "nonexistent-id",
    );

    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });
});
