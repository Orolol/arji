/**
 * Unit tests for lib/chat/cli-tool-channel.ts — the per-turn MCP tool
 * channel for CLI chat conversations.
 *
 * Real token store, real spawn-config builder; only the db (settings
 * toggle) is the shared chain mock. Covers the gating matrix (conversation
 * type, provider support, global toggle) and the token lifecycle: minted
 * project-scoped with agentType "chat" and no epic, dead after release(),
 * release idempotent.
 */
import { arijChannelSpec } from "@/lib/providers/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import { createChatCliToolChannel } from "@/lib/chat/cli-tool-channel";
import {
  ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES,
  ARIJ_MCP_SERVER_NAME,
  buildClaudeMcpConfigJson,
} from "@/lib/claude/mcp-injection";
import {
  _resetMcpTokenStoreForTests,
  resolveMcpToken,
} from "@/lib/mcp/token-store";

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
  _resetMcpTokenStoreForTests();
  // settings select for mcp_tools_enabled: absent row (null) = enabled
  dbMockState.getQueue = [];
});

describe("createChatCliToolChannel", () => {
  it.each(["claude-code", "codex"])(
    "builds a chat-toolset channel with a live project-scoped token for %s",
    (provider) => {
      const channel = createChatCliToolChannel({
        projectId: "proj1",
        provider,
        conversationType: null,
      });

      expect(channel).not.toBeNull();
      expect(arijChannelSpec(channel!.mcp).name).toBe(ARIJ_MCP_SERVER_NAME);
      expect(arijChannelSpec(channel!.mcp).env.ARIJ_MCP_TOOLSET).toBe("chat");
      expect(channel!.mcp.allowedToolNames).toEqual([
        ...ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES,
      ]);

      const record = resolveMcpToken(arijChannelSpec(channel!.mcp).env.ARIJ_MCP_TOKEN);
      expect(record).toMatchObject({
        projectId: "proj1",
        epicId: null,
        userStoryId: null,
        agentType: "chat",
      });
      expect(record!.sessionId.startsWith("chat-tools-")).toBe(true);
    },
  );

  it('treats the plain "chat" conversation type like an untyped conversation', () => {
    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: "chat",
    });
    expect(channel).not.toBeNull();
    channel!.release();
  });

  it("release() kills the token and is idempotent", () => {
    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    })!;
    const token = arijChannelSpec(channel.mcp).env.ARIJ_MCP_TOKEN;

    expect(resolveMcpToken(token)).not.toBeNull();
    channel.release();
    expect(resolveMcpToken(token)).toBeNull();
    expect(() => channel.release()).not.toThrow();
    expect(resolveMcpToken(token)).toBeNull();
  });

  it("mints a fresh token per turn", () => {
    const first = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    })!;
    const second = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    })!;

    expect(arijChannelSpec(first.mcp).env.ARIJ_MCP_TOKEN).not.toBe(arijChannelSpec(second.mcp).env.ARIJ_MCP_TOKEN);
    // releasing one turn must not kill the other's token
    first.release();
    expect(resolveMcpToken(arijChannelSpec(second.mcp).env.ARIJ_MCP_TOKEN)).not.toBeNull();
  });

  it("builds an omp chat channel with the single-underscore tool spelling", () => {
    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "oh-my-pi",
      conversationType: null,
    });

    expect(channel).not.toBeNull();
    expect(arijChannelSpec(channel!.mcp).env.ARIJ_MCP_TOOLSET).toBe("chat");
    expect(channel!.mcp.allowedToolNames).toContain("mcp__arij_create_ticket");
    expect(channel!.mcp.allowedToolNames).not.toContain(
      "mcp__arij__create_ticket",
    );
    channel!.release();
  });

  it.each(["gemini-cli", "mistral-vibe", "pi", "openai-compatible"])(
    "returns null for provider %s (no MCP injection surface)",
    (provider) => {
      expect(
        createChatCliToolChannel({
          projectId: "proj1",
          provider,
          conversationType: null,
        }),
      ).toBeNull();
    },
  );

  it.each(["epic_creation", "epic", "brainstorm"])(
    "returns null for %s conversations (prompt contracts, no tools)",
    (conversationType) => {
      expect(
        createChatCliToolChannel({
          projectId: "proj1",
          provider: "claude-code",
          conversationType,
        }),
      ).toBeNull();
    },
  );

  it("returns null when the mcp_tools_enabled setting is explicitly false", () => {
    dbMockState.getQueue = [{ value: JSON.stringify(false) }];

    expect(
      createChatCliToolChannel({
        projectId: "proj1",
        provider: "claude-code",
        conversationType: null,
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Story "Parité du canal chat"                                         */
/* ------------------------------------------------------------------ */

describe("user-declared MCP servers reach a chat turn too", () => {
  it("injects the servers resolved for the conversation's project", () => {
    // Without this the feature would be present in build and review and
    // silently missing in chat — the chat channel does not go through
    // processManager.start(), so it needs its own resolution call.
    dbMockState.allRows = [
      {
        id: "srv-1",
        projectId: null,
        name: "godot",
        enabled: true,
        transport: "stdio",
        command: "/usr/bin/godot-mcp",
        args: "[]",
        env: "{}",
        url: null,
        headers: "{}",
        agentTypes: null,
        toolAllowlist: null,
        usageHint: "scenes and nodes",
        lastCheckedAt: null,
        lastCheckOk: null,
        lastCheckError: null,
        createdAt: "2026-08-27",
      },
    ];

    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    });

    expect(channel).not.toBeNull();
    expect(channel!.mcp.servers.map((s) => s.name)).toEqual([
      ARIJ_MCP_SERVER_NAME,
      "godot",
    ]);
    // The arij toolset is untouched by this story: no agent-only tool appears.
    expect(channel!.mcp.allowedToolNames).toEqual([
      ...ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES,
      "mcp__godot",
    ]);
    expect(channel!.mcp.allowedToolNames).not.toContain("mcp__arij__ask_question");
    expect(channel!.mcp.allowedToolNames).not.toContain("mcp__arij__submit_findings");
  });

  it("excludes a server whose agent_types omit chat", () => {
    dbMockState.allRows = [
      {
        id: "srv-1",
        projectId: null,
        name: "godot",
        enabled: true,
        transport: "stdio",
        command: "/usr/bin/godot-mcp",
        args: "[]",
        env: "{}",
        url: null,
        headers: "{}",
        agentTypes: JSON.stringify(["ticket_build"]),
        toolAllowlist: null,
        usageHint: null,
        lastCheckedAt: null,
        lastCheckOk: null,
        lastCheckError: null,
        createdAt: "2026-08-27",
      },
    ];

    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    });

    expect(channel!.mcp.servers.map((s) => s.name)).toEqual([
      ARIJ_MCP_SERVER_NAME,
    ]);
  });

  it("keeps the arij channel when extras resolution blows up", () => {
    // Best-effort, like the rest of this function: a bad extra must cost the
    // turn that server, never its board tools.
    dbMockState.allRows = null as unknown as [];

    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    });

    expect(channel).not.toBeNull();
    expect(arijChannelSpec(channel!.mcp).name).toBe(ARIJ_MCP_SERVER_NAME);
  });
});

