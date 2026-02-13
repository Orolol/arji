import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDb.getQueue.shift() ?? null),
    all: vi.fn(() => mockDb.allQueue.shift() ?? []),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  agentProviderDefaults: {
    agentType: "agentType",
    provider: "provider",
    scope: "scope",
    namedAgentId: "namedAgentId",
  },
  namedAgents: {
    id: "id",
    name: "name",
    provider: "provider",
    model: "model",
  },
}));

describe("Agent provider resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getQueue = [];
    mockDb.allQueue = [];
  });

  it("resolveAgentProvider uses project override first", async () => {
    const { resolveAgentProvider } = await import("@/lib/agent-config/providers");
    mockDb.getQueue = [{ provider: "codex" }];

    const provider = await resolveAgentProvider("build", "proj-1");
    expect(provider).toBe("codex");
  });

  it("resolveAgentProvider falls back to global", async () => {
    const { resolveAgentProvider } = await import("@/lib/agent-config/providers");
    mockDb.getQueue = [null, { provider: "codex" }];

    const provider = await resolveAgentProvider("chat", "proj-1");
    expect(provider).toBe("codex");
  });

  it("resolveAgentProvider falls back to claude-code", async () => {
    const { resolveAgentProvider } = await import("@/lib/agent-config/providers");
    mockDb.getQueue = [null, null];

    const provider = await resolveAgentProvider("ticket_build", "proj-1");
    expect(provider).toBe("claude-code");
  });

  it("listMergedProjectAgentProviders merges project > global > fallback", async () => {
    const { listMergedProjectAgentProviders } = await import(
      "@/lib/agent-config/providers"
    );
    mockDb.allQueue = [
      [{ agentType: "chat", provider: "codex", scope: "global" }],
      [{ agentType: "build", provider: "codex", scope: "proj-1" }],
    ];

    const merged = await listMergedProjectAgentProviders("proj-1");
    const build = merged.find((x) => x.agentType === "build");
    const chat = merged.find((x) => x.agentType === "chat");
    const ticketBuild = merged.find((x) => x.agentType === "ticket_build");

    expect(build?.provider).toBe("codex");
    expect(build?.source).toBe("project");
    expect(chat?.provider).toBe("codex");
    expect(chat?.source).toBe("global");
    expect(ticketBuild?.provider).toBe("claude-code");
    expect(ticketBuild?.source).toBe("builtin");
  });

  it("resolveAgent returns provider + model from named agent assignment", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/providers");
    mockDb.getQueue = [
      {
        agentType: "build",
        provider: "claude-code",
        scope: "proj-1",
        namedAgentId: "na-1",
      },
    ];
    mockDb.allQueue = [
      [
        {
          id: "na-1",
          name: "Gemini Fast",
          provider: "gemini-cli",
          model: "gemini-2.0-flash",
        },
      ],
    ];

    const resolved = await resolveAgent("build", "proj-1");
    expect(resolved.provider).toBe("gemini-cli");
    expect(resolved.model).toBe("gemini-2.0-flash");
    expect(resolved.namedAgentId).toBe("na-1");
  });
});
