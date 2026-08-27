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
  MCP_CHANNEL_INJECTED,
  MCP_CHANNEL_UNAVAILABLE,
} from "./mcp-injection";
import { arijToolsSection } from "./prompt-sections";
import { isMcpExemptAgentType } from "@/lib/workflow/dreaming-constants";
import {
  mintMcpToken,
  revokeMcpTokensForSession,
} from "@/lib/mcp/token-store";
import { getNamedAgentRuntimeConfig } from "@/lib/agent-config/named-agents";
import { acceptsPersonaPrompt } from "@/lib/agent-config/constants";
import { filterProviderOptionsForAgentType } from "@/lib/providers/options-registry";
import { personaSection } from "./prompt-sections";
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

    // Work on a COPY. Both blocks below rewrite `prompt`, and a retry ladder
    // that re-dispatches the same options object would otherwise stack a
    // second persona and a second tools section onto an already-injected
    // prompt.
    options = { ...options };

    // One read of the session row for both blocks below. `agentType` is what
    // scopes the persona and the agent-type-restricted options; the project
    // and ticket ids are what the MCP token binds to. Best-effort: a session
    // must never fail to spawn because its own row could not be read.
    let sessionRow:
      | {
          projectId: string;
          epicId: string | null;
          userStoryId: string | null;
          agentType: string | null;
          namedAgentId: string | null;
        }
      | undefined;
    try {
      sessionRow = db
        .select({
          projectId: agentSessions.projectId,
          epicId: agentSessions.epicId,
          userStoryId: agentSessions.userStoryId,
          agentType: agentSessions.agentType,
          namedAgentId: agentSessions.namedAgentId,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get();
    } catch (error) {
      console.warn(
        `[process-manager] Session row unreadable for ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    }

    // Named-agent configuration — the second thing this wiring point owns,
    // alongside the MCP channel below. Every dispatch path (manual routes,
    // pipeline stages, night runs, Full Auto, grading, merge resolution)
    // reaches the CLI through here, so resolving the agent's per-CLI options
    // and persona once, HERE, is what keeps automated modes from needing a
    // parallel plumbing of their own.
    //
    // The persona is PREPENDED (the tools section is appended), which puts it
    // ahead of the role prompt, the specification and the ticket — see
    // docs/architecture/named-agent-cli-options.md for the full order.
    //
    // BOTH halves are scoped by the session's agent TYPE, not by its spawn
    // mode. Reviews, grading and the second-opinion gate all spawn in mode
    // "code" on purpose (plan mode refuses the mutating MCP tools they exist
    // to call), so a mode-based gate would not tell them apart from a build.
    try {
      const agentRow = sessionRow;

      const { options: resolvedOptions, personaPrompt } =
        getNamedAgentRuntimeConfig(agentRow?.namedAgentId, provider);

      // Options the agent type may not carry (claude's permission mode) are
      // dropped here, where the type is known; the registry declares which.
      const cliOptions = filterProviderOptionsForAgentType(
        provider,
        resolvedOptions,
        agentRow?.agentType,
      );

      // Strict document-rewrite and fixed-contract sessions get NO persona.
      // spec_generation replaces projects.spec with its response verbatim,
      // the memory writers replace the memory document, release_notes becomes
      // CHANGELOG.md — free-form persona text ("answer in French, summarise
      // your reasoning") would be written into the stored artifact and then
      // feed every later prompt. See PERSONA_AGENT_TYPES.
      const persona = acceptsPersonaPrompt(agentRow?.agentType)
        ? personaSection(personaPrompt)
        : "";
      const patch: { cliOptions?: string; prompt?: string } = {};

      if (Object.keys(cliOptions).length > 0) {
        options.cliOptions = cliOptions;
        // Audit trail: the agent can be edited or deleted after this run, so
        // the options that were actually in effect belong on the session row.
        // NULL stays NULL when nothing was configured — legacy rows and
        // unconfigured agents read the same.
        patch.cliOptions = JSON.stringify(cliOptions);
      }

      if (persona) {
        options.prompt = persona + options.prompt;
        // The queued row stored the prompt as the dispatch route built it,
        // before this injection. Re-persist it so the session detail shows
        // the persona the agent actually received — it is configuration, not
        // a secret, and a prompt display that omits it is misleading.
        patch.prompt = options.prompt;
      }

      if (patch.cliOptions !== undefined || patch.prompt !== undefined) {
        db.update(agentSessions)
          .set(patch)
          .where(eq(agentSessions.id, sessionId))
          .run();
      }
    } catch (error) {
      // Same posture as MCP injection: a session must never fail to spawn
      // because its optional configuration could not be read.
      console.warn(
        `[process-manager] Named-agent options skipped for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
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
    // provider support (claude-code/codex/oh-my-pi), an agent_sessions row —
    // the row is the authority for the project scope the token binds to —
    // and the agent type not being one of the strict document rewriters.
    // The tool spelling and prompt prefix follow the provider (omp says
    // mcp__arij_*, one underscore short — see arijMcpToolPrefix).
    // Whether this spawn was supposed to get the tool channel at all — the
    // question `agent_sessions.mcp_channel` answers for the review gate.
    //
    // It starts TRUE for every MCP-capable provider and is cleared only when
    // we positively learn the channel does not apply (toggle off, no session
    // row, MCP-exempt agent type). That default is what makes a THROWN
    // injection recordable: the failure paths below leave the flag set, so
    // the row says `unavailable` and the gate judges such a review by prose
    // instead of blaming it for a tool call it could not make. Clearing it
    // first and setting it late would leave exactly the silent gap this
    // column exists to close.
    let mcpChannelIntended = providerSupportsMcp(provider);
    try {
      if (mcpChannelIntended && !isMcpToolsEnabled()) {
        // Not a failure: the operator turned the channel off, and the
        // judgement-time fallback reads the same toggle.
        mcpChannelIntended = false;
      }
      if (mcpChannelIntended) {
        // Already read once at the top of this wiring point, for the
        // named-agent configuration above — the token binds to the same row.
        const row = sessionRow;

        // Strict document-rewrite agents opt out entirely (no token, no
        // config, no section): the section is APPENDED, so for them it would
        // land after the "respond with the document body and nothing else"
        // contract and end the prompt with ticket-tool guidance for a session
        // that owns no ticket. See MCP_EXEMPT_AGENT_TYPES.
        if (!row || isMcpExemptAgentType(row.agentType)) {
          mcpChannelIntended = false;
        } else {
          const token = mintMcpToken({
            sessionId,
            projectId: row.projectId,
            epicId: row.epicId,
            userStoryId: row.userStoryId,
            agentType: row.agentType,
          });
          options.mcp = buildMcpSpawnConfig({
            token,
            agentType: row.agentType,
            provider,
          });
          options.prompt +=
            "\n" +
            arijToolsSection(row.agentType ?? null, arijMcpToolPrefix(provider));
          // Re-persist the prompt WITH the appended section — same display
          // argument as the persona re-persist above, plus a hard requirement
          // of its own: resolveSessionOutput's echo scrub matches
          // agent_sessions.prompt as an exact substring of the session's
          // output, and a CLI that echoes its prompt echoes the SPAWNED
          // prompt, tools section included. A stored prompt that stops short
          // left the section behind in ticket comments (measured on
          // E-arij-138, 2026-08-27). Own try/catch: a failed write must not
          // be mistaken for a failed injection by the outer catch, which
          // would drop the channel that was just built.
          try {
            db.update(agentSessions)
              .set({ prompt: options.prompt })
              .where(eq(agentSessions.id, sessionId))
              .run();
          } catch (error) {
            console.warn(
              `[process-manager] Failed to persist the tools section for session ${sessionId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    } catch (error) {
      // Injection is best-effort: a session must never fail to spawn because
      // the channel could not be built. But it must not pass for a session
      // that CHOSE not to use its tools either — the review gate reads
      // mcp_channel precisely so a reviewer with no channel is judged by
      // prose instead of being blamed for a tool call it could not make.
      options.mcp = undefined;
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
        cliOptions: options.cliOptions,
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

    // Record what the child actually got. `options.mcp` is cleared when the
    // injection block failed; `spawned.mcpConfigPath` is null when the claude
    // spawn could not write its config file and dropped --mcp-config. Either
    // way the session ran WITHOUT the tools, and only the row says so — the
    // child never reaches the HTTP route, so no 401 is traced.
    if (mcpChannelIntended) {
      const wired =
        !!options.mcp && (provider !== "claude-code" || !!mcpConfigPath);
      try {
        db.update(agentSessions)
          .set({
            mcpChannel: wired ? MCP_CHANNEL_INJECTED : MCP_CHANNEL_UNAVAILABLE,
          })
          .where(eq(agentSessions.id, sessionId))
          .run();
      } catch (error) {
        console.warn(
          `[process-manager] Failed to record the MCP channel state for session ${sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
      if (!wired) {
        console.warn(
          `[process-manager] Session ${sessionId} spawned WITHOUT the Arij tool channel; its review cannot file structured findings.`,
        );
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
