/**
 * Provider abstraction types for AI agent backends.
 *
 * Claude Code, Codex, and Gemini CLI implement this interface so that build
 * routes, review routes, and the process manager can work with any backend.
 */

import type { NamedAgentCliOptions } from "./options-registry";
import type { ExtraMcpScope } from "./extra-mcp-scope";

/**
 * Every provider here MUST support per-spawn injection of the Arij MCP tool
 * channel (providerSupportsMcp in lib/claude/mcp-injection.ts) — the channel
 * is how agents reach the board, so a CLI that cannot be handed a per-session
 * MCP config is not eligible. The 2026-08 cleanup removed gemini-cli,
 * mistral-vibe, qwen-code, opencode, deepseek, kimi, zai and pi for exactly
 * that reason; see docs/architecture/mcp-provider-matrix.md before adding
 * one back.
 */
export type ProviderType = "claude-code" | "codex" | "oh-my-pi" | "agy";

export type ProviderChunkStreamType = "response" | "raw" | "output";

export interface ProviderChunk {
  streamType: ProviderChunkStreamType;
  text: string;
  chunkKey?: string;
  emittedAt?: string;
}

/**
 * Per-session Arij MCP server injection config, built by
 * `lib/claude/mcp-injection.ts` at spawn time (processManager.start is the
 * single wiring point). Providers translate it into their CLI's MCP wiring:
 * Claude Code via `--mcp-config <0600 temp file>` + `--strict-mcp-config`,
 * Codex via `-c mcp_servers.<name>.*` TOML overrides, Oh My Pi via the
 * child's environment (its mcp.json entry expands ${ARIJ_MCP_TOKEN} at load
 * time). For claude and codex the bearer token rides INSIDE the config
 * (never in the child's process env), so agent Bash subshells never see it;
 * claude's file form additionally keeps it out of argv/`/proc/<pid>/cmdline`.
 * Codex has no file form and omp has no config form at all — see the
 * residual exposure notes in lib/providers/codex.ts and
 * lib/providers/oh-my-pi.ts.
 */
/**
 * One MCP server as handed to a provider. `stdio` launches a child process,
 * `http` points at a URL — the two shapes are disjoint, which is what the
 * optional-never members encode.
 *
 * `env` / `headers` may carry SECRETS (a third-party server's API token).
 * Anything that renders a spec into a display command, a log line, or a
 * persisted field must redact them — see maskCodexMcpSecret in
 * lib/providers/codex.ts, which masks every `mcp_servers.*.env=` override
 * rather than only the one carrying ARIJ_MCP_TOKEN.
 */
export interface McpStdioServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: undefined;
  headers?: undefined;
  /** Bare tool names to allow; absent = every tool the server exposes. */
  toolAllowlist?: string[] | null;
}

