/**
 * Arij MCP tool-channel injection — gating and per-session spawn config.
 *
 * Spawned agent sessions get a structured channel back to Arij: a stdio MCP
 * shim (bin/arij-mcp.mjs) exposing arij tools (mcp__arij__* on claude/codex,
 * mcp__arij_* on omp — see arijMcpToolPrefix) that bridge to the
 * /api/mcp/* HTTP routes with a per-session bearer token
 * (lib/mcp/token-store.ts). This module decides WHEN a spawn gets the
 * channel and builds WHAT the providers inject; the single wiring point that
 * calls it is processManager.start() (lib/claude/process-manager.ts).
 *
 * Gates (all must hold):
 *   1. The `mcp_tools_enabled` setting is not explicitly false — an ABSENT
 *      row means ENABLED (default on).
 *   2. The provider supports per-spawn MCP config injection: claude-code
 *      (--mcp-config <file>), codex (-c mcp_servers.* overrides) and
 *      oh-my-pi (env vars expanded by its mcp.json entry at load time).
 *      gemini-cli is out for v1 — its CLI only reads MCP config from
 *      .gemini/settings.json files, which would mean writing config into
 *      user worktrees.
 *   3. The session has an agent_sessions row (checked by the caller) — the
 *      row provides the project scope the token is bound to. Spawns without
 *      rows (generate-spec, import) get no injection by construction.
 *
 * CLI chat conversations are the one exception to the single wiring point:
 * they have no agent_sessions row, so the chat stream route wires its own
 * per-turn channel through lib/chat/cli-tool-channel.ts — same gates 1 and 2,
 * project scope from the route params, and the "chat" toolset (board tools,
 * no ask_question/report_friction/submit_findings/submit_grading) instead of
 * the agent toolset.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { getAppBaseUrl } from "@/lib/webhooks/send";
import type { McpSpawnConfig } from "@/lib/providers/types";

/**
 * Settings key for the global toggle. Absent row = enabled; only an
 * explicitly-false value disables the channel.
 */
export const MCP_TOOLS_ENABLED_SETTING_KEY = "mcp_tools_enabled";

/**
 * MCP server name — the agent sees tools as `mcp__arij__<tool>` (claude,
 * codex) or `mcp__arij_<tool>` (omp); see arijMcpToolPrefix.
 */
export const ARIJ_MCP_SERVER_NAME = "arij";

/** Path of the stdio shim, relative to the app root (the server's cwd). */
export const ARIJ_MCP_SHIM_RELATIVE_PATH = ["bin", "arij-mcp.mjs"] as const;

/** The agent tools, as bare names (no server prefix). */
export const ARIJ_MCP_AGENT_TOOLS = [
  "get_ticket",
  "update_ticket_status",
  "post_comment",
  "report_friction",
  "attach_artifact",
  "create_bug",
  "ask_question",
  "submit_findings",
  "submit_grading",
  // Board-refinement tools. Agent toolset only: they reshape the planning
  // half of the board (priority, execution order, dependency edges, and the
  // Backlog <-> To do promotion), which is not something a chat turn should
  // be able to do — see ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES below, which
  // deliberately does not list them, and the AGENT_ONLY check the routes run.
  "set_priority",
  "reorder_tickets",
  "add_dependency",
  "remove_dependency",
  "promote_ticket",
] as const;

/**
 * The chat-toolset tools (CLI chat conversations), as bare names. Mirrors
 * the fast-mode board tools (lib/chat/board-tools.ts);
 * ask_question/report_friction/submit_findings/submit_grading are deliberately
 * absent — nothing holds a chat turn, chat turns have no durable session, and
 * chat tokens are rejected by those routes anyway.
 */
export const ARIJ_MCP_CHAT_TOOLS = [
  "list_tickets",
  "get_ticket",
  "create_ticket",
  "update_ticket",
  "update_ticket_status",
  "post_comment",
  "get_agent_status",
  "start_build",
] as const;

