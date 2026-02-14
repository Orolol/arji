import { spawnClaude, type ClaudeOptions, type ClaudeResult } from "./spawn";
import { getProvider, type ProviderType, type ProviderSession } from "@/lib/providers";
import {
  type SessionStatus,
  isValidTransition,
  isTerminalStatus,
} from "@/lib/sessions/status-machine";
import { appendSessionChunk } from "@/lib/agent-sessions/chunks";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SessionStatus } from "@/lib/sessions/status-machine";

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

    let kill: () => void;
    let promise: Promise<ClaudeResult>;
    let providerSession: ProviderSession | undefined;

    if (provider !== "claude-code") {
      const dynamicProvider = getProvider(provider);
      const session = dynamicProvider.spawn({
        sessionId,
        prompt: options.prompt,
        cwd: options.cwd || process.cwd(),
        mode: options.mode,
        allowedTools: options.allowedTools,
        model: options.model,
        cliSessionId: options.cliSessionId ?? options.claudeSessionId,
        claudeSessionId: options.claudeSessionId,
        resumeSession: options.resumeSession,
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
      cliSessionId: options.cliSessionId ?? options.claudeSessionId,
      startedAt: new Date(),
      kill,
      providerSession,
    };

    this.sessions.set(sessionId, session);

    // Handle completion in the background
    promise
      .then((result) => {
        const tracked = this.sessions.get(sessionId);
        if (!tracked) return;

        const targetStatus: SessionStatus = result.success ? "completed" : "failed";
        const resolvedCliSessionId =
          result.cliSessionId ??
          tracked.cliSessionId ??
          tracked.options.cliSessionId ??
          tracked.options.claudeSessionId;

        if (resolvedCliSessionId) {
          tracked.cliSessionId = resolvedCliSessionId;
          this.persistCliSessionId(sessionId, resolvedCliSessionId);
        }

        // Only transition if the move is valid (e.g. not already cancelled)
        if (isValidTransition(tracked.status, targetStatus)) {
          tracked.status = targetStatus;
          tracked.completedAt = new Date();
          tracked.result = result;
        }
      })
      .catch((err: Error) => {
        const tracked = this.sessions.get(sessionId);
        if (!tracked) return;

        if (isValidTransition(tracked.status, "failed")) {
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

    if (!isValidTransition(session.status, "cancelled")) {
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
    if (!isTerminalStatus(session.status)) {
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