export interface McpHttpServerSpec {
  name: string;
  url: string;
  headers: Record<string, string>;
  command?: undefined;
  args?: undefined;
  env?: undefined;
  /** Bare tool names to allow; absent = every tool the server exposes. */
  toolAllowlist?: string[] | null;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/**
 * Per-session MCP injection config, built by `lib/claude/mcp-injection.ts` at
 * spawn time (processManager.start is the single wiring point for agent
 * sessions; lib/chat/cli-tool-channel.ts is the chat-turn equivalent).
 * Providers translate it into their CLI's MCP wiring: Claude Code via
 * `--mcp-config <0600 temp file>` + `--strict-mcp-config`, Codex via
 * `-c mcp_servers.<name>.*` TOML overrides, Oh My Pi and agy via the child's
 * environment (their user-global registry entry expands ${ARIJ_MCP_TOKEN} at
 * load time).
 *
 * `servers` is a LIST because the user can declare third-party MCP servers
 * (Godot, Confluence, Playwright…) globally or per project — see
 * lib/mcp/servers.ts. `servers[0]` is ALWAYS the Arij control channel:
 * `--strict-mcp-config` means the user's own ~/.claude.json and .mcp.json are
 * ignored, so everything an agent can reach has to be in here, and the
 * control channel must never be displaced by a user entry (the name `arij` is
 * reserved at validation time for exactly that reason). Use `arijChannelSpec`
 * rather than indexing, so providers that only need the Arij channel's env
 * (omp, agy) say so explicitly.
 *
 * For claude and codex the Arij bearer token rides INSIDE the config (never
 * in the child's process env), so agent Bash subshells never see it; claude's
 * file form additionally keeps it out of argv/`/proc/<pid>/cmdline`. Codex
 * has no file form and omp/agy have no config form at all — see the residual
 * exposure notes in lib/providers/codex.ts and lib/providers/oh-my-pi.ts.
 */
export interface McpSpawnConfig {
  /**
   * Every server for this spawn, Arij first, then user-declared extras in
   * resolution order (globals, then the project's own).
   */
  servers: McpServerSpec[];
  /**
   * Exact tool names merged into the allowlist, in the spawning provider's
   * spelling — claude/codex say mcp__arij__get_ticket, omp says
   * mcp__arij_get_ticket, agy uses the bare name (see arijMcpToolName).
   * Third-party servers contribute a whole-server entry instead, since their
   * tools are not enumerable before the server is contacted.
   */
  allowedToolNames: string[];
}

/**
 * The Arij control channel — `servers[0]` by construction. Providers whose
 * only MCP surface is the child environment (omp, agy) need its `env` and
 * nothing else.
 */
export function arijChannelSpec(mcp: McpSpawnConfig): McpStdioServerSpec {
  const first = mcp.servers[0];
  if (!first || first.command === undefined) {
    throw new Error(
      "McpSpawnConfig.servers[0] must be the Arij stdio control channel",
    );
  }
  return first;
}

export interface ProviderSpawnOptions {
  /** Unique session identifier used for tracking. */
  sessionId: string;
  /** The prompt/instructions for the agent. */
  prompt: string;
  /** Working directory for the agent. */
  cwd: string;
  /**
   * Agent mode: "plan" = read-only, "code" = full write access, "analyze" =
   * repository analysis with enough write access to create its requested
   * artifact. "chat" is claude-code's conversational mode (read-only repo,
   * MCP board tools allowed); providers without a distinct chat posture
   * treat it as "plan".
   */
  mode: "plan" | "code" | "analyze" | "chat";
  /** Explicit list of allowed tools (Claude Code only). */
  allowedTools?: string[];
  /** Model override. */
  model?: string;
  /** Optional chunk callback (used by Codex session persistence). */
  onChunk?: (chunk: ProviderChunk) => void;
  /** Optional identifier for NDJSON session logging. */
  logIdentifier?: string;
  /** CLI session UUID for resume support (Claude/Gemini only). */
  cliSessionId?: string;
  /** When true, use --resume instead of --session-id. */
  resumeSession?: boolean;
  /** Arij MCP tool-channel injection (claude-code, codex, oh-my-pi). */
  mcp?: McpSpawnConfig;
  /**
   * Per-CLI options resolved from the named agent that owns this session,
   * already validated against THIS provider's registry entry (see
   * lib/providers/options-registry.ts). Providers translate them to argv;
   * absent or empty means every option is at the CLI's default and the argv
   * is exactly what it was before the registry existed.
   */
  cliOptions?: NamedAgentCliOptions;
}

export interface ProviderResult {
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
  /** Provider CLI session ID extracted from output when available. */
  cliSessionId?: string;
  /** True when the provider ended by asking a follow-up user question. */
  endedWithQuestion?: boolean;
}

export interface ProviderSession {
  /** Provider-specific handle for cancellation. Claude Code uses PID, Codex uses thread ID. */
  handle: string;
  /** Kill/cancel the running session. */
  kill: () => void;
  /** Promise that resolves when the session completes. */
  promise: Promise<ProviderResult>;
  /** The CLI command that was spawned (prompt replaced with <prompt>). */
  command?: string;
}

export interface AgentProvider {
  readonly type: ProviderType;

  /**
   * Which scopes of user-declared MCP servers this CLI can honor —
   * "per-spawn" (global + project) or "user-global" (globals only). Declared
   * per provider so the feature cannot be wired for one CLI and silently
   * absent on another; see lib/providers/extra-mcp-scope.ts for what each
   * value costs.
   */
  readonly extraMcpScope: ExtraMcpScope;

  /** Spawn a new agent session. Returns a handle for tracking. */
  spawn(options: ProviderSpawnOptions): ProviderSession;

  /** Cancel a running session by its handle. Returns true if cancelled. */
  cancel(session: ProviderSession): boolean;

  /** Check if the provider is available (CLI installed, API key set, etc.). */
  isAvailable(): Promise<boolean>;
}
