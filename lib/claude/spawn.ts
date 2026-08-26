import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import {
  createStreamLog,
  appendStreamEvent,
  appendStderrEvent,
  endStreamLog,
  type StreamLogContext,
} from "./logger";
import { extractCliSessionIdFromOutput, hasAskUserQuestion } from "./json-parser";
import { cleanupMcpConfigFile, writeMcpConfigFile } from "./mcp-injection";
import { promptExceedsArgv } from "@/lib/providers/prompt-transport";
import type { McpSpawnConfig } from "@/lib/providers/types";

export interface ClaudeOptions {
  /**
   * "plan": read-only research with the CLI's plan-mode prompt (the model
   * presents a plan and mutating tools are refused — including allowlisted
   * MCP tools). "chat": conversational turns that must keep the repo
   * read-only but still act through the Arij MCP board tools; permission
   * mode "default" with a read-only allowlist, so allowlisted MCP tools are
   * auto-approved and everything else is denied headlessly.
   */
  mode: "plan" | "code" | "analyze" | "chat";
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  model?: string;
  logIdentifier?: string;
  cliSessionId?: string;
  resumeSession?: boolean;
  /**
   * Arij MCP tool-channel injection. When set, the spawn writes the config
   * to a 0600 temp file and buildClaudeArgs adds `--mcp-config <file>` +
   * `--strict-mcp-config`, merging the exact tool names into --allowedTools.
   * Set centrally by processManager.start() for agent sessions, and by the
   * chat stream route (lib/chat/cli-tool-channel.ts) for chat turns — the
   * remaining direct call sites (generate-spec, import, title generation)
   * never pass it.
   */
  mcp?: McpSpawnConfig;
}

export interface ClaudeResult {
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
  cliSessionId?: string;
  /** True when the agent ended by asking a user question. */
  endedWithQuestion?: boolean;
}

