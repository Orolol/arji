import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ClaudeResult, SpawnedClaude } from "@/lib/claude/spawn";

export interface CodexOptions {
  mode: "plan" | "code" | "analyze";
  prompt: string;
  cwd?: string;
  model?: string;
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
  const { mode, prompt, cwd, model } = options;

  // Temp file for -o (reliable output capture)
  const outputFile = path.join(
    os.tmpdir(),
    `codex-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );

  const args: string[] = ["exec"];

  // Sandbox mode
  if (mode === "code") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (mode === "analyze") {
    // analyze → can read + write workspace files (e.g. arji.json)
    args.push("-s", "workspace-write");
  } else {
    // plan → read-only
    args.push("-s", "read-only");
  }

  // Working directory
  const effectiveCwd = cwd || process.cwd();
  args.push("-C", effectiveCwd);

  // Common flags
  args.push("--skip-git-repo-check");

  // Capture final message to file (avoids mixing with banners/logs)
  args.push("-o", outputFile);

  // No ANSI escape codes
  args.push("--color", "never");

  // Model override
  if (model) {
    args.push("-m", model);
  }

  // Prompt as positional argument
  args.push(prompt);

  console.log(
    "[spawn] codex",
    args.map((a) => (a.length > 100 ? a.slice(0, 100) + "..." : a)).join(" ")
  );
  console.log("[spawn] cwd:", effectiveCwd);

  let child: ChildProcess | null = null;
  let killed = false;

  const promise = new Promise<ClaudeResult>((resolve) => {
    const startTime = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child = nodeSpawn("codex", args, {
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
      cleanup();

      if (err.message.includes("ENOENT")) {
        resolve({
          success: false,
          error:
            "Codex CLI not found. Install it with: npm i -g @openai/codex",
          duration,
        });
      } else {
        resolve({
          success: false,
          error: `Failed to spawn Codex CLI: ${err.message}`,
          duration,
        });
      }
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

  return { promise, kill };
}
