import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import {
  cleanupMcpConfigFile,
  writeMcpConfigFile,
} from "@/lib/claude/mcp-injection";
import type { QuestionData, StreamChunk } from "@/lib/claude/spawn";
import { createChatCliToolChannel } from "@/lib/chat/cli-tool-channel";
import type { PersistentChatProvider } from "@/lib/agent-config/constants";
import {
  buildOmpSpawnEnv,
  OMP_READONLY_TOOLS,
  ompReadonlyOverlayPath,
} from "@/lib/providers/oh-my-pi";

export const DEFAULT_PERSISTENT_CHAT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_WARM_CHAT_CONVERSATIONS = 3;
/**
 * Deadline on a *silent* turn: how long an in-flight turn may go without any
 * frame from the CLI before Arij declares it wedged. Distinct from the idle
 * timeout, which only reclaims processes between turns. Without this, a CLI
 * that never emits its terminal frame pins its warm slot and its MCP token
 * forever, because the idle reaper refuses to touch a process with an
 * `activeTurn`.
 */
export const DEFAULT_PERSISTENT_CHAT_TURN_STALL_MS = 5 * 60 * 1000;

interface PersistentRunnerGlobalState {
  processes: Map<string, PersistentProcess>;
}

const GLOBAL_STATE_KEY = Symbol.for("arij.chat.persistent-runner");

function globalState(): PersistentRunnerGlobalState {
  const root = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: PersistentRunnerGlobalState;
  };
  root[GLOBAL_STATE_KEY] ??= { processes: new Map() };
  return root[GLOBAL_STATE_KEY];
}

export type PersistentSessionState = "hot" | "cold";

export interface PersistentChatTurnOptions {
  conversationId: string;
  projectId: string;
  provider: PersistentChatProvider;
  prompt: string;
  cwd: string;
  mode: "plan" | "chat";
  model?: string;
  cliSessionId?: string;
  resumeSession?: boolean;
  conversationType: string | null;
  idleTimeoutMs?: number;
  maxWarmConversations?: number;
  turnStallTimeoutMs?: number;
  onChunk: (chunk: StreamChunk) => void;
  onCliSessionId?: (cliSessionId: string) => void;
}

export interface PersistentChatTurnHandle {
  /** Whether this turn reused an already-running process. */
  wasWarm: boolean;
  promise: Promise<void>;
  /** Cancels the turn by restarting the whole embedded CLI process. */
  kill: () => void;
}

interface ActiveTurn {
  onChunk: (chunk: StreamChunk) => void;
  onCliSessionId?: (cliSessionId: string) => void;
  resolve: () => void;
  reject: (error: Error) => void;
  textDeltasEmitted: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
  requestId?: string;
  fallbackText?: string;
  errorMessage?: string;
}

interface PersistentProcess {
  conversationId: string;
  provider: PersistentChatProvider;
  displayName: string;
  child: ChildProcess;
  channel: ReturnType<typeof createChatCliToolChannel>;
  mcpConfigPath: string | null;
  lastUsedAt: number;
  idleTimeoutMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  turnStallMs: number;
  activeTurn: ActiveTurn | null;
  stdoutBuffer: string;
  stderrTail: string;
  closing: boolean;
  maxFrameBytes?: number;
  discoveredCliSessionId?: string;
  ready: Promise<void>;
  send: (
    prompt: string,
    onChunk: (chunk: StreamChunk) => void,
    onCliSessionId?: (cliSessionId: string) => void,
  ) => Promise<void>;
  terminate: (reason: string) => void;
}

function normalizedIdleTimeout(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value!)
    : DEFAULT_PERSISTENT_CHAT_IDLE_TIMEOUT_MS;
}

function normalizedTurnStall(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value!)
    : DEFAULT_PERSISTENT_CHAT_TURN_STALL_MS;
}

function normalizedWarmCap(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value!)
    : DEFAULT_MAX_WARM_CHAT_CONVERSATIONS;
}

