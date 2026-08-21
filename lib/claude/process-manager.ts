import { spawnClaude, type ClaudeOptions, type ClaudeResult } from "./spawn";
import { getProvider, type ProviderType, type ProviderSession } from "@/lib/providers";
import {
  type AgentSessionLifecycleStatus,
  isValidSessionTransition,
  isTerminalSessionStatus,
} from "@/lib/agent-sessions/lifecycle";
import { appendSessionChunk } from "@/lib/agent-sessions/chunks";
import { parseClaudeOutput, isNoTextualOutputFallback } from "./json-parser";
import {
  isMcpToolsEnabled,
  providerSupportsMcp,
  arijMcpToolPrefix,
  buildMcpSpawnConfig,
  cleanupMcpConfigFile,
} from "./mcp-injection";
import { arijToolsSection } from "./prompt-sections";
import {
  mintMcpToken,
  revokeMcpTokensForSession,
} from "@/lib/mcp/token-store";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus = AgentSessionLifecycleStatus;

export interface TrackedSession {
  sessionId: string;
  status: SessionStatus;
  provider: ProviderType;
  options: ClaudeOptions;
  startedAt: Date;
  completedAt?: Date;
  result?: ClaudeResult;
  cliSessionId?: string;
  kill: () => void;
  /** Provider session handle (PID-based for CC, thread-based for Codex). */
  providerSession?: ProviderSession;
  /** Temp `--mcp-config` file for claude-code spawns, cleared on teardown. */
  mcpConfigPath?: string;
}

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  provider: ProviderType;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  result?: ClaudeResult;
  cliSessionId?: string;
}

// ---------------------------------------------------------------------------
// Singleton process manager
// ---------------------------------------------------------------------------

class ClaudeProcessManager {
  private sessions: Map<string, TrackedSession> = new Map();

  private persistCliSessionId(sessionId: string, cliSessionId?: string): void {
    if (!cliSessionId) {
      return;
    }

    try {
      db.update(agentSessions)
        .set({ cliSessionId })
        .where(eq(agentSessions.id, sessionId))
        .run();
    } catch (error) {
      console.error(
        `[process-manager] Failed to persist cliSessionId for session ${sessionId}`,
        error
      );
    }
  }

  /**
   * Spawns a new provider session and tracks it under the given session ID.
   * If a session with the same ID is already running, it throws an error.
   *
   * When provider is not 'claude-code', dispatches via the provider abstraction.
   *
   * Returns the session info immediately. The process runs in the background
   * and updates the session state on completion.
   */
  start(
    sessionId: string,
    options: ClaudeOptions,
    provider: ProviderType = "claude-code",
  ): SessionInfo {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "running") {
      throw new Error(
        `Session ${sessionId} is already running. Cancel it before starting a new one.`,
      );
    }

