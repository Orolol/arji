/**
 * Codex provider — runs the `codex` CLI through the shared BaseCliProvider
 * lifecycle.
 *
 * Codex-specific behavior, expressed via the base-class hooks:
 * - `codex exec` in non-interactive mode, with a temp-file output capture
 *   (`-o <tmpfile>`) created in prepareSpawn() and read back in extractResult()
 * - a distinct resume subcommand (`codex exec resume <ID> <PROMPT>`) with its
 *   own, reduced flag set (no -C, -o, --color, -s)
 * - developer instructions injected via `-c developer_instructions="…"`
 * - actionable error detection for stream disconnects and missing login
 * - no CLI session ID extraction (codex output carries none)
 * - a prompt past the argv cap is passed as the `-` positional and piped on
 *   stdin, which both `codex exec` and `codex exec resume` accept
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { CODEX_SUBAGENT_DEVELOPER_INSTRUCTIONS } from "@/lib/codex/constants";
import type { StreamLogContext } from "@/lib/claude/logger";
import {
  BaseCliProvider,
  STDIN_PAYLOAD_KEY,
  type BaseProviderChunkCallbacks,
  type ProviderExitInfo,
  type ProviderSpawnContext,
} from "./base-provider";
import { promptExceedsArgv } from "./prompt-transport";
import type {
  McpSpawnConfig,
  ProviderResult,
  ProviderSpawnOptions,
} from "./types";

interface CodexSpawnContext extends ProviderSpawnContext {
  /** Temp file passed via -o for reliable capture of the final message. */
  outputFile: string;
  /** Contents of the -o file, cached by extractResult() for chunk emission. */
  fileOutput?: string;
  /** Set when the prompt outgrew argv and rides stdin behind a `-` positional. */
  [STDIN_PAYLOAD_KEY]?: string;
}

/**
 * Per-spawn `-c mcp_servers.<name>.*` TOML overrides — the same mechanism
 * as developer_instructions. `JSON.stringify` of a JS string produces a
 * valid TOML basic string, and stringifying the args array produces a valid
 * TOML string array; env is a TOML inline table. The local ~/.codex
 * config.toml has no [mcp_servers] section, so these overrides collide with
 * nothing. Codex launches the MCP server itself (outside the exec sandbox),
 * so localhost HTTP works in all sandbox modes; no allowlist flag exists or
 * is needed — configured servers' tools are exposed directly.
 *
 * Registering the server is necessary but NOT sufficient: `codex exec` gates
 * every tool CALL on an approval prompt that its own closed stdin refuses.
 * See codexApprovalArgs() for the measurements and the flag that opens it.
 *
 * RESIDUAL EXPOSURE, accepted: unlike claude's `--mcp-config`, which takes a
 * file path (see lib/claude/spawn.ts — that is why the claude token is NOT in
 * argv), codex's `-c` mechanism has no file form, so the bearer token has to
 * ride in the child's argv and is therefore readable via
 * /proc/<pid>/cmdline for the lifetime of the process. That is a LOCAL-ONLY
 * exposure on a single-user machine, bounded by the token's per-session scope
 * and by revocation at process exit. Everything downstream of the spawn is
 * masked: the persisted cliCommand (buildDisplayCommand), the console spawn
 * log (beforeSpawn), and the NDJSON log header (redactMcpToken in
 * lib/claude/logger.ts). Revisit if codex gains a config-file override.
 */
/**
 * Approval/sandbox flags for `codex exec`. One answer for every mode, on
 * purpose.
 *
 * `codex exec` closes stdin, so its approval prompt reads EOF and treats it as
 * a REFUSAL. Every MCP tool call is gated on that prompt, which is why review
 * sessions — the ones that ran `-s read-only` — could never file a finding
 * through submit_findings and silently fell back to prose for the whole life
 * of the database (see lib/pipeline/parse-review-report.ts). Measured on
 * codex-cli 0.148.0 with a stdio probe server:
 *
 *   -s read-only        server starts, tool call refused
 *   -s workspace-write  server starts, tool call refused
 *                       ("the tool requires approval, but approvals are disabled")
 *   --dangerously-…     server starts, tool call COMPLETES
 *
 * The two are welded together in this CLI: the only switch that opens the
 * approval gate also drops the sandbox, and none of the config keys that look
 * like they should help (`approval_policy`, `tools_require_approval`,
 * `mcp_approval_policy`, `trusted_mcp_servers`) have any effect — upstream
 * openai/codex#24135, still open. So a sandboxed codex agent is an agent with
 * no tool channel, and the sandbox was already costing more than it saved:
 * under `-s read-only` reviewers could not create a temp directory, so vitest
 * and playwright refused to run and every review was signed off without the
 * suite ever executing.
 *
 * What actually contains these agents is the same thing that contains the
 * claude-code ones, which have run `--permission-mode bypassPermissions` all
 * along: a disposable per-ticket git worktree. Narrow this the moment codex
 * grows a real non-interactive approval setting.
 */
