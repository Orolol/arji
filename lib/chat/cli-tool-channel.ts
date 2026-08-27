/**
 * Arij MCP tool channel for CLI chat conversations.
 *
 * CLI chat spawns (claude-code, codex, oh-my-pi) have no agent_sessions row,
 * so they bypass the processManager.start() wiring point on purpose — this
 * module is their dedicated wiring: the chat stream route calls
 * `createChatCliToolChannel` once per one-shot turn, passes `channel.mcp` to
 * the spawn, and calls `channel.release()` on every completion path. The
 * persistent runner instead creates one channel when the conversation
 * process starts and releases it only when that process exits/reaps.
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
 * report_friction / submit_findings / submit_grading reject chat tokens
 * outright. The spawn
 * config selects the shim's "chat" toolset, so the CLI sees the board tools
 * instead of the agent toolset.
 *
 * User-declared MCP servers (lib/mcp/servers.ts) are resolved here too, with
 * agent type "chat", so a conversation reaches the same third-party servers a
 * build would. The OpenAI-compatible fast path is NOT an MCP host and is
 * deliberately untouched: it has board tools of its own (lib/chat/board-tools.ts)
 * and no way to mount a third-party MCP server.
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
import { resolveExtraMcpServers } from "@/lib/mcp/servers";
import type { McpServerSpec, McpSpawnConfig } from "@/lib/providers/types";

export interface ChatCliToolChannel {
  /** Spawn config to pass as `options.mcp` (scoped chat toolset token). */
  mcp: McpSpawnConfig;
  /** Revokes the bearer token. Idempotent — call on every process exit path. */
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

    // Story parity: the chat channel does NOT go through
    // processManager.start(), so without this it would be the one surface
    // where user-declared MCP servers are silently absent — available in
    // build and review, missing in chat. Same merge rule as an agent session;
    // the agent type is "chat", so a server whose `agent_types` omits it stays
    // out. Best-effort like the rest of this function: a resolution failure
    // degrades to the arij channel alone rather than losing the turn's tools.
    let extraServers: McpServerSpec[] = [];
    try {
      extraServers = resolveExtraMcpServers({
        projectId,
        provider,
        agentType: "chat",
      }).servers;
    } catch (error) {
      console.warn(
        "[chat] extra MCP servers skipped for this turn:",
        error instanceof Error ? error.message : error,
      );
    }

    let released = false;
    return {
      mcp: buildMcpSpawnConfig({
        token,
        toolset: "chat",
        provider,
        extraServers,
      }),
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