    // Arij MCP tool channel — mint a per-session bearer token, attach the
    // MCP server config for the provider to inject, and append the tools
    // prompt section. This is the single wiring point for AGENT sessions:
    // every dispatch route threads through here. Direct spawnClaude call
    // sites (generate-spec, import) never get injection; CLI chat turns get
    // their own chat-toolset channel from lib/chat/cli-tool-channel.ts.
    // Strictly best-effort: a session must never fail to spawn because
    // injection did. Gates: settings toggle (absent row = enabled),
    // provider support (claude-code/codex/oh-my-pi), and an agent_sessions
    // row — the row is the authority for the project scope the token binds
    // to. The tool spelling and prompt prefix follow the provider (omp says
    // mcp__arij_*, one underscore short — see arijMcpToolPrefix).
    try {
      if (providerSupportsMcp(provider) && isMcpToolsEnabled()) {
        const row = db
          .select({
            projectId: agentSessions.projectId,
            epicId: agentSessions.epicId,
            userStoryId: agentSessions.userStoryId,
            agentType: agentSessions.agentType,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, sessionId))
          .get();

        if (row) {
          const token = mintMcpToken({
            sessionId,
            projectId: row.projectId,
            epicId: row.epicId,
            userStoryId: row.userStoryId,
            agentType: row.agentType,
          });
          options.mcp = buildMcpSpawnConfig({ token, provider });
          options.prompt +=
            "\n" +
            arijToolsSection(row.agentType ?? null, arijMcpToolPrefix(provider));
        }
      }
    } catch (error) {
      console.warn(
        `[process-manager] MCP injection skipped for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    }

    let kill: () => void;
    let promise: Promise<ClaudeResult>;
    let providerSession: ProviderSession | undefined;
    let mcpConfigPath: string | undefined;

    if (provider !== "claude-code") {
      const dynamicProvider = getProvider(provider);
      const session = dynamicProvider.spawn({
        sessionId,
        prompt: options.prompt,
        cwd: options.cwd || process.cwd(),
        mode: options.mode,
        allowedTools: options.allowedTools,
        model: options.model,
        cliSessionId: options.cliSessionId,
        resumeSession: options.resumeSession,
        mcp: options.mcp,
        onChunk: (chunk) => {
          try {
            appendSessionChunk({
              sessionId,
              streamType: chunk.streamType,
              content: chunk.text,
              chunkKey: chunk.chunkKey ?? null,
              createdAt: chunk.emittedAt,
            });
          } catch (error) {
            console.error(
              `[process-manager] Failed to persist ${provider} chunk for session ${sessionId}`,
              error
            );
          }
        },
      });
      kill = session.kill;
      promise = session.promise;
      providerSession = session;

      // Persist CLI command
      if (session.command) {
        try {
          db.update(agentSessions)
            .set({ cliCommand: session.command })
            .where(eq(agentSessions.id, sessionId))
            .run();
        } catch { /* best-effort */ }
      }
    } else {
      // Default: Claude Code CLI
      const spawned = spawnClaude(options);
      kill = spawned.kill;
      promise = spawned.promise;
      mcpConfigPath = spawned.mcpConfigPath;

      // Persist CLI command
      if (spawned.command) {
        try {
          db.update(agentSessions)
            .set({ cliCommand: spawned.command })
            .where(eq(agentSessions.id, sessionId))
            .run();
        } catch { /* best-effort */ }
      }
    }

    const session: TrackedSession = {
      sessionId,
      status: "running",
      provider,
      options,
      cliSessionId: options.cliSessionId,
      startedAt: new Date(),
      kill,
      providerSession,
      mcpConfigPath,
    };

    this.sessions.set(sessionId, session);

    // Handle completion in the background
    promise
      .then((result) => {
        // Tear the tool channel down the moment the process exits.
        // Revocation keeps the token-store record (the askedQuestion flag
        // must survive until the dispatch route classifies the outcome);
        // the grace-period purge is the destructor.
        this.teardownMcpChannel(sessionId, mcpConfigPath);

        const tracked = this.sessions.get(sessionId);
        if (!tracked) return;

        const targetStatus: SessionStatus = result.success ? "completed" : "failed";
        const resolvedCliSessionId =
          result.cliSessionId ??
          tracked.cliSessionId ??
          tracked.options.cliSessionId;

        if (resolvedCliSessionId) {
          tracked.cliSessionId = resolvedCliSessionId;
          this.persistCliSessionId(sessionId, resolvedCliSessionId);
        }

        // For Claude Code sessions, persist result text as a session chunk
        // so that lastNonEmptyText gets populated (non-CC providers do this
        // via the onChunk callback during execution).
        this.persistResultAsChunk(sessionId, result, tracked.provider);

        // Only transition if the move is valid (e.g. not already cancelled)
        if (isValidSessionTransition(tracked.status, targetStatus)) {
          tracked.status = targetStatus;
          tracked.completedAt = new Date();
          tracked.result = result;
        }
      })
      .catch((err: Error) => {
        this.teardownMcpChannel(sessionId, mcpConfigPath);

        const tracked = this.sessions.get(sessionId);
        if (!tracked) return;

        if (isValidSessionTransition(tracked.status, "failed")) {
          tracked.status = "failed";
          tracked.completedAt = new Date();
          tracked.result = {
            success: false,
            error: err.message,
            duration: Date.now() - tracked.startedAt.getTime(),
          };
        }
      });

    return this.toSessionInfo(session);
  }

  /**
   * Cancels a running session by killing the underlying process.
   * Works uniformly for both Claude Code (SIGTERM→SIGKILL) and Codex (AbortController).
   * Returns true if the session was running and has been cancelled,
   * false if the session was not found or not in a cancellable state.
   */
  cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (!isValidSessionTransition(session.status, "cancelled")) {
      return false;
    }

    session.kill();
    session.status = "cancelled";
    session.completedAt = new Date();
    session.result = {
      success: false,
      error: "Process was cancelled by user.",
      duration: Date.now() - session.startedAt.getTime(),
    };

    // Cancellation is terminal for the tool channel too — don't wait for
    // the killed process's close event to invalidate the token.
    this.teardownMcpChannel(sessionId, session.mcpConfigPath);

    return true;
  }

  /**
   * Returns the current status and result for a given session.
   * Returns null if the session is not tracked.
   */
  getStatus(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return this.toSessionInfo(session);
  }

  /**
   * Returns info for all sessions that are currently running.
   */
  listActive(): SessionInfo[] {
    const active: SessionInfo[] = [];

    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      if (session.status === "running") {
        active.push(this.toSessionInfo(session));
      }
    }

    return active;
  }

  /**
   * Returns info for all tracked sessions regardless of status.
   */
  listAll(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) =>
      this.toSessionInfo(s),
    );
  }

  /**
   * Removes a completed/failed/cancelled session from tracking.
   * Running sessions cannot be removed -- cancel them first.
   * Returns true if the session was removed.
   */
  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Only terminal sessions can be removed
    if (!isTerminalSessionStatus(session.status)) {
      return false;
    }

    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Returns the number of currently running sessions.
   */
  get activeCount(): number {
    let count = 0;
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      if (session.status === "running") count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Best-effort teardown of the session's MCP tool channel: revoke its bearer
   * tokens and delete the temp `--mcp-config` file that holds a copy of one.
   * A completion handler must never fail (and mark the session failed)
   * because the token store or the filesystem did. No-op for sessions that
   * never got injection.
   *
   * The config path is passed in (not read off the tracked session) so a late
   * handler from a previous run can never delete a restarted session's file.
   * Deleting is idempotent — spawnClaude already clears the file on exit;
   * this is the backstop for paths where its close event never lands.
   */
  private teardownMcpChannel(
    sessionId: string,
    mcpConfigPath?: string,
  ): void {
    try {
      revokeMcpTokensForSession(sessionId);
    } catch (error) {
      console.warn(
        `[process-manager] Failed to revoke MCP tokens for session ${sessionId}`,
        error,
      );
    }
    try {
      cleanupMcpConfigFile(mcpConfigPath);
    } catch (error) {
      console.warn(
        `[process-manager] Failed to remove MCP config file for session ${sessionId}`,
        error,
      );
    }
  }

  /**
   * Persist the result text from a completed session as a session chunk.
   *
   * Non-Claude-Code providers stream chunks via onChunk during execution,
   * which populates `lastNonEmptyText`. Claude Code only returns stdout on
   * exit, so we need to do it here.
   */
  private persistResultAsChunk(
    sessionId: string,
    result: ClaudeResult,
    provider: ProviderType,
  ): void {
    if (!result.result) return;

    try {
      const parsed = parseClaudeOutput(result.result);
      const text = parsed.content;

      // Skip if we only got a fallback message — nothing useful to persist
      if (!text || isNoTextualOutputFallback(text)) return;

      appendSessionChunk({
        sessionId,
        streamType: "output",
        content: text,
        chunkKey: `result-${sessionId}`,
      });
    } catch (error) {
      console.error(
        `[process-manager] Failed to persist result chunk for ${provider} session ${sessionId}`,
        error,
      );
    }
  }

  private toSessionInfo(session: TrackedSession): SessionInfo {
    const info: SessionInfo = {
      sessionId: session.sessionId,
      status: session.status,
      provider: session.provider,
      startedAt: session.startedAt,
    };

    if (session.completedAt) {
      info.completedAt = session.completedAt;
    }

    // Compute duration: completed sessions use stored result, running sessions
    // compute elapsed time from startedAt
    if (session.result?.duration !== undefined) {
      info.duration = session.result.duration;
    } else if (session.status === "running") {
      info.duration = Date.now() - session.startedAt.getTime();
    }

    if (session.result) {
      info.result = session.result;
    }

    if (session.cliSessionId) {
      info.cliSessionId = session.cliSessionId;
    }

    return info;
  }
}

/**
 * Singleton instance of the process manager.
 * In Next.js server-side code, module-level singletons persist across
 * requests within the same server process.
 */
export const processManager = new ClaudeProcessManager();
