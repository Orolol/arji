/**
 * The default mode a NEW conversation opens on (lib/chat/default-chat-mode.ts).
 *
 * The point of the module is a type: `resolveAgent()` returns an
 * `AgentProvider`, a union that cannot name `openai-compatible` or a
 * `*-persistent` mode, so no amount of UI wiring could make either one a
 * default. These tests pin the four rungs of the replacement, and that a
 * failing probe is an answer rather than an exception.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PERSISTENT_CHAT_PROVIDER_OPTIONS,
  isAgentProvider,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";

const { getProvider, getOpenAiConfigFromSettings, resolveAgent } = vi.hoisted(
  () => ({
    getProvider: vi.fn(),
    getOpenAiConfigFromSettings: vi.fn(),
    resolveAgent: vi.fn(),
  }),
);

vi.mock("@/lib/providers", () => ({ getProvider }));
vi.mock("@/lib/openai/client", () => ({ getOpenAiConfigFromSettings }));
vi.mock("@/lib/agent-config/agent-resolution", () => ({ resolveAgent }));

import {
  DEFAULT_CHAT_MODE_PROBES,
  resolveDefaultChatMode,
  type ChatModeProbes,
} from "@/lib/chat/default-chat-mode";

/** Installed CLIs by provider type; anything absent probes as unavailable. */
function installClis(installed: string[], onProbe?: () => never) {
  getProvider.mockImplementation((type: string) => ({
    isAvailable: async () => {
      onProbe?.();
      return installed.includes(type);
    },
  }));
}

function configureDirectApi(config: { baseUrl?: string; model?: string }) {
  getOpenAiConfigFromSettings.mockReturnValue({
    baseUrl: config.baseUrl ?? "",
    apiKey: "",
    model: config.model ?? "",
    reasoningEffort: "off",
  });
}

