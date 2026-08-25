/**
 * Arij MCP tool-channel injection — gating and per-session spawn config.
 *
 * Spawned agent sessions get a structured channel back to Arij: a stdio MCP
 * shim (bin/arij-mcp.mjs) exposing mcp__arij__* tools that bridge to the
 * /api/mcp/* HTTP routes with a per-session bearer token
 * (lib/mcp/token-store.ts). This module decides WHEN a spawn gets the
 * channel and builds WHAT the providers inject; the single wiring point that
 * calls it is processManager.start() (lib/claude/process-manager.ts).
 *
 * Gates (all must hold):
 *   1. The `mcp_tools_enabled` setting is not explicitly false — an ABSENT
 *      row means ENABLED (default on).
 *   2. The provider supports per-spawn MCP config injection: claude-code
 *      (--mcp-config <file>) and codex (-c mcp_servers.* overrides). gemini-cli is
 *      out for v1 — its CLI only reads MCP config from .gemini/settings.json
 *      files, which would mean writing config into user worktrees.
 *   3. The session has an agent_sessions row (checked by the caller) — the
 *      row provides the project scope the token is bound to. Spawns without
 *      rows (generate-spec, import) get no injection by construction.
 *
 * CLI chat conversations are the one exception to the single wiring point:
 * they have no agent_sessions row, so the chat stream route wires its own
 * per-turn channel through lib/chat/cli-tool-channel.ts — same gates 1 and 2,
 * project scope from the route params, and the "chat" toolset (board tools,
 * no ask_question/submit_findings/submit_grading) instead of the agent
 * toolset.
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

/** MCP server name — the agent sees tools as `mcp__arij__<tool>`. */
export const ARIJ_MCP_SERVER_NAME = "arij";

/** Path of the stdio shim, relative to the app root (the server's cwd). */
export const ARIJ_MCP_SHIM_RELATIVE_PATH = ["bin", "arij-mcp.mjs"] as const;

/** The agent tools, as exact allowlist entries (no wildcards). */
export const ARIJ_MCP_ALLOWED_TOOL_NAMES = [
  "mcp__arij__get_ticket",
  "mcp__arij__update_ticket_status",
  "mcp__arij__post_comment",
  "mcp__arij__attach_artifact",
  "mcp__arij__create_bug",
  "mcp__arij__ask_question",
  "mcp__arij__submit_findings",
  "mcp__arij__submit_grading",
] as const;

/**
 * The chat-toolset tools (CLI chat conversations), as exact allowlist
 * entries. Mirrors the fast-mode board tools (lib/chat/board-tools.ts);
 * ask_question/submit_findings/submit_grading are deliberately absent —
 * nothing holds a chat turn, and chat tokens are rejected by those routes
 * anyway.
 */
export const ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES = [
  "mcp__arij__list_tickets",
  "mcp__arij__get_ticket",
  "mcp__arij__create_ticket",
  "mcp__arij__update_ticket",
  "mcp__arij__update_ticket_status",
  "mcp__arij__post_comment",
  "mcp__arij__get_agent_status",
  "mcp__arij__start_build",
] as const;

/** Which shim toolset a spawn config selects (ARIJ_MCP_TOOLSET env). */
export type ArijMcpToolset = "agent" | "chat";

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
 * the architecture contract: claude-code yes, codex yes, gemini-cli no
 * (revisit when the CLI is installed and gains a per-spawn override).
 */
export function providerSupportsMcp(provider: string): boolean {
  return provider === "claude-code" || provider === "codex";
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
 */
export function buildMcpSpawnConfig({
  token,
  toolset = "agent",
}: {
  token: string;
  toolset?: ArijMcpToolset;
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
        ? [...ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES]
        : [...ARIJ_MCP_ALLOWED_TOOL_NAMES],
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