function codexApprovalArgs(): string[] {
  return ["--dangerously-bypass-approvals-and-sandbox"];
}

function buildCodexMcpOverrideArgs(mcp: McpSpawnConfig): string[] {
  const prefix = `mcp_servers.${mcp.serverName}`;
  // All env keys ride the inline table (base URL, token, and the optional
  // toolset selector) — JSON.stringify of each value is a valid TOML string.
  const envTable = Object.entries(mcp.env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",");
  return [
    "-c",
    `${prefix}.command=${JSON.stringify(mcp.command)}`,
    "-c",
    `${prefix}.args=${JSON.stringify(mcp.args)}`,
    "-c",
    `${prefix}.env={${envTable}}`,
  ];
}

/**
 * The `-c mcp_servers.<name>.env=…` override value carries the per-session
 * bearer token — never let it reach the persisted display command or the
 * console spawn log.
 */
function maskCodexMcpSecret(arg: string): string {
  if (arg.startsWith("mcp_servers.") && arg.includes("ARIJ_MCP_TOKEN")) {
    return `${arg.slice(0, arg.indexOf("="))}=<redacted>`;
  }
  return arg;
}

export class CodexProvider extends BaseCliProvider {
  readonly type = "codex" as const;

  get binaryName(): string {
    return "codex";
  }

  /**
   * Developer instructions injected via `-c developer_instructions=…`.
   * Blank or missing values are omitted from the args.
   */
  protected get developerInstructions(): string | undefined {
    return CODEX_SUBAGENT_DEVELOPER_INSTRUCTIONS;
  }

