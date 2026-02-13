import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { ClaudeResult, SpawnedClaude } from "@/lib/claude/spawn";
import {
  createStreamLog,
  appendStreamEvent,
  appendStderrEvent,
  endStreamLog,
  type StreamLogContext,
} from "@/lib/claude/logger";

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
}

function extractGeminiResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line) as { result?: unknown; output?: unknown; text?: unknown };
      if (typeof parsed.result === "string" && parsed.result.trim().length > 0) {
        return parsed.result.trim();
      }
      if (typeof parsed.output === "string" && parsed.output.trim().length > 0) {
        return parsed.output.trim();
      }
      if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
        return parsed.text.trim();
      }
    } catch {
      // ignore malformed JSON line
    }
  }

  return trimmed;
}

export function spawnGemini(options: GeminiOptions): SpawnedClaude {
  const { mode, prompt, cwd, model, onRawChunk, onOutputChunk, onResponseChunk, logIdentifier } =
    options;

  const args: string[] = ["-p", prompt, "--output-format", "json"];

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
        resolve({
          success: false,
          error: stderr.trim() || `Gemini CLI exited with code ${code}`,
          result: output || undefined,
          duration,
        });
        return;
      }

      resolve({
        success: true,
        result: output,
        duration,
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

  return { promise, kill };
}
