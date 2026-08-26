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
 */

import { writeFileSync } from "fs";
import os from "os";
import path from "path";
import { PiProvider } from "./pi";
import type { ProviderType } from "./types";

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
