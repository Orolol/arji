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
 * CLI: omp --mode json [--tools <allowlist> --config <overlay>] [--resume <ID>] [--model <M>] -p <PROMPT>
 *
 * (omp's `-p` is a boolean `--print` flag with the prompt as a positional
 * argument, so the argv shape happens to match pi's `-p <PROMPT>` exactly.)
 *
 * Divergences from pi, each overridden below:
 * - binary: `omp`, not `pi` — no extension flag, the orchestrator IS the CLI
 * - resume: `--resume <ID>` (omp has no `--session` flag); resuming re-emits
 *   the session header with the SAME id, so the stored id stays stable
 * - read-only tools: omp ships `glob` instead of pi's `find`/`ls`
 * - read-only modes need MORE than the allowlist. Measured on omp 17.2.1
 *   (2026-08-21): under `--tools read,grep,glob` the `write` built-in stays
 *   force-mounted — it is the invocation surface for xd:// devices (MCP
 *   tools) — and it writes REAL files as readily as devices, so a plan or
 *   review session could modify the worktree. edit and bash are genuinely
 *   stripped; write is the only leak, and pi does not have it (no device
 *   system). `--approval-mode always-ask` closes the leak but gates device
 *   writes behind the same approval, which auto-blocks in print mode and
 *   severs the MCP channel. The fix that keeps both properties is a
 *   `--config` overlay with `tools.xdev: false`: with the device system off
 *   nothing force-mounts write, so the allowlist finally strips it, and MCP
 *   tools mount as first-class tools instead — with the exact names Arij
 *   already spells into prompts (`mcp__arij_get_ticket`, …), calls verified
 *   to reach the server.
 * - MCP: pi has none; omp reads mcp.json with ${VAR} expansion at load time,
 *   so the Arij tool channel rides the child's environment (buildEnv).
 *   Measured on 17.2.1: MCP tools are ORTHOGONAL to the `--tools` allowlist
 *   — putting an MCP name into `--tools` is a fatal argv error ("Unknown
 *   tools in --tools") that kills the spawn. So review sessions keep the
 *   channel with no flag work at all (under the xdev-off overlay they mount
 *   as first-class tools, see above).
 * - Re-probed on 18.0.5 (2026-08-26): all of the above still holds, and one
 *   thing that was ASSUMED does not. An UNSET ${ARIJ_MCP_TOKEN} does not
 *   expand to nothing — omp leaves the unresolved placeholder as a LITERAL
 *   string, which is non-empty, so a channel-less spawn used to mount every
 *   Arij tool and 401 on every call. buildEnv now supplies an explicitly
 *   empty token instead (and bin/arij-mcp.mjs refuses a placeholder value
 *   independently, for CLIs Arij does not spawn).
 *   See docs/architecture/mcp-provider-matrix.md.
 */

import { writeFileSync } from "fs";
import os from "os";
import path from "path";
import { PiProvider } from "./pi";
import type { ProviderSpawnOptions, ProviderType } from "./types";

/** omp built-ins that cannot modify the working tree. */
export const OMP_READONLY_TOOLS = ["read", "grep", "glob"];

/** config.yml overlay that turns off omp's xd:// device system. */
const OMP_READONLY_OVERLAY_CONTENT = "tools:\n  xdev: false\n";

let readonlyOverlayPath: string | null = null;

/**
 * Path of the xdev-off overlay passed via `--config` on read-only spawns.
 * Written lazily to one per-process temp file and reused by every spawn —
 * the content is a constant with no secrets, so unlike claude's mcp-config
 * temp file it needs no per-spawn identity or cleanup.
 */
function ompReadonlyOverlayPath(): string {
  if (!readonlyOverlayPath) {
    const filePath = path.join(
      os.tmpdir(),
      `arij-omp-readonly-${process.pid}.yml`,
    );
    writeFileSync(filePath, OMP_READONLY_OVERLAY_CONTENT);
    readonlyOverlayPath = filePath;
  }
  return readonlyOverlayPath;
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

  /** The allowlist alone leaves `write` mounted — see the header. */
  protected restrictedToolsExtraArgs(): string[] {
    return ["--config", ompReadonlyOverlayPath()];
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
    if (!options.mcp) return { ...env, ARIJ_MCP_TOKEN: "" };
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
