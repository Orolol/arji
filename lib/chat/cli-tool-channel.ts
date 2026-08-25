/**
 * Per-turn Arij MCP tool channel for CLI chat conversations.
 *
 * CLI chat spawns (claude-code, codex) have no agent_sessions row, so they
 * bypass the processManager.start() wiring point on purpose — this module is
 * their dedicated wiring: the chat stream route calls
 * `createChatCliToolChannel` once per turn, passes `channel.mcp` to the
 * spawn, and calls `channel.release()` on every completion path (success,
 * error, client cancel).
 *
 * Gate parity with the other surfaces:
 *   - same global toggle and provider support as agent injection
 *     (lib/claude/mcp-injection.ts);
 *   - same conversation eligibility as the fast-mode board tools —
 *     epic-creation and brainstorm conversations are prompt contracts that
 *     tools would corrupt (epic finalization must answer in strict JSON).
 *
 * The minted token is project-scoped with epicId null and agentType "chat",
 * exactly like the fast-mode per-turn token: ticket-scoped routes require an
 * explicit ticket_id (resolveTicketForToken), and ask_question /
 * submit_findings / submit_grading reject chat tokens outright. The spawn
 * config selects the shim's "chat" toolset, so the CLI sees the board tools
 * instead of the agent toolset.
 *
 * Strictly best-effort: a chat turn must never fail because the tool channel
 * did, so any error here degrades to a plain (uninjected) spawn.
 */

import { createId } from "@/lib/utils/nanoid";
import {
  buildMcpSpawnConfig,
  isMcpToolsEnabled,
  providerSupportsMcp,
} from "@/lib/claude/mcp-injection";
import { isToolIneligibleConversationAgentType } from "@/lib/chat/conversation-agent";
import { mintMcpToken, revokeMcpTokensForSession } from "@/lib/mcp/token-store";
import type { McpSpawnConfig } from "@/lib/providers/types";

export interface ChatCliToolChannel {
  /** Spawn config to pass as `options.mcp` (chat toolset, per-turn token). */
  mcp: McpSpawnConfig;
  /** Revokes the turn's bearer token. Idempotent — call on every exit path. */
  release: () => void;
}

export function createChatCliToolChannel({
  projectId,
  provider,
  conversationType,
}: {
  projectId: string;
  provider: string;
  conversationType: string | null;
}): ChatCliToolChannel | null {
  try {
    if (isToolIneligibleConversationAgentType(conversationType)) return null;
    if (!providerSupportsMcp(provider)) return null;
    if (!isMcpToolsEnabled()) return null;

    const sessionId = `chat-tools-${createId()}`;
    const token = mintMcpToken({
      sessionId,
      projectId,
      epicId: null,
      userStoryId: null,
      agentType: "chat",
    });

    let released = false;
    return {
      mcp: buildMcpSpawnConfig({ token, toolset: "chat" }),
      release: () => {
        if (released) return;
        released = true;
        revokeMcpTokensForSession(sessionId);
      },
    };
  } catch (error) {
    console.warn(
      "[chat] MCP tool channel skipped for this turn:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
