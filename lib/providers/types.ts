/**
 * Provider abstraction types for AI agent backends.
 *
 * Both Claude Code and Codex implement this interface so that build routes,
 * review routes, and the process manager can work with either backend.
 */

export type ProviderType = "claude-code" | "codex";

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
}

export interface ProviderResult {
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
}

export interface ProviderSession {
  /** Provider-specific handle for cancellation. Claude Code uses PID, Codex uses thread ID. */
  handle: string;
  /** Kill/cancel the running session. */
  kill: () => void;
  /** Promise that resolves when the session completes. */
  promise: Promise<ProviderResult>;
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