/**
 * The criterion is that a CLI chat conversation *receives* the servers, and on
 * claude-code what it receives is exactly the `--mcp-config` file: both chat
 * paths pass `--strict-mcp-config` (the one-shot spawn and
 * lib/chat/persistent-runner.ts claudeArgs), which makes that file the CLI's
 * COMPLETE server set. Asserting the channel object alone would stop one step
 * short of the artifact the CLI actually reads.
 */
describe("what a claude-code chat spawn is actually handed", () => {
  function godotRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "srv-1",
      projectId: null,
      name: "godot",
      enabled: true,
      transport: "stdio",
      command: "/usr/bin/godot-mcp",
      args: JSON.stringify(["--headless"]),
      env: "{}",
      url: null,
      headers: "{}",
      agentTypes: null,
      toolAllowlist: null,
      usageHint: null,
      lastCheckedAt: null,
      lastCheckOk: null,
      lastCheckError: null,
      createdAt: "2026-08-27",
      ...overrides,
    };
  }

  it("writes the resolved extras into the strict config alongside arij", () => {
    dbMockState.allRows = [godotRow()];

    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    });

    const config = JSON.parse(buildClaudeMcpConfigJson(channel!.mcp));
    expect(Object.keys(config.mcpServers)).toEqual([ARIJ_MCP_SERVER_NAME, "godot"]);
    expect(config.mcpServers.godot).toMatchObject({
      type: "stdio",
      command: "/usr/bin/godot-mcp",
      args: ["--headless"],
    });
  });

  it("omits a chat-ineligible server from the strict config entirely", () => {
    // Under --strict-mcp-config "not in the file" is the only way to be absent:
    // there is no second source the CLI could still load it from.
    dbMockState.allRows = [
      godotRow({ agentTypes: JSON.stringify(["ticket_build", "review_code"]) }),
    ];

    const channel = createChatCliToolChannel({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    });

    const config = JSON.parse(buildClaudeMcpConfigJson(channel!.mcp));
    expect(Object.keys(config.mcpServers)).toEqual([ARIJ_MCP_SERVER_NAME]);
  });
});
