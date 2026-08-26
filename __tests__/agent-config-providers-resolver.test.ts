import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

// Real drizzle-orm + real @/lib/db/schema: both are side-effect-free pure
// builders, and the chain mock ignores their output. No fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

describe("Agent assignment resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("ignores a legacy project CLI default and uses the global named assignment", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    dbMockState.getQueue = [
      { provider: "gemini-cli", namedAgentId: null },
      { provider: "claude-code", namedAgentId: "global-agent" },
      {
        id: "global-agent",
        name: "Global builder",
        provider: "codex",
        model: "gpt-5",
      },
    ];

    const resolved = await resolveAgent("build", "proj-1");
    expect(resolved.provider).toBe("codex");
    expect(resolved.name).toBe("Global builder");
  });

  it("ignores a legacy global CLI default and uses the seeded agent", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    dbMockState.getQueue = [
      { provider: "codex", namedAgentId: null },
      {
        id: "seeded-agent",
        name: "Claude Code",
        provider: "claude-code",
        model: "claude-opus-4-6",
      },
    ];

    const resolved = await resolveAgent("chat");
    expect(resolved.provider).toBe("claude-code");
    expect(resolved.namedAgentId).toBe("seeded-agent");
  });

  it("resolveAgent falls back to claude-code", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    dbMockState.getQueue = [null, null, null];

    const resolved = await resolveAgent("ticket_build", "proj-1");
    expect(resolved.provider).toBe("claude-code");
  });

  it("lists project > global > fallback using named assignments only", async () => {
    const { listMergedProjectAgentProviders } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    dbMockState.allQueue = [
      [
        {
          agentType: "chat",
          provider: "claude-code",
          namedAgentId: "global-agent",
          scope: "global",
        },
      ],
      [
        {
          agentType: "build",
          provider: "claude-code",
          namedAgentId: "project-agent",
          scope: "proj-1",
        },
        {
          agentType: "ticket_build",
          provider: "codex",
          namedAgentId: null,
          scope: "proj-1",
        },
      ],
      [
        {
          id: "global-agent",
          name: "Global chat",
          provider: "codex",
          model: "gpt-5",
        },
        {
          id: "project-agent",
          name: "Project builder",
          provider: "oh-my-pi",
          model: "pi-pro",
        },
      ],
    ];

    const merged = await listMergedProjectAgentProviders("proj-1");
    const build = merged.find((x) => x.agentType === "build");
    const chat = merged.find((x) => x.agentType === "chat");
    const ticketBuild = merged.find((x) => x.agentType === "ticket_build");

    expect(build?.provider).toBe("oh-my-pi");
    expect(build?.source).toBe("project");
    expect(chat?.provider).toBe("codex");
    expect(chat?.source).toBe("global");
    expect(ticketBuild?.provider).toBe("claude-code");
    expect(ticketBuild?.source).toBe("builtin");
  });

  it("resolveAgent returns provider + model from named agent assignment", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    // resolveAgent first queries agentProviderDefaults for project scope (get),
    // which returns a row with namedAgentId. Then it calls resolveFromRow which
    // does a select().from(namedAgents).where(...).get() to look up the named agent.
    dbMockState.getQueue = [
      {
        // First get: project-scoped agentProviderDefaults row
        provider: "claude-code",
        namedAgentId: "na-1",
      },
      {
        // Second get: named agent lookup by id
        id: "na-1",
        name: "Pi Fast",
        provider: "oh-my-pi",
        model: "pi-flash",
      },
    ];

    const resolved = await resolveAgent("build", "proj-1");
    expect(resolved.provider).toBe("oh-my-pi");
    expect(resolved.model).toBe("pi-flash");
    expect(resolved.namedAgentId).toBe("na-1");
  });
});