describe("resolveDefaultChatMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installClis([]);
    configureDirectApi({});
    resolveAgent.mockReturnValue({ provider: "claude-code", namedAgentId: null });
  });

  it("prefers the persistent Claude mode when the claude-code CLI is installed", async () => {
    installClis(["claude-code"]);

    const mode = await resolveDefaultChatMode("proj-1");

    expect(mode).toEqual({
      provider: "claude-code-persistent",
      namedAgentId: null,
      source: "persistent-cli",
    });
    // Availability comes from the provider's own probe, the same one
    // GET /api/providers/available uses.
    expect(getProvider).toHaveBeenCalledWith("claude-code");
    // The persistent rung answers on its own: no agent resolution needed.
    expect(resolveAgent).not.toHaveBeenCalled();
  });

  it("falls to the persistent Oh My Pi mode when only oh-my-pi is installed", async () => {
    installClis(["oh-my-pi"]);

    const mode = await resolveDefaultChatMode("proj-1");

    expect(mode).toEqual({
      provider: "oh-my-pi-persistent",
      namedAgentId: null,
      source: "persistent-cli",
    });
    expect(getProvider).toHaveBeenCalledWith("claude-code");
    expect(getProvider).toHaveBeenCalledWith("oh-my-pi");
  });

  it("falls to the direct API when no persistent CLI is installed and it is configured", async () => {
    configureDirectApi({ baseUrl: "http://localhost:11434/v1", model: "llama3.1" });

    const mode = await resolveDefaultChatMode("proj-1");

    expect(mode).toEqual({
      provider: "openai-compatible",
      namedAgentId: null,
      source: "direct-api",
    });
    expect(resolveAgent).not.toHaveBeenCalled();
  });

  it("does not count a half-configured direct API as configured", async () => {
    // A base URL without a model is exactly what the stream route 400s on;
    // defaulting to it would hand the user a conversation that cannot answer.
    configureDirectApi({ baseUrl: "http://localhost:11434/v1" });

    const mode = await resolveDefaultChatMode("proj-1");

    expect(mode.provider).toBe("claude-code");
    expect(mode.source).toBe("agent-resolution");
  });

  it("ignores a missing API key: local endpoints run without auth", async () => {
    configureDirectApi({ baseUrl: "http://localhost:11434/v1", model: "llama3.1" });

    expect((await resolveDefaultChatMode("proj-1")).provider).toBe(
      "openai-compatible",
    );
  });

  it("falls back to resolveAgent('chat', projectId) unchanged as the last rung", async () => {
    resolveAgent.mockReturnValue({ provider: "codex", namedAgentId: "agent-7" });

    const mode = await resolveDefaultChatMode("proj-1");

    expect(resolveAgent).toHaveBeenCalledWith("chat", "proj-1");
    expect(mode).toEqual({
      provider: "codex",
      namedAgentId: "agent-7",
      source: "agent-resolution",
    });
  });

  it("normalises the fallback's absent named agent to null", async () => {
    resolveAgent.mockReturnValue({ provider: "claude-code" });

    expect((await resolveDefaultChatMode()).namedAgentId).toBeNull();
    expect(resolveAgent).toHaveBeenCalledWith("chat", undefined);
  });

  it("treats a throwing availability probe as unavailable, not as an error", async () => {
    const boom = () => {
      throw new Error("which: command not found");
    };
    installClis(["claude-code", "oh-my-pi"], boom);
    configureDirectApi({ baseUrl: "http://localhost:11434/v1", model: "llama3.1" });

    // Both CLIs would be "installed" if their probe answered; it throws, so
    // the resolution walks past them instead of surfacing a 500.
    await expect(resolveDefaultChatMode("proj-1")).resolves.toEqual({
      provider: "openai-compatible",
      namedAgentId: null,
      source: "direct-api",
    });
  });

  it("treats a throwing settings read as an unconfigured direct API", async () => {
    getOpenAiConfigFromSettings.mockImplementation(() => {
      throw new Error("no such table: settings");
    });

    await expect(resolveDefaultChatMode("proj-1")).resolves.toMatchObject({
      provider: "claude-code",
      source: "agent-resolution",
    });
  });

  it("resolves to a ChatModeProvider, not an AgentProvider", async () => {
    installClis(["claude-code"]);

    const mode = await resolveDefaultChatMode("proj-1");
    // Type-level half of the claim: the field accepts the wider union.
    const provider: ChatModeProvider = mode.provider;
    // Runtime half: the value it resolved to is outside AgentProvider, which
    // is precisely what resolveAgent() could never return.
    expect(isAgentProvider(provider)).toBe(false);
  });

  it("takes its persistent preference order from PERSISTENT_CHAT_PROVIDER_OPTIONS", async () => {
    // The resolver walks that constant rather than a private copy, so this is
    // the assertion that fails if the constant is ever reordered.
    expect([...PERSISTENT_CHAT_PROVIDER_OPTIONS]).toEqual([
      "claude-code-persistent",
      "oh-my-pi-persistent",
    ]);

    installClis(["claude-code", "oh-my-pi"]);
    expect((await resolveDefaultChatMode("proj-1")).provider).toBe(
      "claude-code-persistent",
    );
  });

  it("uses injected probes instead of the defaults", async () => {
    const probes: ChatModeProbes = {
      isCliAvailable: vi.fn(() => false),
      isDirectApiConfigured: vi.fn(() => true),
      resolveChatAgent: vi.fn(() => ({ provider: "claude-code" as const })),
    };

    const mode = await resolveDefaultChatMode("proj-1", probes);

    expect(mode.provider).toBe("openai-compatible");
    expect(probes.isCliAvailable).toHaveBeenCalledWith("claude-code");
    expect(probes.isCliAvailable).toHaveBeenCalledWith("oh-my-pi");
    expect(getProvider).not.toHaveBeenCalled();
    expect(getOpenAiConfigFromSettings).not.toHaveBeenCalled();
  });
});

describe("DEFAULT_CHAT_MODE_PROBES", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads availability from the provider instance's isAvailable()", async () => {
    const isAvailable = vi.fn(async () => true);
    getProvider.mockReturnValue({ isAvailable });

    await expect(
      DEFAULT_CHAT_MODE_PROBES.isCliAvailable("oh-my-pi"),
    ).resolves.toBe(true);
    expect(getProvider).toHaveBeenCalledWith("oh-my-pi");
    expect(isAvailable).toHaveBeenCalled();
  });

  it("reads the direct-API configuration from the stored settings", () => {
    configureDirectApi({ baseUrl: "http://localhost:11434/v1", model: "llama3.1" });
    expect(DEFAULT_CHAT_MODE_PROBES.isDirectApiConfigured()).toBe(true);

    configureDirectApi({ model: "llama3.1" });
    expect(DEFAULT_CHAT_MODE_PROBES.isDirectApiConfigured()).toBe(false);
  });

  it("delegates the last rung to resolveAgent('chat', projectId)", () => {
    resolveAgent.mockReturnValue({ provider: "agy", namedAgentId: null });

    expect(DEFAULT_CHAT_MODE_PROBES.resolveChatAgent("proj-9")).toEqual({
      provider: "agy",
      namedAgentId: null,
    });
    expect(resolveAgent).toHaveBeenCalledWith("chat", "proj-9");
  });
});
