/**
 * BaseCliProvider — abstract base class for CLI-based agent providers.
 *
 * Encapsulates the shared provider lifecycle:
 * - child_process.spawn with stdio piping
 * - stdout/stderr buffer collection
 * - SIGTERM → SIGKILL kill logic
 * - Session ID extraction via extractCliSessionIdFromOutput
 * - NDJSON session logging
 * - endedWithQuestion detection
 * - Duration tracking
 * - Display command building
 * - Exit code to success/error mapping
 *
 * Subclasses implement ~3 abstract methods and get everything else for free.
 */

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import {
  createStreamLog,
  appendStreamEvent,
  appendStderrEvent,
  endStreamLog,
  type StreamLogContext,
} from "@/lib/claude/logger";
import {
  extractCliSessionIdFromOutput,
  hasAskUserQuestion,
} from "@/lib/claude/json-parser";
import { findOversizedArg, oversizedArgMessage } from "./prompt-transport";
import {
  extraMcpScopeForProvider,
  type ExtraMcpScope,
} from "./extra-mcp-scope";
import type {
  AgentProvider,
  ProviderResult,
  ProviderSession,
  ProviderSpawnOptions,
  ProviderType,
} from "./types";

export interface BaseProviderChunkCallbacks {
  onRawChunk?: (chunk: {
    source: "stdout" | "stderr";
    index: number;
    text: string;
    emittedAt: string;
  }) => void;
  onOutputChunk?: (chunk: { text: string; emittedAt: string }) => void;
  onResponseChunk?: (chunk: { text: string; emittedAt: string }) => void;
}

/**
 * Key under which a spawn context carries text to pipe on the child's stdin.
 * Providers that move an oversized prompt off argv (see prompt-transport.ts)
 * set it from prepareSpawn(); when it is absent stdin stays closed, which is
 * what every CLI Arij drives expects in print mode.
 */
export const STDIN_PAYLOAD_KEY = "stdinPayload";

/**
 * Mutable per-spawn state created by prepareSpawn() and threaded through
 * buildArgs/extractResult/handleExit/cleanupSpawnContext. Providers that
 * need pre-spawn resources (e.g. Codex's temp -o file) store them here so
 * concurrent spawns on the same provider instance never share state.
 */
export type ProviderSpawnContext = Record<string, unknown>;

/**
 * Everything handleExit() needs to turn a finished process into a
 * ProviderResult.
 */
export interface ProviderExitInfo {
  code: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  killed: boolean;
  options: ProviderSpawnOptions;
  spawnContext?: ProviderSpawnContext;
}

/**
 * Whether the child is still running.
 *
 * NOT `child.killed`, which only reports that a signal was successfully
 * delivered — it flips to true the instant `kill()` returns and says nothing
 * about whether the process died. A process still holds the CPU until one of
 * `exitCode` / `signalCode` is set.
 */
function isChildAlive(child: ChildProcess): boolean {
  // Only an explicitly-set exit field proves death. Anything else — including
  // a handle that does not report these at all — is treated as alive, because
  // on a kill path a redundant signal costs nothing and a skipped one leaves
  // an agent running loose.
  const exited = child.exitCode !== null && child.exitCode !== undefined;
  const signalled = child.signalCode !== null && child.signalCode !== undefined;
  return !exited && !signalled;
}

/**
 * Signals the child's whole process GROUP, falling back to the child alone.
 *
 * A CLI agent is a tree, not a process: it spawns shells, test runners and
 * dev servers of its own. Signalling only the process at the head leaves that
 * tree running, re-parented to init and invisible to Arij — the concrete
 * symptom being a dev server still bound to a port hours after the session
 * that started it was cancelled.
 *
 * `-pid` addresses the group, which exists because the spawn is `detached`.
 * ESRCH simply means everything is already gone.
 */
function signalChild(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already reaped — nothing left to signal.
    }
  }
}

/**
 * Abstract base class for CLI agent providers.
 *
 * Subclasses must implement:
 * - `binaryName` — the CLI binary to spawn (e.g. "claude", "codex")
 * - `buildArgs(options, spawnContext?)` — construct CLI arguments from spawn options
 * - `extractResult(stdout, stderr, spawnContext?)` — extract the agent's final text from output
 *
 * Subclasses may override:
 * - `prepareSpawn(options)` — create per-spawn state before args are built (temp files, …)
 * - `beforeSpawn(args, cwd, spawnContext)` — hook right before the process starts (debug logging, …)
 * - `parseSessionId(stdout, stderr, fallback)` — custom session ID extraction
 * - `isAvailable()` — custom availability check (default: `which <binaryName>`)
 * - `buildEnv(options)` — custom environment variables
 * - `buildChunkCallbacks(options)` — map ProviderSpawnOptions.onChunk to raw/output/response callbacks
 * - `buildSpawnErrorMessage(err)` — message when the process cannot be spawned (ENOENT, …)
 * - `buildExitError(code, stdout, stderr)` — error detection/mapping for non-zero exits
 * - `emitFinalChunks(result, callbacks, spawnContext)` — final output/response chunk emission
 * - `cleanupSpawnContext(spawnContext)` — release per-spawn resources (temp files, …)
 * - `stdinPayload(spawnContext)` — text to pipe on stdin (default: none)
 * - `handleExit(info, callbacks, logCtx)` — custom exit handling for providers that need
 *   full control over how collected output becomes a ProviderResult
 * - `handlePrefix` / `logPrefix` — prefixes for session handles and NDJSON log names
 */