export interface SpawnedClaude {
  promise: Promise<ClaudeResult>;
  kill: () => void;
  command?: string;
  /**
   * Path of the temp `--mcp-config` file, when MCP injection was active.
   * spawnClaude deletes it itself on exit/spawn failure; exposed so the
   * process manager can also clear it on its own teardown path.
   */
  mcpConfigPath?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionData {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "questions"; questions: QuestionData[] }
  | { type: "status"; status: string };

export interface SpawnedClaudeStream {
  stream: ReadableStream<StreamChunk>;
  kill: () => void;
}

/**
 * Builds the `claude` CLI argument list shared by spawnClaude() and
 * spawnClaudeStream(). The two only differ in output format: "json"
 * for the one-shot spawn, "stream-json" (plus --verbose) for streaming.
 *
 * MCP wiring is emitted only when BOTH `options.mcp` and `mcpConfigPath` are
 * present — the config file is what actually configures the server, so a
 * failed file write degrades to a plain (uninjected) spawn rather than
 * allowlisting tools for a server that was never configured. Callers get the
 * path from `prepareClaudeSpawn`; this function stays pure.
 */
export function buildClaudeArgs(
  options: ClaudeOptions,
  outputFormat: "json" | "stream-json",
  mcpConfigPath?: string | null,
): string[] {
  const { mode, prompt, allowedTools, model, cliSessionId, resumeSession } =
    options;
  const mcp = mcpConfigPath ? options.mcp : undefined;

  // --permission-mode: "plan" for read-only research, "default" for chat
  // (headless: allowlisted tools run, everything else is denied),
  // "bypassPermissions" for code/analyze.
  const permissionMode =
    mode === "plan" ? "plan" : mode === "chat" ? "default" : "bypassPermissions";

  // "analyze" mode restricts tools to read + write (no Bash/Edit); "chat"
  // mode keeps the repo strictly read-only (no Bash, no Write) — board
  // mutations go through the MCP tools merged in below.
  const effectiveAllowedTools =
    !allowedTools || allowedTools.length === 0
      ? mode === "analyze"
        ? ["Read", "Glob", "Grep", "Write"]
        : mode === "chat"
          ? ["Read", "Glob", "Grep"]
          : allowedTools
      : allowedTools;

  // Arij MCP tools ride the same allowlist — exact names, no wildcards.
  // NOTE: plan mode still refuses mutating MCP tools regardless of the
  // allowlist; a spawn that must use them needs "chat" (or code) mode.
  const mergedAllowedTools = mcp
    ? [...(effectiveAllowedTools ?? []), ...mcp.allowedToolNames]
    : effectiveAllowedTools;

  const args: string[] = [
    "--permission-mode",
    permissionMode,
    "--output-format",
    outputFormat,
  ];

  if (outputFormat === "stream-json") {
    args.push("--verbose");
  }

  if (cliSessionId && resumeSession) {
    args.push("--resume", cliSessionId);
  } else if (cliSessionId) {
    args.push("--session-id", cliSessionId);
  }

  if (promptExceedsArgv(prompt)) {
    // Past MAX_ARG_STRLEN a prompt cannot be an argv element at all — claude
    // reads it from stdin when --print is given none, and both spawners pipe
    // it there. See lib/providers/prompt-transport.ts.
    args.push("--print");
  } else {
    args.push("--print", "-p", prompt);
  }

  if (model) {
    args.push("--model", model);
  }

  if (mcp) {
    // `--mcp-config` takes JSON files as well as inline JSON strings, and we
    // deliberately use the FILE form: an inline string would put the bearer
    // token in the child's argv, i.e. in world-readable /proc/<pid>/cmdline,
    // where the agent's own Bash tool could read it back. The env (base URL +
    // token) lives inside the per-server config rather than the child's
    // process env, so subshells never inherit it either.
    // --strict-mcp-config ignores any user/project MCP configuration lying
    // around in the worktree.
    args.push("--mcp-config", mcpConfigPath!, "--strict-mcp-config");
  }

  if (mergedAllowedTools && mergedAllowedTools.length > 0) {
    args.push("--allowedTools", ...mergedAllowedTools);
  }

  return args;
}

export interface PreparedClaudeSpawn {
  args: string[];
  /** Temp `--mcp-config` file to delete once the process is done, if any. */
  mcpConfigPath: string | null;
}

/**
 * Materializes the MCP config file (when injection is active) and builds the
 * argv around it. Writing the file is best-effort: a session must never fail
 * to spawn because the temp dir was unwritable, so a failure degrades to a
 * spawn without the tool channel.
 */
export function prepareClaudeSpawn(
  options: ClaudeOptions,
  outputFormat: "json" | "stream-json",
): PreparedClaudeSpawn {
  let mcpConfigPath: string | null = null;

  if (options.mcp) {
    try {
      mcpConfigPath = writeMcpConfigFile(options.mcp);
    } catch (error) {
      console.warn(
        "[spawn] MCP config file write failed — spawning without the tool channel:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { args: buildClaudeArgs(options, outputFormat, mcpConfigPath), mcpConfigPath };
}

/**
 * Spawns the `claude` CLI as a child process and returns a promise that
 * resolves with the parsed JSON result once the process exits.
 *
 * The returned `kill` function can be called to abort the process early.
 */
export function spawnClaude(options: ClaudeOptions): SpawnedClaude {
  const { prompt, cwd, cliSessionId } = options;

  const { args, mcpConfigPath } = prepareClaudeSpawn(options, "json");

  const effectiveCwd = cwd || process.cwd();
  const promptOnStdin = promptExceedsArgv(prompt);

  // Debug logging removed for production

  let child: ChildProcess | null = null;
  let killed = false;

  const promise = new Promise<ClaudeResult>((resolve) => {
    const startTime = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child = nodeSpawn("claude", args, {
      cwd: effectiveCwd,
      env: { ...process.env },
      stdio: [promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (promptOnStdin) {
      // EPIPE if claude exits before draining the prompt — that failure is
      // already reported through the exit path.
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      const duration = Date.now() - startTime;
      // Spawn failure is terminal — the config file (and its token) must not
      // outlive the attempt.
      cleanupMcpConfigFile(mcpConfigPath);

      if (err.message.includes("ENOENT")) {
        resolve({
          success: false,
          error:
            "Claude CLI not found. Ensure `claude` is installed and available in PATH.",
          duration,
        });
      } else {
        resolve({
          success: false,
          error: `Failed to spawn Claude CLI: ${err.message}`,
          duration,
        });
      }
    });

    child.on("close", (code) => {
      const duration = Date.now() - startTime;
      // Session end (normal exit, failure, or kill) — drop the token file.
      cleanupMcpConfigFile(mcpConfigPath);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const parsedCliSessionId =
        extractCliSessionIdFromOutput(stdout) ?? cliSessionId;
      const endedWithQuestion = hasAskUserQuestion(stdout);

      // Debug logging removed for production

      if (killed) {
        resolve({
          success: false,
          error: "Process was cancelled.",
          duration,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          error:
            stderr.trim() ||
            `Claude CLI exited with code ${code}`,
          result: stdout.trim() || undefined,
          duration,
          cliSessionId: parsedCliSessionId,
          endedWithQuestion,
        });
        return;
      }

      resolve({
        success: true,
        result: stdout.trim(),
        duration,
        cliSessionId: parsedCliSessionId,
        endedWithQuestion,
      });
    });
  });

  const kill = () => {
    if (child && !child.killed) {
      killed = true;
      child.kill("SIGTERM");

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (child && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }
  };

  // Build display command (replace prompt with <prompt>; the --mcp-config
  // value is an ephemeral temp path that means nothing in the UI, so it is
  // collapsed to a placeholder)
  const displayArgs = args.map((a, i) => {
    if (i > 0 && (args[i - 1] === "-p" || args[i - 1] === "--print")) return "<prompt>";
    if (i > 0 && args[i - 1] === "--mcp-config") return "<mcp-config>";
    if (a === prompt && a.length > 50) return "<prompt>";
    return a;
  });
  const command = `claude ${displayArgs.join(" ")}${promptOnStdin ? " < <prompt>" : ""}`;

  return { promise, kill, command, mcpConfigPath: mcpConfigPath ?? undefined };
}

// Events that are expected but carry no text to stream
const SILENT_EVENTS = new Set([
  "message_start",
  "message_stop",
  "message_delta",
  "system",
  "user",
]);

/**
 * Extract text from a `result` event, which may be a plain string
 * or an object with a content array.
 */
function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown[] }).content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && "type" in b && "text" in b && b.type === "text"
        )
        .map((b) => b.text)
        .join("");
    }
  }
  return "";
}

/**
 * Spawns the `claude` CLI with `--output-format stream-json` and returns a
 * ReadableStream of text deltas parsed from NDJSON stdout.
 *
 * Deduplication: text is emitted from `content_block_delta` events only.
 * The `result` event is used as a fallback if no deltas were received.
 * The `assistant` event is always ignored (redundant).
 */
export function spawnClaudeStream(options: ClaudeOptions): SpawnedClaudeStream {
  const { prompt, cwd, logIdentifier } = options;

  const { args, mcpConfigPath } = prepareClaudeSpawn(options, "stream-json");

  const effectiveCwd = cwd || process.cwd();
  const promptOnStdin = promptExceedsArgv(prompt);

  // Debug logging removed for production

  // Initialize log if identifier provided
  let logCtx: StreamLogContext | null = null;
  if (logIdentifier) {
    try {
      logCtx = createStreamLog(logIdentifier, args, prompt);
      // Debug logging removed for production
    } catch (err) {
      console.warn("[stream-spawn] Failed to create log:", err);
    }
  }

  let child: ChildProcess | null = null;
  let textDeltasEmitted = false;

  // Activity tracking
  let isThinking = false;
  const toolsUsed: string[] = [];

  function formatStatus(): string {
    const parts: string[] = [];
    if (isThinking) parts.push("Thinking");
    if (toolsUsed.length === 1) {
      parts.push(`using ${toolsUsed[0]}`);
    } else if (toolsUsed.length > 1) {
      parts.push(`used ${toolsUsed.length} tools`);
    }
    return parts.length > 0 ? parts.join(", ") + "..." : "Thinking...";
  }

  const stream = new ReadableStream<StreamChunk>({
    start(controller) {
      child = nodeSpawn("claude", args, {
        cwd: effectiveCwd,
        env: { ...process.env },
        stdio: [promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });

      if (promptOnStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(prompt);
      }

      let buffer = "";

      function processLine(trimmed: string) {
        if (!trimmed) return;

        // Log raw line
        if (logCtx) {
          try {
            appendStreamEvent(logCtx, trimmed);
          } catch { /* ignore logging errors */ }
        }

        try {
          const event = JSON.parse(trimmed);

          // content_block_start: track what phase we're entering
          if (event.type === "content_block_start") {
            const blockType = event.content_block?.type;
            if (blockType === "thinking") {
              isThinking = true;
              controller.enqueue({ type: "status", status: formatStatus() });
            } else if (blockType === "tool_use") {
              const toolName = event.content_block?.name || "tool";
              toolsUsed.push(toolName);
              controller.enqueue({ type: "status", status: formatStatus() });
            }
            return;
          }

          // content_block_stop: thinking phase may end
          if (event.type === "content_block_stop") {
            return;
          }

          // content_block_delta: incremental text deltas (primary source)
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta?.text
          ) {
            if (isThinking) {
              isThinking = false;
            }
            controller.enqueue({ type: "text", text: event.delta.text });
            textDeltasEmitted = true;
            return;
          }

          // Ignore thinking deltas (extended thinking phase)
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "thinking_delta"
          ) {
            return;
          }

          // Ignore input_json_delta (tool input streaming)
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "input_json_delta"
          ) {
            return;
          }

          // result event: fallback only if no deltas were emitted
          if (event.type === "result") {
            if (!textDeltasEmitted) {
              const text = extractResultText(event.result);
              if (text) {
                controller.enqueue({ type: "text", text });
              }
            }
            return;
          }

          // assistant event: extract AskUserQuestion tool_use blocks
          if (event.type === "assistant" && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (
                block.type === "tool_use" &&
                block.name === "AskUserQuestion" &&
                Array.isArray(block.input?.questions)
              ) {
                controller.enqueue({ type: "questions", questions: block.input.questions });
              }
            }
            return;
          }

          // Known silent events — skip without warning
          if (SILENT_EVENTS.has(event.type)) {
            return;
          }

          // Unknown event types — log for debugging
          if (event.type) {
            console.warn("[stream-spawn] unhandled event type:", event.type);
          }
        } catch {
          // Not valid JSON — skip
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          processLine(line.trim());
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        console.error("[stream-spawn] stderr:", text.slice(0, 500));
        if (logCtx) {
          try {
            appendStderrEvent(logCtx, text);
          } catch { /* ignore */ }
        }
      });

      child.on("error", (err) => {
        console.error("[stream-spawn] error:", err.message);
        cleanupMcpConfigFile(mcpConfigPath);
        if (logCtx) {
          try {
            endStreamLog(logCtx, { exitCode: null, error: err.message });
          } catch { /* ignore */ }
        }
        controller.close();
      });

      child.on("close", (code) => {
        cleanupMcpConfigFile(mcpConfigPath);

        // Process any remaining buffer
        if (buffer.trim()) {
          processLine(buffer.trim());
        }

        if (logCtx) {
          try {
            endStreamLog(logCtx, { exitCode: code });
          } catch { /* ignore */ }
        }

        controller.close();
      });
    },
    cancel() {
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    },
  });

  const kill = () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }
  };

  return { stream, kill };
}
