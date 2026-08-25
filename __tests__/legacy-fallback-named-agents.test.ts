/**
 * Tests for legacy fallback behavior of the named agent resolution system.
 *
 * Covers:
 * - resolveAgentByNamedId() with valid, invalid, and null namedAgentId
 * - resolveAgent() full fallback chain: project -> global -> seeded "Claude Code" -> FALLBACK_PROVIDER
 * - Seeded global default agent ("Claude Code") as the final named-agent fallback
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

// Real @/lib/db/schema (side-effect-free pure builders); the chain mock
// ignores column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

// ---------------------------------------------------------------------------
// resolveAgentByNamedId
// ---------------------------------------------------------------------------

describe("resolveAgentByNamedId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("returns the named agent's provider, model, and name when namedAgentId is valid", async () => {
    // Named agent lookup returns a valid row
    dbMockState.getQueue = [
      {
        id: "named-1",
        name: "CC Opus",
        provider: "claude-code",
        model: "claude-opus-4-6",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("build", "proj-1", "named-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("CC Opus");
  });

  it("returns codex named agent correctly", async () => {
    dbMockState.getQueue = [
      {
        id: "codex-agent",
        name: "Codex Fast",
        provider: "codex",
        model: "o3-mini",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("chat", undefined, "codex-agent");

    expect(result.provider).toBe("codex");
    expect(result.model).toBe("o3-mini");
    expect(result.name).toBe("Codex Fast");
  });

  it("returns gemini-cli named agent correctly", async () => {
    dbMockState.getQueue = [
      {
        id: "gem-1",
        name: "Gemini Pro",
        provider: "gemini-cli",
        model: "gemini-2.5-pro",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("build", "proj-1", "gem-1");

    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.name).toBe("Gemini Pro");
  });

  it("falls through to resolveAgent when namedAgentId is invalid (not found)", async () => {
    // Named agent lookup: null (not found)
    // resolveAgent project scope: null
    // resolveAgent global scope: has a named assignment
    dbMockState.getQueue = [
      null, // named agent not found for "deleted-id"
      null, // project scope default not found
      { provider: "codex", namedAgentId: "global-agent" },
      {
        id: "global-agent",
        name: "Global Codex",
        provider: "codex",
        model: "",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("build", "proj-1", "deleted-id");

    expect(result.provider).toBe("codex");
    expect(result.model).toBe("");
    expect(result.name).toBe("Global Codex");
  });

  it("falls through to resolveAgent when namedAgentId is null", async () => {
    // No named agent lookup at all — goes straight to resolveAgent
    // resolveAgent project scope: null
    // resolveAgent global scope: has a default with namedAgentId
    dbMockState.getQueue = [
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
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("build", "proj-1", null);

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Global CC");
  });

  it("falls through to resolveAgent when namedAgentId is undefined", async () => {
    // No named agent lookup — goes straight to resolveAgent
    // A legacy raw default is ignored in favour of the seeded agent.
    dbMockState.getQueue = [
      { provider: "gemini-cli", namedAgentId: null }, // global scope default
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("chat", undefined, undefined);

    expect(result.provider).toBe("claude-code");
    expect(result.name).toBe("Claude Code");
  });

  it("falls through to resolveAgent when namedAgentId is empty string", async () => {
    // Empty string is falsy, so no named agent lookup
    // Legacy raw defaults no longer pin a role invisibly.
    dbMockState.getQueue = [
      { provider: "codex", namedAgentId: null }, // global scope default
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      },
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("chat", undefined, "");

    expect(result.provider).toBe("claude-code");
    expect(result.name).toBe("Claude Code");
  });
});

// ---------------------------------------------------------------------------
// resolveAgent fallback chain
// ---------------------------------------------------------------------------

describe("resolveAgent fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("ignores a project default that has no named agent", async () => {
    dbMockState.getQueue = [
      { provider: "gemini-cli", namedAgentId: null }, // project scope
      null, // global scope
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.name).toBe("Claude Code");
  });

  it("uses project default with named agent", async () => {
    dbMockState.getQueue = [
      { provider: "claude-code", namedAgentId: "proj-agent" }, // project scope
      {
        id: "proj-agent",
        name: "Project Agent",
        provider: "codex",
        model: "o3",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("codex");
    expect(result.model).toBe("o3");
    expect(result.name).toBe("Project Agent");
  });

  it("ignores a global default without a named agent", async () => {
    dbMockState.getQueue = [
      null, // project scope: not found
      { provider: "codex", namedAgentId: null }, // global scope
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.name).toBe("Claude Code");
  });

  it("falls to global default with named agent when project default is missing", async () => {
    dbMockState.getQueue = [
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

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("Global Opus");
  });

  it("falls to seeded 'Claude Code' named agent when no defaults exist", async () => {
    // project scope: null, global scope: null
    // seeded default agent lookup: returns the "Claude Code" agent
    dbMockState.getQueue = [
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

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("falls to seeded 'Claude Code' agent without projectId", async () => {
    // global scope: null
    // seeded default agent lookup: returns the "Claude Code" agent
    dbMockState.getQueue = [
      null, // global scope
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("chat");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("returns FALLBACK_PROVIDER when no defaults and no seeded agent exist", async () => {
    // project scope: null, global scope: null, seeded agent: null
    dbMockState.getQueue = [null, null, null];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });

  it("returns FALLBACK_PROVIDER without projectId when nothing exists", async () => {
    // global scope: null, seeded agent: null
    dbMockState.getQueue = [null, null];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("chat");

    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });

  it("falls through when a project assignment points to a deleted agent", async () => {
    // project scope: has default referencing a deleted named agent
    // named agent lookup: null (deleted)
    dbMockState.getQueue = [
      { provider: "codex", namedAgentId: "deleted-agent" },
      null, // named agent not found
      { provider: "claude-code", namedAgentId: "global-agent" },
      {
        id: "global-agent",
        name: "Global Agent",
        provider: "gemini-cli",
        model: "gemini-2.5-pro",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.name).toBe("Global Agent");
  });

  it("falls through when a global assignment points to a deleted agent", async () => {
    // project scope: null
    // global scope: has default referencing a deleted named agent
    // named agent lookup: null (deleted)
    dbMockState.getQueue = [
      null, // project scope
      { provider: "gemini-cli", namedAgentId: "deleted-agent" },
      null, // named agent not found
      {
        id: "seeded-cc",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("build", "proj-1");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });
});

// ---------------------------------------------------------------------------
// Seeded global default agent
// ---------------------------------------------------------------------------

describe("seeded global default agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("GLOBAL_DEFAULT_AGENT_NAME is 'Claude Code'", async () => {
    const { GLOBAL_DEFAULT_AGENT_NAME } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    expect(GLOBAL_DEFAULT_AGENT_NAME).toBe("Claude Code");
  });

  it("seeded agent is used as last-resort before bare FALLBACK_PROVIDER", async () => {
    // No project, no global default — only the seeded "Claude Code" agent exists
    dbMockState.getQueue = [
      null, // global scope default
      {
        id: "seed-1",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        createdAt: "2026-01-01",
      },
    ];

    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = resolveAgent("spec_generation");

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("resolveAgentByNamedId reaches seeded agent when namedAgentId is null and no defaults", async () => {
    // Falls through to resolveAgent -> seeded agent
    dbMockState.getQueue = [
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
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId("review_code", undefined, null);

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.name).toBe("Claude Code");
  });

  it("resolveAgentByNamedId reaches FALLBACK_PROVIDER when seeded agent also missing", async () => {
    // Falls through resolveAgent -> seeded agent not found -> bare FALLBACK_PROVIDER
    dbMockState.getQueue = [
      null, // named agent lookup (invalid id)
      null, // project scope default
      null, // global scope default
      null, // seeded "Claude Code" agent not found
    ];

    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = resolveAgentByNamedId(
      "team_build",
      "proj-1",
      "nonexistent-id",
    );

    expect(result).toEqual({ provider: "claude-code", namedAgentId: null });
  });
});