/**
 * How a provider's CLI prefixes the server's tool names. claude-code and
 * codex join server and tool with a DOUBLE underscore
 * (`mcp__arij__get_ticket`); omp joins with a SINGLE one
 * (`mcp__arij_get_ticket`); agy flattens MCP tools to their BARE names
 * (`get_ticket`, measured on 1.1.21). The spelling matters everywhere a
 * tool is named — allowlists and prompt text alike: telling an omp or agy
 * agent to call `mcp__arij__get_ticket` is telling it to call a tool that
 * does not exist.
 */
export function arijMcpToolPrefix(provider: string): string {
  if (provider === "agy") return "";
  const separator = provider === "oh-my-pi" ? "_" : "__";
  return `mcp__${ARIJ_MCP_SERVER_NAME}${separator}`;
}

/** One tool's full name in `provider`'s spelling. */
export function arijMcpToolName(provider: string, tool: string): string {
  return `${arijMcpToolPrefix(provider)}${tool}`;
}

/**
 * The agent tools as exact allowlist entries (no wildcards), in the
 * claude/codex spelling — the default used wherever no provider is named.
 */
export const ARIJ_MCP_ALLOWED_TOOL_NAMES = ARIJ_MCP_AGENT_TOOLS.map((t) =>
  arijMcpToolName("claude-code", t),
);

/** The chat toolset as exact allowlist entries, claude/codex spelling. */
export const ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES = ARIJ_MCP_CHAT_TOOLS.map((t) =>
  arijMcpToolName("claude-code", t),
);

/** Which shim toolset a spawn config selects (ARIJ_MCP_TOOLSET env). */
export type ArijMcpToolset = "agent" | "chat";

/**
 * Tools withheld from specific agent types.
 *
 * The allowlist is otherwise flat per toolset, which is a hole once an agent
 * type has a guardrail keyed on its OWN write path: a board refinement pass
 * is confined to Backlog/To do by the `source: "refinement"` engine guard,
 * but `update_ticket_status` writes with `source: "api"` and resolves any
 * ticket in the project from an explicit ticket_id — so it walks straight
 * past that guard and can move work out of Review or Done.
 *
 * Withholding the tool here means the spawn is never offered it. The route
 * itself also refuses refinement tokens (app/api/mcp/update-ticket-status),
 * which is the actual guard: an allowlist shapes what the model reaches for,
 * a server-side check is what makes it impossible.
 */
export const AGENT_TYPE_WITHHELD_TOOL_NAMES: Record<string, readonly string[]> =
  {
    // promote_ticket is refinement's channel for column moves: it is pinned
    // to the two planning columns and demands the missing question.
    refinement: ["update_ticket_status"],
  };

/** The agent tools a given agent type may be offered. */
export function allowedToolNamesForAgentType(
  agentType: string | null | undefined,
  provider = "claude-code",
): string[] {
  const withheld = new Set(
    (agentType && AGENT_TYPE_WITHHELD_TOOL_NAMES[agentType]) || []
  );
  return ARIJ_MCP_AGENT_TOOLS.filter((tool) => !withheld.has(tool)).map((tool) =>
    arijMcpToolName(provider, tool),
  );
}

/**
 * Tolerant parse of the settings row value. Settings values are
 * JSON-encoded ("false"), but legacy bare strings are tolerated (pattern:
 * parseMemoryAutoDistillSetting). DEFAULT ON: anything that is not an
 * explicit false disables nothing.
 */
export function parseMcpToolsEnabledSetting(value: unknown): boolean {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — compare as-is below
    }
  }
  if (parsed === false) return false;
  if (typeof parsed === "string") {
    return parsed.trim().toLowerCase() !== "false";
  }
  return true;
}

/** Reads the global toggle from the settings table. Absent row = enabled. */
export function isMcpToolsEnabled(): boolean {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, MCP_TOOLS_ENABLED_SETTING_KEY))
    .get();

  if (!row) return true;
  return parseMcpToolsEnabledSetting(row.value);
}

/**
 * Whether a provider has a per-spawn MCP injection surface. Verdicts from
 * the architecture contract (docs/architecture/mcp-provider-matrix.md):
 * claude-code yes (--mcp-config file), codex yes (-c mcp_servers.*
 * overrides), oh-my-pi yes (its mcp.json entry expands ${ARIJ_MCP_TOKEN}
 * at load time, so the child's environment is the per-spawn surface — see
 * OhMyPiProvider.buildEnv), agy yes (its static mcp_config.json entry
 * spawns the shim from the CLI process, which inherits the child env —
 * see AgyProvider.buildEnv). Since the 2026-08 cleanup every REGISTERED
 * provider qualifies; the gate still matters for legacy DB rows naming a
 * removed provider.
 */
