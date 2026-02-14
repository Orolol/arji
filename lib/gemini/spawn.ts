import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { ClaudeResult, SpawnedClaude } from "@/lib/claude/spawn";
import {
  createStreamLog,
  appendStreamEvent,
  appendStderrEvent,
  endStreamLog,
  type StreamLogContext,
} from "@/lib/claude/logger";
import { extractCliSessionIdFromOutput } from "@/lib/claude/json-parser";

export interface GeminiOptions {
  mode: "plan" | "code" | "analyze";
  prompt: string;
  cwd?: string;
  model?: string;
  onRawChunk?: (chunk: {
    source: "stdout" | "stderr";
    index: number;
    text: string;
    emittedAt: string;
  }) => void;
  onOutputChunk?: (chunk: { text: string; emittedAt: string }) => void;
  onResponseChunk?: (chunk: { text: string; emittedAt: string }) => void;
  logIdentifier?: string;
  /** Session UUID for resume support. */
  sessionId?: string;
  /** When true, resume the session identified by sessionId. */
  resumeSession?: boolean;
}

function extractGeminiResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Try structured JSON parsing first (handles stream-json and json formats)
  const textParts: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // stream-json event formats
      if (event.type === "text" && typeof event.text === "string") {
        textParts.push(event.text);
        continue;
      }
      if (
        event.type === "content_block_delta" &&
        typeof event.delta === "object" &&
        event.delta !== null &&
        typeof (event.delta as Record<string, unknown>).text === "string"
      ) {
        textParts.push((event.delta as Record<string, unknown>).text as string);
        continue;
      }
      if (event.type === "result" && typeof event.result === "string") {
        textParts.push(event.result);
        continue;
      }
      if (typeof event.content === "string") {
        textParts.push(event.content);
        continue;
      }
      // Vertex/Gemini API candidates format
      if (
        Array.isArray(
          (event as { candidates?: unknown[] }).candidates
        )
      ) {
        const candidates = (event as { candidates: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
        if (candidates[0]?.content?.parts) {
          for (const part of candidates[0].content.parts) {
            if (part.text) textParts.push(part.text);
          }
          continue;
        }
      }

      // Simple result/output/text fields (json output format)
      if (typeof event.result === "string" && (event.result as string).trim().length > 0) {
        textParts.push((event.result as string).trim());
        continue;
      }
      if (typeof event.output === "string" && (event.output as string).trim().length > 0) {
        textParts.push((event.output as string).trim());
        continue;
      }
      if (typeof event.text === "string" && (event.text as string).trim().length > 0) {
        textParts.push((event.text as string).trim());
        continue;
      }
    } catch {
      // ignore malformed JSON line
    }
  }

  if (textParts.length > 0) {
    return textParts.join("");
  }

  return trimmed;
}

export function spawnGemini(options: GeminiOptions): SpawnedClaude {
  const { mode, prompt, cwd, model, onRawChunk, onOutputChunk, onResponseChunk, logIdentifier, sessionId: cliSessionId, resumeSession } =
    options;

  const args: string[] = [];

  // Resume support
  if (cliSessionId && resumeSession) {
    args.push("--resume", cliSessionId);
  }

  args.push("-p", prompt, "--output-format", "json");

  if (mode === "code") {
    args.push("-y");
  }

  if (model) {
    args.push("-m", model);
  }

  const effectiveCwd = cwd || process.cwd();

  let logCtx: StreamLogContext | null = null;
  if (logIdentifier) {
    try {
      logCtx = createStreamLog(`gemini-${logIdentifier}`, ["gemini", ...args], prompt);
    } catch {
      // logging is best-effort
    }
  }

  let child: ChildProcess | null = null;
  let killed = false;

  const promise = new Promise<ClaudeResult>((resolve) => {
    const startTime = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutChunkIndex = 0;
    let stderrChunkIndex = 0;

    child = nodeSpawn("gemini", args, {
      cwd: effectiveCwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutChunkIndex += 1;
      const text = chunk.toString("utf-8");
      onRawChunk?.({
        source: "stdout",
        index: stdoutChunkIndex,
        text,
        emittedAt: new Date().toISOString(),
      });
      if (logCtx) {
        try {
          appendStreamEvent(logCtx, text);
        } catch {
          // best-effort
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrChunkIndex += 1;
      const text = chunk.toString("utf-8");
      onRawChunk?.({
        source: "stderr",
        index: stderrChunkIndex,
        text,
        emittedAt: new Date().toISOString(),
      });
      if (logCtx) {
        try {
          appendStderrEvent(logCtx, text);
        } catch {
          // best-effort
        }
      }
    });

    child.on("error", (err) => {
      const duration = Date.now() - startTime;
      const errorMsg = err.message.includes("ENOENT")
        ? "Gemini CLI not found. Install it with: npm i -g @google/gemini-cli"
        : `Failed to spawn Gemini CLI: ${err.message}`;

      if (logCtx) {
        try {
          endStreamLog(logCtx, { exitCode: null, error: errorMsg });
        } catch {
          // best-effort
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
      const output = extractGeminiResult(stdout);
      const extractedSessionId =
        extractCliSessionIdFromOutput(stdout) ??
        extractCliSessionIdFromOutput(stderr) ??
        cliSessionId;

      if (output) {
        const emittedAt = new Date().toISOString();
        onOutputChunk?.({ text: output, emittedAt });
        onResponseChunk?.({ text: output, emittedAt });
      }

      if (logCtx) {
        try {
          if (output) appendStreamEvent(logCtx, output);
          endStreamLog(logCtx, {
            exitCode: code,
            error: code !== 0 ? stderr.slice(0, 500) : undefined,
          });
        } catch {
          // best-effort
        }
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
        const combinedOutput = stderr + "\n" + stdout;
        let error: string;

        if (/not authenticated|authentication|unauthorized|login/i.test(combinedOutput)) {
          error =
            "Gemini CLI is not authenticated. Run `gemini auth login` in your terminal.";
        } else if (/model.*not found|invalid model/i.test(combinedOutput)) {
          error =
            "Invalid model name. Check available Gemini models with `gemini models list`.";
        } else {
          error = stderr.trim() || `Gemini CLI exited with code ${code}`;
        }

        resolve({
          success: false,
          error,
          result: output || undefined,
          duration,
          cliSessionId: extractedSessionId,
        });
        return;
      }

      resolve({
        success: true,
        result: output || stdout.trim(),
        duration,
        cliSessionId: extractedSessionId,
      });
    });
  });

  const kill = () => {
    if (child && !child.killed) {
      killed = true;
      child.kill("SIGTERM");

      setTimeout(() => {
        if (child && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }
  };

  // Build display command (replace prompt with <prompt>)
  const displayArgs = args.map((a, i) => {
    if (i > 0 && args[i - 1] === "-p") return "<prompt>";
    if (a === prompt && a.length > 50) return "<prompt>";
    return a;
  });
  const command = `gemini ${displayArgs.join(" ")}`;

  return { promise, kill, command };
}