export abstract class BaseCliProvider implements AgentProvider {
  abstract readonly type: ProviderType;

  /**
   * Which scopes of user-declared MCP servers this CLI honors. Derived from
   * the one map in extra-mcp-scope.ts rather than restated per subclass, so a
   * new provider cannot forget to declare it and the resolution path
   * (lib/mcp/servers.ts) can read the same answer without instantiating any
   * provider.
   */
  get extraMcpScope(): ExtraMcpScope {
    return extraMcpScopeForProvider(this.type);
  }

  /** The CLI binary name (e.g. "claude", "codex", "gemini"). */
  abstract get binaryName(): string;

  /** Prefix for ProviderSession.handle (default: the provider type). */
  protected get handlePrefix(): string {
    return this.type;
  }

  /** Prefix for NDJSON stream-log identifiers (default: the provider type). */
  protected get logPrefix(): string {
    return this.type;
  }

  /**
   * Create per-spawn state before args are built (e.g. temp file paths).
   * The returned object is passed to buildArgs, extractResult, handleExit
   * and cleanupSpawnContext. Default: no per-spawn state.
   */
  protected prepareSpawn(
    _options: ProviderSpawnOptions,
  ): ProviderSpawnContext | undefined {
    return undefined;
  }

  /** Build CLI arguments from spawn options. */
  abstract buildArgs(
    options: ProviderSpawnOptions,
    spawnContext?: ProviderSpawnContext,
  ): string[];

  /**
   * Called right before the child process is spawned. Default: no-op.
   * Providers can use this for debug logging of the final command.
   */
  protected beforeSpawn(
    _args: string[],
    _cwd: string,
    _spawnContext?: ProviderSpawnContext,
  ): void {}

  /** Extract the agent's final result text from stdout/stderr. */
  abstract extractResult(
    stdout: string,
    stderr: string,
    spawnContext?: ProviderSpawnContext,
  ): string;

  /**
   * Extract a CLI session ID from output. Override for providers with
   * non-standard session ID formats. Default uses extractCliSessionIdFromOutput.
   */
  parseSessionId(
    stdout: string,
    stderr: string,
    fallbackId?: string,
  ): string | undefined {
    return (
      extractCliSessionIdFromOutput(stdout) ??
      extractCliSessionIdFromOutput(stderr) ??
      fallbackId ??
      undefined
    );
  }

  /**
   * Build environment variables for the spawned process.
   * Default: inherits process.env. Receives the spawn options because for
   * some providers the environment is the only per-spawn injection surface
   * (oh-my-pi's MCP wiring rides entirely on env vars).
   */
  buildEnv(_options: ProviderSpawnOptions): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  /**
   * Build chunk callbacks that map raw/output/response chunks to
   * the unified ProviderChunk callback. Subclasses can override for
   * providers with different streaming behavior.
   */
  buildChunkCallbacks(options: ProviderSpawnOptions): BaseProviderChunkCallbacks {
    const { onChunk } = options;
    if (!onChunk) return {};

    return {
      onRawChunk: ({ source, index, text, emittedAt }) =>
        onChunk({
          streamType: "raw",
          text,
          chunkKey: `${source}:${index}`,
          emittedAt,
        }),
      onOutputChunk: ({ text, emittedAt }) =>
        onChunk({
          streamType: "output",
          text,
          chunkKey: "final-output",
          emittedAt,
        }),
      onResponseChunk: ({ text, emittedAt }) =>
        onChunk({
          streamType: "response",
          text,
          chunkKey: "final-response",
          emittedAt,
        }),
    };
  }

  /**
   * Build a display command string (with prompt redacted).
   * Override for providers with different prompt argument patterns.
   */
  buildDisplayCommand(
    args: string[],
    prompt: string,
  ): string {
    const displayArgs = args.map((a, i) => {
      if (i > 0 && (args[i - 1] === "-p" || args[i - 1] === "--prompt")) {
        return "<prompt>";
      }
      if (a === prompt && a.length > 50) return "<prompt>";
      return a;
    });
    return `${this.binaryName} ${displayArgs.join(" ")}`;
  }

