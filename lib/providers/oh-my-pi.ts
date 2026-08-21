/**
 * Oh My Pi provider — wraps the `omp` CLI (github.com/can1357/oh-my-pi).
 *
 * Oh My Pi started life as a pi extension, but has since become a standalone
 * fork of pi: its own compiled `omp` binary, its own session store
 * (~/.omp/agent), no `pi` install required. The `--mode json` event stream is
 * unchanged from pi (verified live against omp 17.2.1: same
 * `{"type":"session",…}` header, same message_start/message_end shapes), so
 * event parsing, result extraction and failure detection are all inherited
 * from PiProvider.
 *
 * CLI: omp --mode json [--tools <allowlist>] [--resume <ID>] [--model <M>] -p <PROMPT>
 *
 * (omp's `-p` is a boolean `--print` flag with the prompt as a positional
 * argument, so the argv shape happens to match pi's `-p <PROMPT>` exactly.)
 *
 * Divergences from pi, each overridden below:
 * - binary: `omp`, not `pi` — no extension flag, the orchestrator IS the CLI
 * - resume: `--resume <ID>` (omp has no `--session` flag); resuming re-emits
 *   the session header with the SAME id, so the stored id stays stable
 * - read-only tools: omp ships `glob` instead of pi's `find`/`ls`
 * - MCP: pi has none; omp reads mcp.json with ${VAR} expansion at load time,
 *   so the Arij tool channel rides the child's environment (buildEnv).
 *   Measured on 17.2.1: MCP tools are ORTHOGONAL to the `--tools` allowlist
 *   — they stay mounted (as xd:// devices invoked through the `write`
 *   built-in) even under `--tools read,grep,glob`, and putting an MCP name
 *   into `--tools` is a fatal argv error ("Unknown tools in --tools") that
 *   kills the spawn. So review sessions keep the channel with no flag work
 *   at all. See docs/architecture/mcp-provider-matrix.md.
 */

import { PiProvider } from "./pi";
import type { ProviderSpawnOptions, ProviderType } from "./types";

/** omp built-ins that cannot modify the working tree. */
export const OMP_READONLY_TOOLS = ["read", "grep", "glob"];

export class OhMyPiProvider extends PiProvider {
  readonly type: ProviderType = "oh-my-pi";

  get binaryName(): string {
    return "omp";
  }

  protected get cliDisplayName(): string {
    return "Oh My Pi";
  }

  protected readonlyTools(): string[] {
    return OMP_READONLY_TOOLS;
  }

  /**
   * omp takes no per-spawn MCP flag: the `arij` entry install.sh writes into
   * ~/.omp/agent/mcp.json references ${ARIJ_MCP_TOKEN}, ${ARIJ_BASE_URL} and
   * ${ARIJ_MCP_TOOLSET:-agent}, and omp expands them when it loads the file
   * — the child's environment is the only seam the per-session values can
   * ride. Without `options.mcp` no variable is added, the entry's token
   * expands empty, and the shim exits immediately (install.sh documents
   * that as the launched-by-hand behavior).
   *
   * RESIDUAL EXPOSURE, accepted: the token lands in the child's process
   * env, where the agent's own bash subshells inherit it — unlike
   * claude-code, whose 0600 --mcp-config file keeps it out of env and argv
   * both. Same trust boundary as codex's argv exposure: local-only, scoped
   * to one session's board access, revoked when the session ends.
   */
  buildEnv(options: ProviderSpawnOptions): NodeJS.ProcessEnv {
    const env = super.buildEnv(options);
    if (!options.mcp) return env;
    const merged = { ...env, ...options.mcp.env };
    // The shim selects its toolset by key PRESENCE (agent configs emit no
    // ARIJ_MCP_TOOLSET at all), and the mcp.json entry's
    // `${ARIJ_MCP_TOOLSET:-agent}` default only applies when the key is
    // ABSENT from this env. A value inherited from the Arij server's own
    // environment would therefore silently flip every agent session's shim
    // to the chat toolset — board-wide create/update/start_build on an
    // agent token, fail-open. Only the channel's own value may pass.
    if (!("ARIJ_MCP_TOOLSET" in options.mcp.env)) {
      delete merged.ARIJ_MCP_TOOLSET;
    }
    return merged;
  }

  protected resumeArgs(cliSessionId: string): string[] {
    return ["--resume", cliSessionId];
  }

  protected notAuthenticatedMessage(): string {
    return "Oh My Pi is not authenticated. Run `omp` and use /login, or set the provider API key.";
  }

  protected buildSpawnErrorMessage(err: Error): string {
    return err.message.includes("ENOENT")
      ? "Oh My Pi CLI not found. Ensure `omp` is installed and on PATH (https://github.com/can1357/oh-my-pi)."
      : `Failed to spawn Oh My Pi CLI: ${err.message}`;
  }
}
