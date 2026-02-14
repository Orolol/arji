import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ClaudeResult, SpawnedClaude } from "@/lib/claude/spawn";
import {
  createStreamLog,
  appendStreamEvent,
  appendStderrEvent,
  endStreamLog,
  type StreamLogContext,
} from "@/lib/claude/logger";

export interface CodexOptions {
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
  /** Optional identifier for NDJSON session logging (same format as Claude Code). */
  logIdentifier?: string;
  /** Optional legacy thread/session ID (ignored in `codex exec` mode). */
  sessionId?: string;
  /** Optional CLI session ID for resume support (codex exec resume). */
  cliSessionId?: string;
  /** @deprecated `codex exec` is non-resumable; this flag is ignored. */
  resumeSession?: boolean;
}

/**
 * Spawns the `codex` CLI in non-interactive mode (`codex exec`) and returns
 * a promise that resolves with the result once the process exits.
 *
 * Uses `-o <tmpfile>` to reliably capture the agent's final message,
 * with stdout as a fallback.
 *
 * Mirrors the `spawnClaude()` interface so both can be used interchangeably
 * by the process manager.
 */
export function spawnCodex(options: CodexOptions): SpawnedClaude {
  const {
    mode,
    prompt,
    cwd,
    model,
    onRawChunk,
    onOutputChunk,
    onResponseChunk,
    logIdentifier,
    cliSessionId,
    resumeSession,
  } = options;

  // Temp file for -o (reliable output capture)
  const outputFile = path.join(
    os.tmpdir(),
    `codex-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );

  const effectiveCwd = cwd || process.cwd();
  const isResume = !!(cliSessionId && resumeSession);

  // `codex exec resume <ID> <PROMPT>` is a separate subcommand with its own
  // flag set (no -C, -o, --color, -s).  Build args accordingly.
  const args: string[] = ["exec"];

  if (isResume) {
    args.push("resume", cliSessionId!);

    // resume only supports a subset of flags
    if (mode === "code") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push("--skip-git-repo-check");

    if (model) {
      args.push("-m", model);
    }

    // Prompt as positional argument (after session ID)
    args.push(prompt);
  } else {
    // --- normal (non-resume) exec ---

    // Sandbox mode
    if (mode === "code") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (mode === "analyze") {
      args.push("-s", "workspace-write");
    } else {
      args.push("-s", "read-only");
    }

    args.push("-C", effectiveCwd);
    args.push("--skip-git-repo-check");

    // Capture final message to file (avoids mixing with banners/logs)
    args.push("-o", outputFile);

    // No ANSI escape codes
    args.push("--color", "never");

    if (model) {
      args.push("-m", model);
    }

    // Prompt as positional argument
    args.push(prompt);
  }

  console.log(
    "[spawn] codex",
    args.map((a) => (a.length > 100 ? a.slice(0, 100) + "..." : a)).join(" ")
  );
  console.log("[spawn] cwd:", effectiveCwd);

  // Optional NDJSON logging (same format as Claude Code)
  let logCtx: StreamLogContext | null = null;
  if (logIdentifier) {
    try {
      logCtx = createStreamLog(`codex-${logIdentifier}`, ["codex", ...args], prompt);
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

    child = nodeSpawn("codex", args, {
      cwd: effectiveCwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutChunkIndex += 1;
      onRawChunk?.({
        source: "stdout",
        index: stdoutChunkIndex,
        text: chunk.toString("utf-8"),
        emittedAt: new Date().toISOString(),
      });
      if (logCtx) {
        try { appendStreamEvent(logCtx, chunk.toString("utf-8")); } catch { /* best-effort */ }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrChunkIndex += 1;
      onRawChunk?.({
        source: "stderr",
        index: stderrChunkIndex,
        text: chunk.toString("utf-8"),
        emittedAt: new Date().toISOString(),
      });
      if (logCtx) {
        try { appendStderrEvent(logCtx, chunk.toString("utf-8")); } catch { /* best-effort */ }
      }
    });

    child.on("error", (err) => {
      const duration = Date.now() - startTime;
      cleanup();

      const errorMsg = err.message.includes("ENOENT")
        ? "Codex CLI not found. Install it with: npm i -g @openai/codex"
        : `Failed to spawn Codex CLI: ${err.message}`;

      if (logCtx) {
        try { endStreamLog(logCtx, { exitCode: null, error: errorMsg }); } catch { /* best-effort */ }
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

      // Read the -o output file (agent's final message)
      let fileOutput = "";
      try {
        fileOutput = fs.readFileSync(outputFile, "utf-8").trim();
      } catch {
        // File may not exist if the process failed early
      }
      cleanup();

      // Best output: -o file > stdout
      const result = fileOutput || stdout.trim();

      if (fileOutput) {
        onOutputChunk?.({
          text: fileOutput,
          emittedAt: new Date().toISOString(),
        });
      }

      if (result) {
        onResponseChunk?.({
          text: result,
          emittedAt: new Date().toISOString(),
        });
      }

      console.log(
        "[spawn] codex exited, code:",
        code,
        "duration:",
        duration + "ms",
        "output:",
        result.length,
        "bytes (file:",
        fileOutput.length,
        "/ stdout:",
        stdout.length,
        "), stderr:",
        stderr.length,
        "bytes"
      );
      if (stderr.trim()) {
        console.log("[spawn] stderr:", stderr.slice(0, 500));
      }
      if (result) {
        console.log("[spawn] output preview:", result.slice(0, 300));
      }

      // Log the final output and end-of-session
      if (logCtx) {
        try {
          if (result) appendStreamEvent(logCtx, result);
          endStreamLog(logCtx, { exitCode: code, error: code !== 0 ? stderr.slice(0, 500) : undefined });
        } catch { /* best-effort */ }
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
        // Detect common Codex CLI errors and provide actionable messages
        const combinedOutput = stderr + "\n" + stdout;
        let error: string;

        if (/Reconnecting\.\.\.\s*\d+\/\d+/.test(combinedOutput)) {
          error =
            "Codex API connection failed (stream disconnected). " +
            "Check your network and ChatGPT subscription, or try again later.";
        } else if (/not logged in|login required|unauthorized/i.test(combinedOutput)) {
          error =
            "Codex CLI is not authenticated. Run `codex login` in your terminal.";
        } else {
          error = stderr.trim() || `Codex CLI exited with code ${code}`;
        }

        resolve({
          success: false,
          error,
          result: result || undefined,
          duration,
        });
        return;
      }

      resolve({
        success: true,
        result,
        duration,
      });
    });
  });

  function cleanup() {
    try {
      fs.unlinkSync(outputFile);
    } catch {
      // ignore
    }
  }

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

  // Build display command (replace prompt with <prompt>)
  const displayArgs = args.map((a) => {
    if (a === prompt && a.length > 50) return "<prompt>";
    return a;
  });
  const command = `codex ${displayArgs.join(" ")}`;

  return { promise, kill, command };
}