  /**
   * Detect whether the agent ended by asking a question.
   * Default checks all output sources via hasAskUserQuestion.
   */
  detectEndedWithQuestion(stdout: string, stderr: string, result: string): boolean {
    return (
      hasAskUserQuestion(stdout) ||
      hasAskUserQuestion(stderr) ||
      hasAskUserQuestion(result)
    );
  }

  /**
   * Check if the CLI is available. Default: `which <binaryName>`.
   * Override for providers that need additional checks (e.g. login status).
   */
  async isAvailable(): Promise<boolean> {
    try {
      execSync(`which ${this.binaryName}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the error message used when the process could not be spawned at
   * all (the child "error" event, e.g. ENOENT when the binary is missing).
   */
  protected buildSpawnErrorMessage(err: Error): string {
    return err.message.includes("ENOENT")
      ? `${this.binaryName} CLI not found. Ensure \`${this.binaryName}\` is installed and available in PATH.`
      : `Failed to spawn ${this.binaryName} CLI: ${err.message}`;
  }

  /**
   * Build the error message for a non-zero exit code. Providers with
   * recognizable failure modes (auth, network, …) override this to map
   * the collected output to actionable messages.
   */
  protected buildExitError(
    code: number | null,
    stdout: string,
    stderr: string,
  ): string {
    return stderr.trim() || `${this.binaryName} CLI exited with code ${code}`;
  }

  /**
   * Emit the final output/response chunks once the process has exited.
   * Default: both chunks carry the extracted result.
   */
  protected emitFinalChunks(
    result: string,
    callbacks: BaseProviderChunkCallbacks,
    _spawnContext?: ProviderSpawnContext,
  ): void {
    if (result) {
      const emittedAt = new Date().toISOString();
      callbacks.onOutputChunk?.({ text: result, emittedAt });
      callbacks.onResponseChunk?.({ text: result, emittedAt });
    }
  }

  /**
   * Release per-spawn resources (temp files, …). Called after the process
   * exits and when the spawn itself fails. Default: nothing to clean up.
   */
  protected cleanupSpawnContext(_spawnContext?: ProviderSpawnContext): void {}

  /**
   * Text to pipe on the child's stdin, or null to leave stdin closed.
   * Default: whatever prepareSpawn() stored under STDIN_PAYLOAD_KEY.
   */
  protected stdinPayload(spawnContext?: ProviderSpawnContext): string | null {
    const payload = spawnContext?.[STDIN_PAYLOAD_KEY];
    return typeof payload === "string" ? payload : null;
  }

  /**
   * Turn a finished process into a ProviderResult. This is the exit hook:
   * most providers customize behavior by overriding the narrower
   * extractResult/buildExitError/emitFinalChunks hooks that this default
   * implementation calls; providers that need full control (custom result
   * assembly, extra debug output) can override handleExit itself.
   */
  protected handleExit(
    info: ProviderExitInfo,
    callbacks: BaseProviderChunkCallbacks,
    logCtx: StreamLogContext | null,
  ): ProviderResult {
    const { code, stdout, stderr, duration, killed, options, spawnContext } = info;
    const result = this.extractResult(stdout, stderr, spawnContext);
    const parsedCliSessionId = this.parseSessionId(
      stdout,
      stderr,
      options.cliSessionId,
    );
    const endedWithQuestion = this.detectEndedWithQuestion(
      stdout,
      stderr,
      result,
    );

    // Emit final output/response chunks
    this.emitFinalChunks(result, callbacks, spawnContext);

    // Log session end
    if (logCtx) {
      try {
        if (result) appendStreamEvent(logCtx, result);
        endStreamLog(logCtx, {
          exitCode: code,
          error: code !== 0 ? stderr.slice(0, 500) : undefined,
        });
      } catch {
        /* best-effort */
      }
    }

    if (killed) {
      return {
        success: false,
        error: "Process was cancelled.",
        duration,
      };
    }

    if (code !== 0) {
      return {
        success: false,
        error: this.buildExitError(code, stdout, stderr),
        result: result || undefined,
        duration,
        cliSessionId: parsedCliSessionId,
        endedWithQuestion,
      };
    }

    return {
      success: true,
      result: result || stdout.trim(),
      duration,
      cliSessionId: parsedCliSessionId,
      endedWithQuestion,
    };
  }

  /**
   * Spawn the CLI process. This is the core method that orchestrates
   * the entire lifecycle. Most subclasses should NOT override this.
   */
  spawn(options: ProviderSpawnOptions): ProviderSession {
    const { sessionId, prompt, cwd, logIdentifier } = options;
    const effectiveCwd = cwd || process.cwd();
    const spawnContext = this.prepareSpawn(options);
    const args = this.buildArgs(options, spawnContext);
    const callbacks = this.buildChunkCallbacks(options);
    const stdinPayload = this.stdinPayload(spawnContext);

    // execve() would fail with a bare `spawn E2BIG` here — a provider that
    // cannot move the prompt off argv says why instead.
    const oversized = findOversizedArg(args);
    if (oversized) {
      this.cleanupSpawnContext(spawnContext);
      return {
        handle: `${this.handlePrefix}-${sessionId}`,
        kill: () => {},
        promise: Promise.resolve({
          success: false,
          error: oversizedArgMessage(
            this.binaryName,
            Buffer.byteLength(oversized, "utf8"),
          ),
          duration: 0,
        }),
        command: this.buildDisplayCommand(args, prompt),
      };
    }

    // Optional NDJSON logging
    let logCtx: StreamLogContext | null = null;
    if (logIdentifier) {
      try {
        logCtx = createStreamLog(
          `${this.logPrefix}-${logIdentifier}`,
          [this.binaryName, ...args],
          prompt,
        );
      } catch {
        // logging is best-effort
      }
    }

    let child: ChildProcess | null = null;
    let killed = false;

    const promise = new Promise<ProviderResult>((resolve) => {
      const startTime = Date.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutChunkIndex = 0;
      let stderrChunkIndex = 0;

      this.beforeSpawn(args, effectiveCwd, spawnContext);

      child = nodeSpawn(this.binaryName, args, {
        cwd: effectiveCwd,
        env: this.buildEnv(options),
        stdio: [stdinPayload === null ? "ignore" : "pipe", "pipe", "pipe"],
        // Own process group, so cancelling reaches the whole agent and not
        // just the CLI at its head — see signalChild. Safe here because stdio
        // is fully piped and nothing about these background agents wants the
        // server's terminal signals.
        detached: true,
      });

      if (stdinPayload !== null) {
        // EPIPE if the CLI exits before draining the prompt — that path is
        // already reported through the exit code, so swallow it here.
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdinPayload);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        stdoutChunkIndex += 1;
        const text = chunk.toString("utf-8");
        callbacks.onRawChunk?.({
          source: "stdout",
          index: stdoutChunkIndex,
          text,
          emittedAt: new Date().toISOString(),
        });
        if (logCtx) {
          try {
            appendStreamEvent(logCtx, text);
          } catch {
            /* best-effort */
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        stderrChunkIndex += 1;
        const text = chunk.toString("utf-8");
        callbacks.onRawChunk?.({
          source: "stderr",
          index: stderrChunkIndex,
          text,
          emittedAt: new Date().toISOString(),
        });
        if (logCtx) {
          try {
            appendStderrEvent(logCtx, text);
          } catch {
            /* best-effort */
          }
        }
      });

      child.on("error", (err) => {
        const duration = Date.now() - startTime;
        this.cleanupSpawnContext(spawnContext);
        const errorMsg = this.buildSpawnErrorMessage(err);

        if (logCtx) {
          try {
            endStreamLog(logCtx, { exitCode: null, error: errorMsg });
          } catch {
            /* best-effort */
          }
        }

        resolve({
          success: false,
          error: errorMsg,
          duration,
        });
      });

      child.on("close", (code) => {
        const duration = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");

        try {
          const providerResult = this.handleExit(
            { code, stdout, stderr, duration, killed, options, spawnContext },
            callbacks,
            logCtx,
          );
          resolve(providerResult);
        } finally {
          this.cleanupSpawnContext(spawnContext);
        }
      });
    });

    const kill = () => {
      if (!child || !isChildAlive(child)) return;
      killed = true;
      signalChild(child, "SIGTERM");

      // Force kill whatever is still standing 5s later. The guard reads the
      // exit fields, NOT `child.killed`: Node sets `killed` as soon as a
      // signal has been *delivered*, so `!child.killed` is already false here
      // and the escalation this timer exists for could never fire. An agent
      // that ignored or outran SIGTERM therefore survived its own
      // cancellation — which is how a session marked `cancelled` in the
      // database kept writing to a worktree that a live session had meanwhile
      // been handed.
      setTimeout(() => {
        if (child && isChildAlive(child)) {
          signalChild(child, "SIGKILL");
        }
      }, 5000);
    };

    // The prompt is not in argv when it rides stdin — show the redirection so
    // the command in the UI still accounts for it.
    const display = this.buildDisplayCommand(args, prompt);
    const command = stdinPayload === null ? display : `${display} < <prompt>`;

    return {
      handle: `${this.handlePrefix}-${sessionId}`,
      kill,
      promise,
      command,
    };
  }

  cancel(session: ProviderSession): boolean {
    session.kill();
    return true;
  }
}
