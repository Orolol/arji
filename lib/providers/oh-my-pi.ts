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
 * - read-only modes used to need MORE than the allowlist, and no longer do.
 *   Measured on omp 17.2.1 (2026-08-21): under `--tools read,grep,glob` the
 *   `write` built-in stayed force-mounted — it is the invocation surface for
 *   xd:// devices (MCP tools) — and it wrote REAL files as readily as
 *   devices, so a plan or review session could modify the worktree. The fix
 *   was a `--config` overlay carrying `tools.xdev: false`, which turned the
 *   device system off so the allowlist could finally strip write.
 *   Re-measured on 18.0.6 (2026-08-28) with a live stdio MCP server mounted,
 *   so the device surface was NOT vacuously empty:
 *     --tools read,grep,glob              -> read, grep, glob, mcp__arij_get_ticket
 *     ... plus --config <xdev-off>.yml    -> read, grep, glob, mcp__arij_get_ticket
 *   (`dumpTools` from an `--mode rpc` `get_state`.) write is gone from the
 *   registry either way, and MCP tools already mount as first-class tools
 *   under the exact names Arij spells into prompts. The overlay changes the
 *   tool surface by nothing, so it is gone — see the `--config` note below.
 * - NO `--config`, deliberately. omp's `--config` is documented as an overlay
 *   layered over the user's config (`defaults <- global <- project <-
 *   overlays <- runtime`), and on 18.0.6 it measures that way: a deep merge
 *   that preserves modelRoles and untouched sibling keys. But a session
 *   measured it REPLACING ~/.omp/agent/config.yml on 18.0.5, which silently
 *   dropped every omp session onto a fallback local model and discarded
 *   modelRoles, agentModelOverrides and session settings with it. Arij now
 *   buys nothing from that flag (see above), so it hands omp no config file
 *   at all rather than keep a lever over the user's whole configuration.
 *   Re-probe the allowlist on each omp upgrade, as with the rest of the
 *   contract: if `write` ever comes back under `--tools read,grep,glob`,
 *   restore the isolation through something that cannot displace user config.
 * - MCP: pi has none; omp reads mcp.json with ${VAR} expansion at load time,
 *   so the Arij tool channel rides the child's environment (buildEnv).
 *   Measured on 17.2.1: MCP tools are ORTHOGONAL to the `--tools` allowlist
 *   — putting an MCP name into `--tools` is a fatal argv error ("Unknown
 *   tools in --tools") that kills the spawn. So review sessions keep the
 *   channel with no flag work at all, and they mount as first-class
 *   `mcp__arij_*` tools (see above).
 * - Re-probed on 18.0.5 (2026-08-26): all of the above still holds, and one
 *   thing that was ASSUMED does not. An UNSET ${ARIJ_MCP_TOKEN} does not
 *   expand to nothing — omp leaves the unresolved placeholder as a LITERAL
 *   string, which is non-empty, so a channel-less spawn used to mount every
 *   Arij tool and 401 on every call. buildEnv now supplies an explicitly
 *   empty token instead (and bin/arij-mcp.mjs refuses a placeholder value
 *   independently, for CLIs Arij does not spawn).
 *   See docs/architecture/mcp-provider-matrix.md.
 */

import { PiProvider } from "./pi";
import type {
  McpSpawnConfig,
  ProviderSpawnOptions,
  ProviderType,
} from "./types";

/** omp built-ins that cannot modify the working tree. */
export const OMP_READONLY_TOOLS = ["read", "grep", "glob"];

/**
 * Build the process environment used by both one-shot and persistent OMP
 * spawns. In particular, an absent channel must override any inherited token
 * with an empty value because OMP otherwise keeps ${ARIJ_MCP_TOKEN} literal.
 */
export function buildOmpSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  mcp?: McpSpawnConfig,
): NodeJS.ProcessEnv {
  if (!mcp) return { ...baseEnv, ARIJ_MCP_TOKEN: "" };
  const merged = { ...baseEnv, ...mcp.env };
  if (!("ARIJ_MCP_TOOLSET" in mcp.env)) {
    delete merged.ARIJ_MCP_TOOLSET;
  }
  return merged;
}

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
   * ride. Without `options.mcp` the entry must be actively neutralised, not
   * merely left alone — see the empty-token branch below.
   *
   * RESIDUAL EXPOSURE, accepted: the token lands in the child's process
   * env, where the agent's own bash subshells inherit it — unlike
   * claude-code, whose 0600 --mcp-config file keeps it out of env and argv
   * both. Same trust boundary as codex's argv exposure: local-only, scoped
   * to one session's board access, revoked when the session ends.
   */
  buildEnv(options: ProviderSpawnOptions): NodeJS.ProcessEnv {
    const env = super.buildEnv(options);
    // No channel for this spawn — but the global mcp.json entry is still
    // there, and omp leaves an UNRESOLVED ${ARIJ_MCP_TOKEN} as a LITERAL
    // string (measured on 18.0.5). Non-empty, so the shim would start, the
    // agent would see the full Arij toolset, and every call would come back
    // 401. Hand it an explicitly EMPTY value instead: that expands to "", the
    // shim refuses to start, and the tools never mount (also measured). This
    // is the path taken by MCP-exempt agent types, `mcp_tools_enabled: false`,
    // and every spawn with no agent_sessions row (title generation, spec
    // generation, import analysis) — and it doubles as the guard against a
    // stale ARIJ_MCP_TOKEN inherited from the Arij server's own environment.
    return buildOmpSpawnEnv(env, options.mcp);
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
