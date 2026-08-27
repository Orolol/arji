import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import {
  cleanupMcpConfigFile,
  writeMcpConfigFile,
} from "@/lib/claude/mcp-injection";
import type { QuestionData, StreamChunk } from "@/lib/claude/spawn";
import { createChatCliToolChannel } from "@/lib/chat/cli-tool-channel";
import type { PersistentChatProvider } from "@/lib/agent-config/constants";

export const DEFAULT_PERSISTENT_CHAT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_WARM_CHAT_CONVERSATIONS = 3;

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
}

interface PersistentProcess {
  conversationId: string;
  provider: PersistentChatProvider;
  child: ChildProcess;
  channel: ReturnType<typeof createChatCliToolChannel>;
  mcpConfigPath: string | null;
  lastUsedAt: number;
  idleTimeoutMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  activeTurn: ActiveTurn | null;
  stdoutBuffer: string;
  stderrTail: string;
  closing: boolean;
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
  if (sessionId) process.activeTurn?.onCliSessionId?.(sessionId);

  const turn = process.activeTurn;
  if (!turn) return;

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

function finishTurn(process: PersistentProcess, error?: Error): void {
  const turn = process.activeTurn;
  if (!turn) return;
  process.activeTurn = null;
  process.lastUsedAt = Date.now();
  scheduleIdleReap(process);
  if (error) turn.reject(error);
  else turn.resolve();
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
    process.activeTurn = null;
    const failure =
      error ??
      new Error(
        process.stderrTail.trim() || "Persistent Claude Code process stopped unexpectedly",
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

  const persistent: PersistentProcess = {
    conversationId: options.conversationId,
    provider: options.provider,
    child,
    channel,
    mcpConfigPath,
    lastUsedAt: Date.now(),
    idleTimeoutMs: normalizedIdleTimeout(options.idleTimeoutMs),
    idleTimer: null,
    activeTurn: null,
    stdoutBuffer: "",
    stderrTail: "",
    closing: false,
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
        };
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
  if (options.provider !== "claude-code-persistent") {
    throw new Error(`Persistent chat provider ${options.provider} is not implemented`);
  }
  const spawned = spawnClaudeProcess(options);
  globalState().processes.set(options.conversationId, spawned);
  return spawned;
}

export function runPersistentChatTurn(
  options: PersistentChatTurnOptions,
): PersistentChatTurnHandle {
  const wasWarm = isPersistentChatSessionWarm(options.conversationId);
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