export function providerSupportsMcp(provider: string): boolean {
  return (
    provider === "claude-code" ||
    provider === "codex" ||
    provider === "oh-my-pi" ||
    provider === "agy"
  );
}

/**
 * Builds the per-session spawn config around a freshly minted token.
 *
 * `process.execPath` + app-root-relative shim path: sessions run with
 * cwd = worktree while the Next server's cwd is the app root (bin/arij.mjs
 * sets it), so the shim path must be absolute from the server's cwd.
 *
 * The default (agent) toolset keeps the config byte-identical to before
 * toolsets existed: no ARIJ_MCP_TOOLSET key is emitted at all.
 *
 * `provider` selects ONLY the tool-name spelling of `allowedToolNames`
 * (see arijMcpToolName); the default keeps existing claude/codex call
 * sites byte-identical.
 */
export function buildMcpSpawnConfig({
  token,
  toolset = "agent",
  agentType = null,
  provider = "claude-code",
}: {
  token: string;
  toolset?: ArijMcpToolset;
  /** Narrows the agent toolset — see AGENT_TYPE_WITHHELD_TOOL_NAMES. */
  agentType?: string | null;
  provider?: string;
}): McpSpawnConfig {
  return {
    serverName: ARIJ_MCP_SERVER_NAME,
    command: process.execPath,
    args: [path.join(process.cwd(), ...ARIJ_MCP_SHIM_RELATIVE_PATH)],
    env: {
      ARIJ_BASE_URL: getAppBaseUrl(),
      ARIJ_MCP_TOKEN: token,
      ...(toolset === "chat" ? { ARIJ_MCP_TOOLSET: "chat" as const } : {}),
    },
    allowedToolNames:
      toolset === "chat"
        ? ARIJ_MCP_CHAT_TOOLS.map((tool) => arijMcpToolName(provider, tool))
        : allowedToolNamesForAgentType(agentType, provider),
  };
}

/** Prefix of the 0700 temp directory holding a session's MCP config file. */
export const MCP_CONFIG_DIR_PREFIX = "arij-mcp-";

/** Basename of the config file inside that directory. */
export const MCP_CONFIG_FILE_NAME = "mcp-config.json";

/**
 * The `--mcp-config` payload for the claude CLI, as a plain object.
 * Exported so tests can assert the file's contents without duplicating the
 * shape.
 */
export function buildClaudeMcpConfigJson(mcp: McpSpawnConfig): string {
  return JSON.stringify({
    mcpServers: {
      [mcp.serverName]: {
        type: "stdio",
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
      },
    },
  });
}

/**
 * Writes the per-session claude MCP config to a 0600 file and returns its
 * path.
 *
 * `claude --mcp-config` accepts JSON files as well as inline JSON strings.
 * The file form is what keeps the bearer token OUT of the child's argv, and
 * therefore out of `/proc/<pid>/cmdline`, which is world-readable on Linux —
 * any local process (including the agent's own Bash tool) could otherwise
 * read the token straight off the process table.
 *
 * The file lives in a fresh `mkdtemp` directory (0700) so the path is
 * unpredictable and cannot be pre-created or symlinked by another user.
 * Caller owns the lifetime — see `cleanupMcpConfigFile`.
 */
export function writeMcpConfigFile(mcp: McpSpawnConfig): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), MCP_CONFIG_DIR_PREFIX));
  const filePath = path.join(dir, MCP_CONFIG_FILE_NAME);
  fs.writeFileSync(filePath, buildClaudeMcpConfigJson(mcp), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return filePath;
}

/**
 * Deletes a config file written by `writeMcpConfigFile` (and its temp
 * directory). Idempotent and never throws — it runs on the session teardown
 * path alongside token revocation, which must not fail.
 */
export function cleanupMcpConfigFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }
  const dir = path.dirname(filePath);
  if (path.basename(dir).startsWith(MCP_CONFIG_DIR_PREFIX)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // already gone, or not empty — leave it
    }
  }
}