  protected prepareSpawn(options: ProviderSpawnOptions): CodexSpawnContext {
    // Temp file for -o (reliable output capture)
    return {
      outputFile: path.join(
        os.tmpdir(),
        `codex-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
      ),
      ...(promptExceedsArgv(options.prompt)
        ? { [STDIN_PAYLOAD_KEY]: options.prompt }
        : {}),
    };
  }

  buildArgs(
    options: ProviderSpawnOptions,
    spawnContext?: ProviderSpawnContext,
  ): string[] {
    // No `mode` here: unlike the other providers, every codex exec gets the
    // same approval/sandbox posture — see codexApprovalArgs().
    const { prompt, cwd, model, cliSessionId, resumeSession, mcp } = options;
    const effectiveCwd = cwd || process.cwd();
    const isResume = !!(cliSessionId && resumeSession);
    const developerInstructions = this.developerInstructions;
    // `-` tells codex to read the prompt from stdin, where BaseCliProvider
    // pipes it — the prompt is too long for a single argv element.
    const promptArg = (spawnContext as CodexSpawnContext | undefined)?.[
      STDIN_PAYLOAD_KEY
    ]
      ? "-"
      : prompt;

    // `codex exec resume <ID> <PROMPT>` is a separate subcommand with its own
    // flag set (no -C, -o, --color, -s).  Build args accordingly.
    const args: string[] = ["exec"];

    if (isResume) {
      args.push("resume", cliSessionId!);

      // resume only supports a subset of flags
      args.push(...codexApprovalArgs());
      args.push("--skip-git-repo-check");

      if (model) {
        args.push("-m", model);
      }

      if (developerInstructions && developerInstructions.trim()) {
        args.push("-c", `developer_instructions=${JSON.stringify(developerInstructions)}`);
      }

      if (mcp) {
        args.push(...buildCodexMcpOverrideArgs(mcp));
      }

      // Prompt as positional argument (after session ID)
      args.push(promptArg);
    } else {
      // --- normal (non-resume) exec ---

      args.push(...codexApprovalArgs());

      args.push("-C", effectiveCwd);
      args.push("--skip-git-repo-check");

      // Capture final message to file (avoids mixing with banners/logs)
      args.push("-o", (spawnContext as CodexSpawnContext).outputFile);

      // No ANSI escape codes
      args.push("--color", "never");

      if (model) {
        args.push("-m", model);
      }

      if (developerInstructions && developerInstructions.trim()) {
        args.push("-c", `developer_instructions=${JSON.stringify(developerInstructions)}`);
      }

      if (mcp) {
        args.push(...buildCodexMcpOverrideArgs(mcp));
      }

      // Prompt as positional argument
      args.push(promptArg);
    }

    return args;
  }

  protected beforeSpawn(args: string[], cwd: string): void {
    console.log(
      "[spawn] codex",
      args
        .map(maskCodexMcpSecret)
        .map((a) => (a.length > 100 ? a.slice(0, 100) + "..." : a))
        .join(" ")
    );
    console.log("[spawn] cwd:", cwd);
  }

  /**
   * Same display command as the base class, with the token-bearing MCP env
   * override masked before the prompt redaction runs (the command string is
   * persisted to agent_sessions.cliCommand and rendered in the UI).
   */
  buildDisplayCommand(args: string[], prompt: string): string {
    return super.buildDisplayCommand(args.map(maskCodexMcpSecret), prompt);
  }

  extractResult(
    stdout: string,
    _stderr: string,
    spawnContext?: ProviderSpawnContext,
  ): string {
    const ctx = spawnContext as CodexSpawnContext | undefined;

    // Read the -o output file (agent's final message)
    let fileOutput = "";
    if (ctx?.outputFile) {
      try {
        fileOutput = fs.readFileSync(ctx.outputFile, "utf-8").trim();
      } catch {
        // File may not exist if the process failed early
      }
      ctx.fileOutput = fileOutput;
    }

    // Best output: -o file > stdout
    return fileOutput || stdout.trim();
  }

  /**
   * Codex output carries no extractable CLI session ID; resume IDs are
   * tracked by the caller, so results never include one.
   */
  parseSessionId(): string | undefined {
    return undefined;
  }

  /**
   * The final-output chunk is only emitted when the -o file produced
   * content; the response chunk always carries the best available result.
   */
  protected emitFinalChunks(
    result: string,
    callbacks: BaseProviderChunkCallbacks,
    spawnContext?: ProviderSpawnContext,
  ): void {
    const fileOutput = (spawnContext as CodexSpawnContext | undefined)?.fileOutput ?? "";

    if (fileOutput) {
      callbacks.onOutputChunk?.({
        text: fileOutput,
        emittedAt: new Date().toISOString(),
      });
    }

    if (result) {
      callbacks.onResponseChunk?.({
        text: result,
        emittedAt: new Date().toISOString(),
      });
    }
  }

  protected buildSpawnErrorMessage(err: Error): string {
    return err.message.includes("ENOENT")
      ? "Codex CLI not found. Install it with: npm i -g @openai/codex"
      : `Failed to spawn Codex CLI: ${err.message}`;
  }

  protected buildExitError(
    code: number | null,
    stdout: string,
    stderr: string,
  ): string {
    // Detect common Codex CLI errors and provide actionable messages
    const combinedOutput = stderr + "\n" + stdout;

    if (/Reconnecting\.\.\.\s*\d+\/\d+/.test(combinedOutput)) {
      return (
        "Codex API connection failed (stream disconnected). " +
        "Check your network and ChatGPT subscription, or try again later."
      );
    }
    if (/not logged in|login required|unauthorized/i.test(combinedOutput)) {
      return "Codex CLI is not authenticated. Run `codex login` in your terminal.";
    }
    return stderr.trim() || `Codex CLI exited with code ${code}`;
  }

  protected handleExit(
    info: ProviderExitInfo,
    callbacks: BaseProviderChunkCallbacks,
    logCtx: StreamLogContext | null,
  ): ProviderResult {
    const providerResult = super.handleExit(info, callbacks, logCtx);

    const { code, stdout, stderr, duration } = info;
    const fileOutput =
      (info.spawnContext as CodexSpawnContext | undefined)?.fileOutput ?? "";
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

    return providerResult;
  }

  protected cleanupSpawnContext(spawnContext?: ProviderSpawnContext): void {
    const outputFile = (spawnContext as CodexSpawnContext | undefined)?.outputFile;
    if (!outputFile) return;
    try {
      fs.unlinkSync(outputFile);
    } catch {
      // ignore
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which codex", { stdio: "ignore" });
    } catch {
      return false;
    }
    // Also check login status (codex writes to stderr)
    try {
      const output = execSync("codex login status 2>&1", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return /logged in/i.test(output);
    } catch {
      return false;
    }
  }
}
