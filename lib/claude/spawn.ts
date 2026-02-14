import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import {
  createStreamLog,
  appendStreamEvent,
  appendStderrEvent,
  endStreamLog,
  type StreamLogContext,
} from "./logger";

export interface ClaudeOptions {
  mode: "plan" | "code" | "analyze";
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  model?: string;
  logIdentifier?: string;
  claudeSessionId?: string;
  resumeSession?: boolean;
}

export interface ClaudeResult {
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
}

export interface SpawnedClaude {
  promise: Promise<ClaudeResult>;
  kill: () => void;
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
 * Spawns the `claude` CLI as a child process and returns a promise that
 * resolves with the parsed JSON result once the process exits.
 *
 * The returned `kill` function can be called to abort the process early.
 */
export function spawnClaude(options: ClaudeOptions): SpawnedClaude {
  const { mode, prompt, cwd, allowedTools, model, claudeSessionId, resumeSession } = options;

  // --permission-mode: "plan" for read-only, "bypassPermissions" for code/analyze
  const permissionMode = mode === "plan" ? "plan" : "bypassPermissions";

  // "analyze" mode restricts tools to read + write (no Bash/Edit)
  const effectiveAllowedTools =
    mode === "analyze" && (!allowedTools || allowedTools.length === 0)
      ? ["Read", "Glob", "Grep", "Write"]
      : allowedTools;

  const args: string[] = [
    "--permission-mode",
    permissionMode,
    "--output-format",
    "json",
  ];

  if (claudeSessionId && resumeSession) {
    args.push("--resume", claudeSessionId);
  } else if (claudeSessionId) {
    args.push("--session-id", claudeSessionId);
  }

  args.push("--print", "-p", prompt);

  if (model) {
    args.push("--model", model);
  }

  if (effectiveAllowedTools && effectiveAllowedTools.length > 0) {
    args.push("--allowedTools", ...effectiveAllowedTools);
  }

  const effectiveCwd = cwd || process.cwd();

  console.log("[spawn] claude", args.map(a => a.length > 100 ? a.slice(0, 100) + "..." : a).join(" "));
  console.log("[spawn] cwd:", effectiveCwd);

  let child: ChildProcess | null = null;
  let killed = false;

  const promise = new Promise<ClaudeResult>((resolve) => {
    const startTime = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child = nodeSpawn("claude", args, {
      cwd: effectiveCwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      const duration = Date.now() - startTime;

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
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      console.log("[spawn] Process exited, code:", code, "duration:", duration + "ms", "stdout:", stdout.length, "bytes, stderr:", stderr.length, "bytes");
      if (stderr.trim()) {
        console.log("[spawn] stderr:", stderr.slice(0, 500));
      }
      if (stdout.trim()) {
        console.log("[spawn] stdout preview:", stdout.slice(0, 300));
      }

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
        });
        return;
      }

      resolve({
        success: true,
        result: stdout.trim(),
        duration,
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

  return { promise, kill };
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
  const { mode, prompt, cwd, allowedTools, model, logIdentifier, claudeSessionId, resumeSession } = options;

  const permissionMode = mode === "plan" ? "plan" : "bypassPermissions";

  const effectiveAllowedTools =
    mode === "analyze" && (!allowedTools || allowedTools.length === 0)
      ? ["Read", "Glob", "Grep", "Write"]
      : allowedTools;

  const args: string[] = [
    "--permission-mode",
    permissionMode,
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  if (claudeSessionId && resumeSession) {
    args.push("--resume", claudeSessionId);
  } else if (claudeSessionId) {
    args.push("--session-id", claudeSessionId);
  }

  args.push("--print", "-p", prompt);

  if (model) {
    args.push("--model", model);
  }

  if (effectiveAllowedTools && effectiveAllowedTools.length > 0) {
    args.push("--allowedTools", ...effectiveAllowedTools);
  }

  const effectiveCwd = cwd || process.cwd();

  console.log("[stream-spawn] claude", args.map(a => a.length > 100 ? a.slice(0, 100) + "..." : a).join(" "));
  console.log("[stream-spawn] cwd:", effectiveCwd);

  // Initialize log if identifier provided
  let logCtx: StreamLogContext | null = null;
  if (logIdentifier) {
    try {
      logCtx = createStreamLog(logIdentifier, args, prompt);
      console.log("[stream-spawn] logging to:", logCtx.filePath);
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
        stdio: ["ignore", "pipe", "pipe"],
      });

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
        if (logCtx) {
          try {
            endStreamLog(logCtx, { exitCode: null, error: err.message });
          } catch { /* ignore */ }
        }
        controller.close();
      });

      child.on("close", (code) => {
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
