/**
 * Antigravity provider — wraps the `agy` CLI (Google Antigravity).
 *
 * CLI: agy --output-format json --print-timeout 24h --add-dir <CWD>
 *          [--mode plan] [--conversation <ID>] [--model <M>] -p <PROMPT>
 *
 * Everything below was measured live on agy 1.1.21 (2026-08-26), not read
 * from docs:
 *
 * - Print mode (`-p`) auto-approves EVERYTHING — file writes, run_command,
 *   and MCP tool calls all execute with no flag at all, so unlike codex no
 *   `--dangerously-*` switch is needed. Containment is the disposable
 *   per-ticket worktree, exactly as for claude's bypassPermissions.
 * - `--mode plan` blocks worktree writes (the agent produces a plan artifact
 *   instead) while MCP tool calls STILL execute — the same orthogonality omp
 *   has, so plan/chat sessions keep the whole tool channel.
 * - Workspace: agy is project-based and IGNORES the process cwd for file
 *   operations (a bare run wrote to $HOME). `--add-dir <cwd>` anchors the
 *   session to the worktree; keep it on every spawn.
 * - Output: one JSON object on stdout —
 *   `{"conversation_id","status":"SUCCESS","response",…}`. The conversation
 *   id is self-reported and `--conversation <id>` resumes it (verified:
 *   the resumed turn recalled first-turn context, same id echoed).
 * - MCP: agy has no per-spawn MCP flag; servers come from the user-global
 *   `~/.gemini/antigravity/mcp_config.json` (managed with `agy mcp add`).
 *   The stdio server is spawned BY the CLI process and INHERITS its
 *   environment (verified with an env-dumping probe server), so the Arij
 *   channel works like omp's: install.sh registers a static `arij` entry
 *   with no env, and the per-session ARIJ_* values ride the child env
 *   (buildEnv). Without injection the shim finds no ARIJ_BASE_URL and
 *   exits; agy just reports the server as failed, quietly.
 * - Tool names: agy flattens MCP tools to their BARE names — the agent sees
 *   `get_ticket`, not `mcp__arij__get_ticket` (claude/codex) nor
 *   `mcp__arij_get_ticket` (omp). arijMcpToolPrefix returns "" for agy; a
 *   prefixed spelling in a prompt would name a tool that does not exist.
 * - analyze mode runs with the default (full) posture: agy has no tool
 *   allowlist flag, and `--mode plan` would block the arji.json write the
 *   mode exists for. Wider than pi's write-only analyze; accepted, same
 *   worktree containment as code mode.
 *
 * RESIDUAL EXPOSURE, accepted (same as omp): the per-session MCP token
 * lands in the child's process env, where the agent's own shell commands
 * inherit it. Local-only, scoped to one session's board access, revoked at
 * session end.
 *
 * Oversized prompts: none of agy's out-of-band prompt transports are wired
 * yet (its stream-json stdin mode pairs with a different output format), so
 * a prompt past the argv cap fails with the base class's readable E2BIG
 * message rather than being silently truncated.
 */

import { BaseCliProvider } from "./base-provider";
import { arijChannelSpec } from "./types";
import { buildProviderOptionArgs } from "./options-registry";
import type {
  BaseProviderChunkCallbacks,
  ProviderExitInfo,
} from "./base-provider";
import type { StreamLogContext } from "@/lib/claude/logger";
import type {
  ProviderResult,
  ProviderSpawnOptions,
  ProviderType,
} from "./types";

/** Parsed shape of agy's `--output-format json` envelope. */
export interface AgyJsonEnvelope {
  conversationId?: string;
  status?: string;
  response?: string;
}

/**
 * agy prints exactly one JSON object on stdout, but startup noise (update
 * hints, MCP warnings) can precede it — scan lines for the envelope.
 */
export function parseAgyEnvelope(stdout: string): AgyJsonEnvelope | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      if (!("status" in obj) && !("conversation_id" in obj)) continue;
      return {
        conversationId:
          typeof obj.conversation_id === "string"
            ? obj.conversation_id
            : undefined,
        status: typeof obj.status === "string" ? obj.status : undefined,
        response: typeof obj.response === "string" ? obj.response : undefined,
      };
    } catch {
      // not the envelope — keep scanning
    }
  }
  return null;
}

export class AgyProvider extends BaseCliProvider {
  readonly type: ProviderType = "agy";