function claudeInputMessage(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    parent_tool_use_id: null,
  })}\n`;
}

function claudeArgs(
  options: PersistentChatTurnOptions,
  mcpConfigPath: string | null,
  allowedToolNames: string[],
): string[] {
  const permissionMode = options.mode === "plan" ? "plan" : "default";
  const allowedTools = options.mode === "chat" ? ["Read", "Glob", "Grep"] : [];
  const args = [
    "--permission-mode",
    permissionMode,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];

  if (options.cliSessionId && options.resumeSession) {
    args.push("--resume", options.cliSessionId);
  } else if (options.cliSessionId) {
    args.push("--session-id", options.cliSessionId);
  }
  if (options.model) args.push("--model", options.model);
  if (mcpConfigPath && options.provider === "claude-code-persistent") {
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }

  if (allowedTools.length > 0 || allowedToolNames.length > 0) {
    args.push("--allowedTools", ...allowedTools, ...allowedToolNames);
  }
  return args;
}

function eventText(event: Record<string, unknown>): string | null {
  const nested =
    event.type === "stream_event" && event.event && typeof event.event === "object"
      ? (event.event as Record<string, unknown>)
      : event;
  if (nested.type !== "content_block_delta") return null;
  const delta = nested.delta;
  if (!delta || typeof delta !== "object") return null;
  const typed = delta as { type?: unknown; text?: unknown };
  return typed.type === "text_delta" && typeof typed.text === "string"
    ? typed.text
    : null;
}

function eventQuestions(event: Record<string, unknown>): QuestionData[] | null {
  if (event.type !== "assistant") return null;
  const message = event.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as {
      type?: unknown;
      name?: unknown;
      input?: { questions?: unknown };
    };
    if (
      typed.type === "tool_use" &&
      typed.name === "AskUserQuestion" &&
      Array.isArray(typed.input?.questions)
    ) {
      return typed.input.questions as QuestionData[];
    }
  }
  return null;
}

function resultFallbackText(event: Record<string, unknown>): string {
  return typeof event.result === "string" ? event.result : "";
}

function resultError(event: Record<string, unknown>): string | null {
  if (event.type !== "result") return null;
  if (event.is_error !== true && event.subtype !== "error_during_execution") {
    return null;
  }
  if (Array.isArray(event.errors)) {
    const joined = event.errors.filter((item) => typeof item === "string").join("; ");
    if (joined) return joined;
  }
  return resultFallbackText(event) || "Claude Code turn failed";
}

function processClaudeEvent(process: PersistentProcess, raw: string): void {
  if (!raw.trim()) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const sessionId =
    typeof event.session_id === "string" ? event.session_id : undefined;
  if (sessionId) {
    process.discoveredCliSessionId = sessionId;
    process.activeTurn?.onCliSessionId?.(sessionId);
  }

  const turn = process.activeTurn;
  if (!turn) return;
  noteTurnProgress(process);

  const text = eventText(event);
  if (text) {
    turn.textDeltasEmitted = true;
    turn.onChunk({ type: "text", text });
    return;
  }

  const questions = eventQuestions(event);
  if (questions) {
    turn.onChunk({ type: "questions", questions });
    return;
  }

  const nested =
    event.type === "stream_event" && event.event && typeof event.event === "object"
      ? (event.event as Record<string, unknown>)
      : event;
  if (nested.type === "content_block_start") {
    const contentBlock = nested.content_block;
    if (contentBlock && typeof contentBlock === "object") {
      const block = contentBlock as { type?: unknown; name?: unknown };
      if (block.type === "tool_use") {
        turn.onChunk({
          type: "status",
          status: `Using ${typeof block.name === "string" ? block.name : "tool"}...`,
        });
      } else if (block.type === "thinking") {
        turn.onChunk({ type: "status", status: "Thinking..." });
      }
    }
  }

  if (event.type !== "result") return;
  const error = resultError(event);
  if (error) {
    finishTurn(process, new Error(error));
    return;
  }
  if (!turn.textDeltasEmitted) {
    const fallback = resultFallbackText(event);
    if (fallback) turn.onChunk({ type: "text", text: fallback });
  }
  finishTurn(process);
}

function clearStallTimer(turn: ActiveTurn | null): void {
  if (!turn?.stallTimer) return;
  clearTimeout(turn.stallTimer);
  turn.stallTimer = null;
}

function finishTurn(process: PersistentProcess, error?: Error): void {
  const turn = process.activeTurn;
  if (!turn) return;
  clearStallTimer(turn);
  process.activeTurn = null;
  process.lastUsedAt = Date.now();
  scheduleIdleReap(process);
  if (error) turn.reject(error);
  else turn.resolve();
}

function formatStallDelay(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * (Re)arms the silent-turn deadline. Called when a turn starts and again on
 * every frame the CLI sends for it, so a slow-but-talking turn is never cut
 * off — only a turn that has gone completely quiet.
 */
function armTurnStallWatchdog(process: PersistentProcess): void {
  const turn = process.activeTurn;
  if (!turn) return;
  clearStallTimer(turn);
  turn.stallTimer = setTimeout(() => {
    finishTurn(
      process,
      new Error(
        `${process.displayName} sent nothing for ${formatStallDelay(process.turnStallMs)} ` +
          "and the turn never completed. The persistent session was restarted; " +
          "send your message again.",
      ),
    );
    // The CLI is wedged, not merely slow: drop the process so its warm slot
    // and MCP token return to the pool instead of being pinned forever.
    process.terminate("turn stalled");
  }, process.turnStallMs);
  turn.stallTimer.unref?.();
}

/** Any frame for the active turn counts as progress against the deadline. */
function noteTurnProgress(process: PersistentProcess): void {
  if (process.activeTurn) armTurnStallWatchdog(process);
}

function scheduleIdleReap(process: PersistentProcess): void {
  if (process.idleTimer) clearTimeout(process.idleTimer);
  process.idleTimer = setTimeout(() => {
    if (!process.activeTurn) process.terminate("idle timeout");
  }, process.idleTimeoutMs);
  process.idleTimer.unref?.();
}

function removeProcess(process: PersistentProcess): void {
  const processes = globalState().processes;
  if (processes.get(process.conversationId) === process) {
    processes.delete(process.conversationId);
  }
}

function cleanupProcess(process: PersistentProcess, error?: Error): void {
  if (process.idleTimer) clearTimeout(process.idleTimer);
  process.idleTimer = null;
  cleanupMcpConfigFile(process.mcpConfigPath);
  process.channel?.release();
  removeProcess(process);
  if (process.activeTurn) {
    const turn = process.activeTurn;
    clearStallTimer(turn);
    process.activeTurn = null;
    const failure =
      error ??
      new Error(
        process.stderrTail.trim() ||
          `Persistent ${process.displayName} process stopped unexpectedly`,
      );
    turn.reject(failure);
  }
}

function spawnClaudeProcess(options: PersistentChatTurnOptions): PersistentProcess {
  const channel = createChatCliToolChannel({
    projectId: options.projectId,
    provider: "claude-code",
    conversationType: options.conversationType,
  });
  let mcpConfigPath: string | null = null;
  let allowedToolNames: string[] = [];
  if (channel) {
    allowedToolNames = channel.mcp.allowedToolNames;
    try {
      mcpConfigPath = writeMcpConfigFile(channel.mcp);
    } catch (error) {
      allowedToolNames = [];
      console.warn(
        "[persistent-chat] MCP config write failed; continuing without board tools:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  const args = claudeArgs(options, mcpConfigPath, allowedToolNames);
  const child = nodeSpawn("claude", args, {
    cwd: options.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => {});

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // `send()` awaits `ready` and surfaces a spawn failure to the caller, but a
  // turn cancelled between spawn and the first `send()` never awaits it. Keep
  // a permanent no-op handler so a late `error` event cannot become an
  // unhandled rejection (fatal in Node outside dev).
  void ready.catch(() => {});

  const persistent: PersistentProcess = {
    conversationId: options.conversationId,
    provider: options.provider,
    displayName: "Claude Code",
    child,
    channel,
    mcpConfigPath,
    lastUsedAt: Date.now(),
    idleTimeoutMs: normalizedIdleTimeout(options.idleTimeoutMs),
    idleTimer: null,
    turnStallMs: normalizedTurnStall(options.turnStallTimeoutMs),
    activeTurn: null,
    stdoutBuffer: "",
    stderrTail: "",
    closing: false,
    maxFrameBytes: undefined,
    discoveredCliSessionId: options.cliSessionId,
    ready,
    async send(prompt, onChunk, onCliSessionId) {
      await ready;
      if (persistent.closing || !persistent.child.stdin?.writable) {
        throw new Error("Persistent Claude Code process is not writable");
      }
      if (persistent.activeTurn) {
        throw new Error("This conversation already has a turn in progress");
      }
      if (persistent.idleTimer) clearTimeout(persistent.idleTimer);
      persistent.idleTimer = null;
      await new Promise<void>((resolve, reject) => {
        persistent.activeTurn = {
          onChunk,
          onCliSessionId,
          resolve,
          reject,
          textDeltasEmitted: false,
          stallTimer: null,
        };
        armTurnStallWatchdog(persistent);
        persistent.child.stdin!.write(claudeInputMessage(prompt), (error) => {
          if (error) finishTurn(persistent, error);
        });
      });
    },
    terminate(reason) {
      if (persistent.closing) return;
      persistent.closing = true;
      removeProcess(persistent);
      if (persistent.idleTimer) clearTimeout(persistent.idleTimer);
      persistent.idleTimer = null;
      if (persistent.activeTurn) {
        const turn = persistent.activeTurn;
        clearStallTimer(turn);
        persistent.activeTurn = null;
        turn.reject(new Error(`Persistent chat session stopped: ${reason}`));
      }
      if (!child.killed) child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        // Defensive cleanup for broken child-process implementations that do
        // not emit close after kill; release remains idempotent.
        cleanupProcess(persistent);
      }, 5000);
      forceTimer.unref?.();
    },
  };

  child.once("spawn", resolveReady);
  child.stdout?.on("data", (chunk: Buffer) => {
    persistent.stdoutBuffer += chunk.toString("utf-8");
    const lines = persistent.stdoutBuffer.split("\n");
    persistent.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) processClaudeEvent(persistent, line);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    persistent.stderrTail = `${persistent.stderrTail}${chunk.toString("utf-8")}`.slice(-4000);
  });
  child.once("error", (error) => {
    const spawnError = new Error(
      error.message.includes("ENOENT")
        ? "Claude CLI not found. Ensure `claude` is installed and available in PATH."
        : `Failed to spawn Claude CLI: ${error.message}`,
    );
    rejectReady(spawnError);
    cleanupProcess(
      persistent,
      spawnError,
    );
  });
  child.once("close", () => {
    if (persistent.stdoutBuffer.trim()) {
      processClaudeEvent(persistent, persistent.stdoutBuffer);
      persistent.stdoutBuffer = "";
    }
    cleanupProcess(persistent);
  });
  scheduleIdleReap(persistent);
  return persistent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOmpTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function processOmpEvent(process: PersistentProcess, raw: string): void {
  if (!raw.trim()) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "response" && event.command === "get_state") {
    const data = event.data;
    if (isRecord(data) && typeof data.sessionId === "string") {
      process.discoveredCliSessionId = data.sessionId;
      process.activeTurn?.onCliSessionId?.(data.sessionId);
    }
    return;
  }

  const turn = process.activeTurn;
  if (!turn) return;
  noteTurnProgress(process);

  if (
    event.type === "response" &&
    event.command === "prompt" &&
    (!event.id || event.id === turn.requestId)
  ) {
    if (event.success === false) {
      finishTurn(
        process,
        new Error(
          typeof event.error === "string"
            ? event.error
            : "Oh My Pi rejected the prompt",
        ),
      );
      return;
    }
    // Acceptance is not completion: the run normally ends on `agent_end`.
    // The one exception is a prompt OMP handled locally (a slash command that
    // never starts an agent turn), which reports `agentInvoked: false` here or
    // in a later `prompt_result` and emits no agent lifecycle events at all.
    if (isRecord(event.data) && event.data.agentInvoked === false) {
      finishLocalOnlyOmpTurn(process, turn);
    }
    return;
  }

  if (
    event.type === "prompt_result" &&
    event.agentInvoked === false &&
    (!event.id || event.id === turn.requestId)
  ) {
    finishLocalOnlyOmpTurn(process, turn);
    return;
  }

  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!isRecord(update)) return;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      turn.textDeltasEmitted = true;
      turn.onChunk({ type: "text", text: update.delta });
    } else if (update.type === "thinking_start") {
      turn.onChunk({ type: "status", status: "Thinking..." });
    }
    return;
  }

  if (event.type === "tool_execution_start") {
    turn.onChunk({
      type: "status",
      status: `Using ${typeof event.toolName === "string" ? event.toolName : "tool"}...`,
    });
    return;
  }

  if (event.type === "auto_retry_end" && event.success === false) {
    turn.errorMessage =
      typeof event.finalError === "string"
        ? event.finalError
        : "Oh My Pi exhausted its automatic retries.";
    return;
  }

  if (event.type === "message_end" && isRecord(event.message)) {
    const message = event.message;
    if (message.role !== "assistant") return;
    turn.fallbackText = readOmpTextBlocks(message.content);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      turn.errorMessage =
        typeof message.errorMessage === "string"
          ? message.errorMessage
          : message.stopReason === "aborted"
            ? "Oh My Pi run was aborted."
            : "Oh My Pi run ended with an error.";
    }
    return;
  }

  // End of run. OMP's own RPC reference is explicit: "agent turns complete
  // only on `agent_end` frames where `isTerminal !== false`". A non-terminal
  // `agent_end` means maintenance or async delivery scheduled more work and
  // the session will resume, so it must not close the turn. `willContinue` is
  // the pre-mapping spelling of the same fact on some frames; treat either as
  // "more is coming".
  if (event.type !== "agent_end") return;
  if (event.isTerminal === false || event.willContinue === true) return;
  if (turn.errorMessage) {
    finishTurn(process, new Error(turn.errorMessage));
    return;
  }
  if (!turn.textDeltasEmitted && turn.fallbackText) {
    turn.onChunk({ type: "text", text: turn.fallbackText });
  }
  finishTurn(process);
}

/**
 * Completes a turn OMP resolved without invoking the agent. No assistant
 * message exists in that case, so the accumulated `message_end` text (if any)
 * is the only thing worth flushing.
 */
function finishLocalOnlyOmpTurn(
  process: PersistentProcess,
  turn: ActiveTurn,
): void {
  if (turn.errorMessage) {
    finishTurn(process, new Error(turn.errorMessage));
    return;
  }
  if (!turn.textDeltasEmitted && turn.fallbackText) {
    turn.onChunk({ type: "text", text: turn.fallbackText });
  }
  finishTurn(process);
}

function ompArgs(options: PersistentChatTurnOptions): string[] {
  const args = [
    "--mode",
    "rpc",
    "--tools",
    OMP_READONLY_TOOLS.join(","),
    "--config",
    ompReadonlyOverlayPath(),
    "--no-title",
  ];
  if (options.cliSessionId && options.resumeSession) {
    args.push("--resume", options.cliSessionId);
  }
  if (options.model) args.push("--model", options.model);
  return args;
}

function spawnOmpProcess(options: PersistentChatTurnOptions): PersistentProcess {
  const channel = createChatCliToolChannel({
    projectId: options.projectId,
    provider: "oh-my-pi",
    conversationType: options.conversationType,
  });
  const child = nodeSpawn("omp", ompArgs(options), {
    cwd: options.cwd,
    env: buildOmpSpawnEnv(process.env, channel?.mcp),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => {});

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // `send()` awaits `ready` and surfaces a spawn failure to the caller, but a
  // turn cancelled between spawn and the first `send()` never awaits it. Keep
  // a permanent no-op handler so a late `error` event cannot become an
  // unhandled rejection (fatal in Node outside dev).
  void ready.catch(() => {});

  const persistent: PersistentProcess = {
    conversationId: options.conversationId,
    provider: options.provider,
    displayName: "Oh My Pi",
    child,
    channel,
    mcpConfigPath: null,
    lastUsedAt: Date.now(),
    idleTimeoutMs: normalizedIdleTimeout(options.idleTimeoutMs),
    idleTimer: null,
    turnStallMs: normalizedTurnStall(options.turnStallTimeoutMs),
    activeTurn: null,
    stdoutBuffer: "",
    stderrTail: "",
    closing: false,
    maxFrameBytes: undefined,
    discoveredCliSessionId: options.cliSessionId,
    ready,
    async send(prompt, onChunk, onCliSessionId) {
      await ready;
      if (persistent.closing || !persistent.child.stdin?.writable) {
        throw new Error("Persistent Oh My Pi process is not writable");
      }
      if (persistent.activeTurn) {
        throw new Error("This conversation already has a turn in progress");
      }
      const requestId = crypto.randomUUID();
      const frame = `${JSON.stringify({
        id: requestId,
        type: "prompt",
        message: prompt,
      })}\n`;
      if (
        persistent.maxFrameBytes &&
        Buffer.byteLength(frame) > persistent.maxFrameBytes
      ) {
        throw new Error(
          `Oh My Pi RPC prompt exceeds the ${persistent.maxFrameBytes}-byte frame limit`,
        );
      }
      if (persistent.idleTimer) clearTimeout(persistent.idleTimer);
      persistent.idleTimer = null;
      await new Promise<void>((resolve, reject) => {
        persistent.activeTurn = {
          onChunk,
          onCliSessionId,
          resolve,
          reject,
          textDeltasEmitted: false,
          stallTimer: null,
          requestId,
        };
        armTurnStallWatchdog(persistent);
        if (persistent.discoveredCliSessionId) {
          onCliSessionId?.(persistent.discoveredCliSessionId);
        }
        persistent.child.stdin!.write(frame, (error) => {
          if (error) finishTurn(persistent, error);
        });
      });
    },
    terminate(reason) {
      if (persistent.closing) return;
      persistent.closing = true;
      removeProcess(persistent);
      if (persistent.idleTimer) clearTimeout(persistent.idleTimer);
      persistent.idleTimer = null;
      if (persistent.activeTurn) {
        const turn = persistent.activeTurn;
        clearStallTimer(turn);
        persistent.activeTurn = null;
        turn.reject(new Error(`Persistent chat session stopped: ${reason}`));
      }
      if (!child.killed) child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        cleanupProcess(persistent);
      }, 5000);
      forceTimer.unref?.();
    },
  };

  let protocolReady = false;
  const handshakeTimer = setTimeout(() => {
    if (protocolReady) return;
    const error = new Error("Oh My Pi RPC handshake timed out");
    rejectReady(error);
    cleanupProcess(persistent, error);
    persistent.terminate("RPC handshake timed out");
  }, 10_000);
  handshakeTimer.unref?.();

  child.stdout?.on("data", (chunk: Buffer) => {
    persistent.stdoutBuffer += chunk.toString("utf-8");
    const lines = persistent.stdoutBuffer.split("\n");
    persistent.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      let event: Record<string, unknown> | null = null;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // processOmpEvent deliberately ignores malformed/noisy lines too.
      }
      if (event?.type === "ready") {
        const versions = Array.isArray(event.supportedProtocolVersions)
          ? event.supportedProtocolVersions
          : [event.protocolVersion];
        if (!versions.includes(1)) {
          const error = new Error("Oh My Pi RPC protocol 1 is not supported");
          rejectReady(error);
          cleanupProcess(persistent, error);
          persistent.terminate("unsupported RPC protocol");
          continue;
        }
        protocolReady = true;
        clearTimeout(handshakeTimer);
        persistent.maxFrameBytes =
          typeof event.maxFrameBytes === "number" ? event.maxFrameBytes : 1_048_576;
        resolveReady();
        child.stdin?.write(
          `${JSON.stringify({
            id: `arij-state-${options.conversationId}`,
            type: "get_state",
          })}\n`,
        );
        continue;
      }
      processOmpEvent(persistent, line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    persistent.stderrTail = `${persistent.stderrTail}${chunk.toString("utf-8")}`.slice(-4000);
  });
  child.once("error", (error) => {
    clearTimeout(handshakeTimer);
    const spawnError = new Error(
      error.message.includes("ENOENT")
        ? "Oh My Pi CLI not found. Ensure `omp` is installed and available in PATH."
        : `Failed to spawn Oh My Pi CLI: ${error.message}`,
    );
    rejectReady(spawnError);
    cleanupProcess(persistent, spawnError);
  });
  child.once("close", () => {
    clearTimeout(handshakeTimer);
    if (!protocolReady) {
      rejectReady(
        new Error(
          persistent.stderrTail.trim() ||
            "Oh My Pi process stopped before the RPC handshake",
        ),
      );
    }
    if (persistent.stdoutBuffer.trim()) {
      processOmpEvent(persistent, persistent.stdoutBuffer);
      persistent.stdoutBuffer = "";
    }
    cleanupProcess(persistent);
  });
  scheduleIdleReap(persistent);
  return persistent;
}

function evictForCapacity(maxWarmConversations: number, exceptConversationId: string): void {
  const candidates = [...globalState().processes.values()]
    .filter(
      (process) =>
        process.conversationId !== exceptConversationId && !process.activeTurn,
    )
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  while (
    globalState().processes.size >= maxWarmConversations &&
    candidates.length > 0
  ) {
    candidates.shift()!.terminate("warm conversation limit reached");
  }
  if (globalState().processes.size >= maxWarmConversations) {
    throw new Error(
      `All ${maxWarmConversations} persistent chat sessions are busy; try again shortly.`,
    );
  }
}

function getOrSpawn(options: PersistentChatTurnOptions): PersistentProcess {
  const existing = globalState().processes.get(options.conversationId);
  if (existing && existing.provider === options.provider && !existing.closing) {
    existing.idleTimeoutMs = normalizedIdleTimeout(options.idleTimeoutMs);
    return existing;
  }
  existing?.terminate("provider changed");
  const cap = normalizedWarmCap(options.maxWarmConversations);
  evictForCapacity(cap, options.conversationId);
  const spawned =
    options.provider === "claude-code-persistent"
      ? spawnClaudeProcess(options)
      : spawnOmpProcess(options);
  globalState().processes.set(options.conversationId, spawned);
  return spawned;
}

export function runPersistentChatTurn(
  options: PersistentChatTurnOptions,
): PersistentChatTurnHandle {
  const existing = globalState().processes.get(options.conversationId);
  const wasWarm = Boolean(
    existing && existing.provider === options.provider && !existing.closing,
  );
  let process: PersistentProcess | null = null;
  let cancelled = false;
  const promise = Promise.resolve().then(async () => {
    if (cancelled) throw new Error("Persistent chat turn was cancelled");
    process = getOrSpawn(options);
    if (cancelled) {
      process.terminate("turn cancelled");
      throw new Error("Persistent chat turn was cancelled");
    }
    await process.send(options.prompt, options.onChunk, options.onCliSessionId);
  });
  // The caller (the SSE route) only attaches its handler once the response
  // body starts being read, several ticks later. A turn that fails before
  // then — a stall deadline, a spawn error — would otherwise reject with no
  // handler attached. This marks it handled without consuming it: `promise`
  // itself still rejects for whoever awaits it.
  void promise.catch(() => {});
  return {
    wasWarm,
    promise,
    kill: () => {
      cancelled = true;
      process?.terminate("turn cancelled");
    },
  };
}

export function isPersistentChatSessionWarm(conversationId: string): boolean {
  const process = globalState().processes.get(conversationId);
  return Boolean(process && !process.closing);
}

export function getPersistentChatSessionState(
  conversationId: string,
): PersistentSessionState {
  return isPersistentChatSessionWarm(conversationId) ? "hot" : "cold";
}

export function restartPersistentChatSession(conversationId: string): boolean {
  const process = globalState().processes.get(conversationId);
  if (!process) return false;
  process.terminate("restarted by user");
  return true;
}

/** Test-only cleanup. Production callers should restart one conversation. */
export function resetPersistentChatRunnerForTests(): void {
  for (const process of [...globalState().processes.values()]) {
    process.terminate("test cleanup");
  }
  globalState().processes.clear();
}
