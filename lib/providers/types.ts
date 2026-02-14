/**
 * Provider abstraction types for AI agent backends.
 *
 * Claude Code, Codex, and Gemini CLI implement this interface so that build
 * routes, review routes, and the process manager can work with any backend.
 */

export type ProviderType = "claude-code" | "codex" | "gemini-cli";

export type ProviderChunkStreamType = "response" | "raw" | "output";

export interface ProviderChunk {
  streamType: ProviderChunkStreamType;
  text: string;
  chunkKey?: string;
  emittedAt?: string;
}

export interface ProviderSpawnOptions {
  /** Unique session identifier used for tracking. */
  sessionId: string;
  /** The prompt/instructions for the agent. */
  prompt: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Agent mode: "plan" = read-only, "code" = full write access. */
  mode: "plan" | "code" | "analyze";
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
  /** @deprecated Use cliSessionId. Kept for compatibility while routes migrate. */
  claudeSessionId?: string;
  /** When true, use --resume instead of --session-id. */
  resumeSession?: boolean;
}

export interface ProviderResult {
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
  /** Provider CLI session ID extracted from output when available. */
  cliSessionId?: string;
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