  get binaryName(): string {
    return "agy";
  }

  buildArgs(options: ProviderSpawnOptions): string[] {
    const { prompt, mode, model, cwd, cliSessionId, resumeSession, cliOptions } =
      options;

    const args: string[] = [
      "--output-format",
      "json",
      // agy's print default (5m) is far below a real build session; the
      // process manager and its own stall detection own the real timeouts.
      "--print-timeout",
      "24h",
    ];

    // Anchor the workspace to the worktree — measured: without this, agy
    // writes relative files into $HOME, not the process cwd.
    if (cwd) {
      args.push("--add-dir", cwd);
    }

    // Read-only postures. MCP tools stay callable under --mode plan
    // (measured), so the tool channel survives reviews and chat.
    if (mode === "plan" || mode === "chat") {
      args.push("--mode", "plan");
    }

    if (cliSessionId && resumeSession) {
      args.push("--conversation", cliSessionId);
    }

    if (model) {
      args.push("--model", model);
    }

    args.push(
      ...buildProviderOptionArgs("agy", cliOptions, {
        resume: !!(cliSessionId && resumeSession),
      }),
    );

    args.push("-p", prompt);
    return args;
  }

  /**
   * The child env is agy's only per-spawn MCP surface: the static `arij`
   * mcp_config.json entry carries no env of its own, and the shim it spawns
   * inherits the CLI's environment (measured). Same toolset-selector hygiene
   * as omp: the shim keys on the PRESENCE of ARIJ_MCP_TOOLSET, so a value
   * inherited from the Arij server's own environment must not leak through
   * when the channel itself sets none.
   */
  buildEnv(options: ProviderSpawnOptions): NodeJS.ProcessEnv {
    const env = super.buildEnv(options);
    if (!options.mcp) return env;
    // Only the ARIJ control channel's env — agy's extra servers come from its
    // user-global register (`agy mcp add`), never from the child environment,
    // which the agent's own shell can read.
    const arijEnv = arijChannelSpec(options.mcp).env;
    const merged = { ...env, ...arijEnv };
    if (!("ARIJ_MCP_TOOLSET" in arijEnv)) {
      delete merged.ARIJ_MCP_TOOLSET;
    }
    return merged;
  }

  extractResult(stdout: string): string {
    const envelope = parseAgyEnvelope(stdout);
    if (envelope?.response !== undefined) return envelope.response.trim();
    return stdout.trim();
  }

  parseSessionId(
    stdout: string,
    stderr: string,
    fallbackId?: string,
  ): string | undefined {
    return (
      parseAgyEnvelope(stdout)?.conversationId ??
      parseAgyEnvelope(stderr)?.conversationId ??
      fallbackId
    );
  }

  protected buildSpawnErrorMessage(err: Error): string {
    return err.message.includes("ENOENT")
      ? "Antigravity CLI not found. Ensure `agy` is installed and on PATH."
      : `Failed to spawn Antigravity CLI: ${err.message}`;
  }

  protected buildExitError(
    code: number | null,
    stdout: string,
    stderr: string,
  ): string {
    const combined = stderr + "\n" + stdout;
    if (/not logged in|sign in|unauthenticated|authentication required/i.test(combined)) {
      return "Antigravity is not authenticated. Run `agy` once interactively to sign in.";
    }
    const envelope = parseAgyEnvelope(stdout);
    if (envelope?.status && envelope.status !== "SUCCESS") {
      return (
        envelope.response?.trim() ||
        `Antigravity run ended with status ${envelope.status}.`
      );
    }
    return stderr.trim() || `Antigravity CLI exited with code ${code}`;
  }

  /**
   * A zero exit is not proof of success: trust the envelope's own status
   * when it says otherwise (mirrors the pi-family downgrade).
   */
  protected handleExit(
    info: ProviderExitInfo,
    callbacks: BaseProviderChunkCallbacks,
    logCtx: StreamLogContext | null,
  ): ProviderResult {
    const result = super.handleExit(info, callbacks, logCtx);
    if (!result.success) return result;

    const envelope = parseAgyEnvelope(info.stdout);
    if (envelope?.status && envelope.status !== "SUCCESS") {
      return {
        ...result,
        success: false,
        error:
          envelope.response?.trim() ||
          `Antigravity run ended with status ${envelope.status}.`,
      };
    }
    return result;
  }
}
