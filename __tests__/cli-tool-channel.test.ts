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
