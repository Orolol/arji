/**
 * Provider abstraction types for AI agent backends.
 *
 * Claude Code, Codex, and Gemini CLI implement this interface so that build
 * routes, review routes, and the process manager can work with any backend.
 */

export type ProviderType =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "mistral-vibe"
  | "qwen-code"
  | "opencode"
  | "deepseek"
  | "kimi"
  | "zai"
  | "pi"
  | "oh-my-pi";

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
export interface McpSpawnConfig {
  /**
   * MCP server name exposed to the agent. The tool prefix it produces is
   * CLI-specific: `mcp__<name>__*` on claude/codex, `mcp__<name>_*` on omp.
   */
  serverName: string;
  /** Executable that launches the stdio MCP shim (the running node binary). */
  command: string;
  /** Shim arguments — app-root-absolute path to bin/arij-mcp.mjs. */
  args: string[];
  /** Environment for the shim process only: base URL + per-session token. */
  env: {
    ARIJ_BASE_URL: string;
    ARIJ_MCP_TOKEN: string;
    /** Selects the shim's toolset; absent = the default agent toolset. */
    ARIJ_MCP_TOOLSET?: "chat";
  };
  /**
   * Exact tool names merged into the allowlist (no wildcards), in the
   * spawning provider's spelling — claude/codex say mcp__arij__get_ticket,
   * omp says mcp__arij_get_ticket (see arijMcpToolName).
   */
  allowedToolNames: string[];
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

  /** Spawn a new agent session. Returns a handle for tracking. */
  spawn(options: ProviderSpawnOptions): ProviderSession;

  /** Cancel a running session by its handle. Returns true if cancelled. */
  cancel(session: ProviderSession): boolean;

  /** Check if the provider is available (CLI installed, API key set, etc.). */
  isAvailable(): Promise<boolean>;
}
