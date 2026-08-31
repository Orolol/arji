/**
 * Which scopes of user-declared ("extra") MCP servers a provider can honor.
 *
 * The Arij control channel is per-spawn on every registered provider (see
 * providerSupportsMcp in lib/claude/mcp-injection.ts), but that is not the
 * same question as whether a THIRD-PARTY server can be scoped to one
 * project. Two different surfaces are involved:
 *
 * - `per-spawn` — the CLI accepts a complete MCP config for THIS spawn:
 *   claude-code via `--mcp-config <file>`, codex via `-c mcp_servers.<name>.*`
 *   overrides. Arij can therefore hand a different server set to every
 *   session, so both global and project-scoped servers are honored.
 *
 * - `user-global` — the CLI only reads a user-global registry that Arij does
 *   not get to vary per spawn: oh-my-pi's `~/.omp/agent/mcp.json`, agy's
 *   `agy mcp add` register. The Arij channel still rides per spawn there
 *   because the registry entry expands `${ARIJ_MCP_TOKEN}` from the child's
 *   environment — but a third-party server has no such indirection, so its
 *   definition has to be written into the registry ahead of time. Only
 *   GLOBAL servers can be honored that way; a project-scoped server would
 *   mean rewriting the registry before every spawn, which two concurrent
 *   sessions on two projects would race on. That race is why the scope is
 *   capped rather than worked around.
 *
 *   omp does read `.omp/mcp.json` relative to its cwd (the worktree), which
 *   would open the per-project door — but writing agent config INTO a user's
 *   worktree is exactly what disqualified gemini-cli in the 2026-08 cleanup.
 *   Deliberately out of scope.
 *
 * This map is the single source of truth; the provider classes expose it as
 * `AgentProvider.extraMcpScope`. It lives in its own module so the
 * resolution path (lib/mcp/servers.ts) can read a provider's scope without
 * importing lib/providers/index.ts, which instantiates every provider class
 * and pulls child_process in with it.
 */

import type { ProviderType } from "./types";

export type ExtraMcpScope = "per-spawn" | "user-global";

export const EXTRA_MCP_SCOPE_BY_PROVIDER: Record<ProviderType, ExtraMcpScope> = {
  "claude-code": "per-spawn",
  codex: "per-spawn",
  "oh-my-pi": "user-global",
  agy: "user-global",
};

/**
 * The scope for a provider name, tolerant of legacy rows naming a removed
 * provider — those fall back to claude-code everywhere else (getProvider),
 * so they resolve to its scope here too.
 */
export function extraMcpScopeForProvider(provider: string): ExtraMcpScope {
  return (
    EXTRA_MCP_SCOPE_BY_PROVIDER[provider as ProviderType] ??
    EXTRA_MCP_SCOPE_BY_PROVIDER["claude-code"]
  );
}

/**
 * The registered providers that CANNOT honor a project-scoped server. The UI
 * names them next to every project-scoped entry so the limitation is read off
 * the screen rather than inferred from a matrix in the docs — which is the
 * whole point of making the capability explicit.
 */
export const USER_GLOBAL_EXTRA_MCP_PROVIDERS: string[] = Object.entries(
  EXTRA_MCP_SCOPE_BY_PROVIDER,
)
  .filter(([, scope]) => scope === "user-global")
  .map(([provider]) => provider)
  .sort();
