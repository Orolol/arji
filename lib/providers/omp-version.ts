/**
 * The omp version gate — the single precondition behind every restricted omp
 * spawn, shared by the one-shot provider (`OhMyPiProvider.preflight`) and the
 * persistent RPC runner (`ompAdapter.preflight`).
 *
 * WHY THIS EXISTS
 *
 * Arij expresses omp's capability entirely through the `--tools` allowlist:
 * plan/chat sessions get `read,grep,glob`, analyze adds `write`, and code mode
 * passes no flag at all. For the restricted modes that allowlist is the WHOLE
 * isolation mechanism — there is no permission system to fall back on.
 *
 * That mechanism is version-dependent, and was measured failing:
 *
 *   omp 17.2.1 (2026-08-21) — under `--tools read,grep,glob` the `write`
 *     built-in stayed force-mounted as the invocation surface for xd:// devices,
 *     and it wrote REAL files as readily as devices. A plan or review session
 *     could modify the worktree.
 *   omp 18.0.6 (2026-08-28) — `write` is gone from the registry under the same
 *     allowlist, measured with a live stdio MCP server mounted so the device
 *     surface was not vacuously empty. The allowlist is honoured exactly.
 *
 * 18.0.5 sits between the two and was never probed for this property, so it is
 * treated as unproven, i.e. unsafe. Arij launches whatever `omp` is on PATH, so
 * without this gate a user on an older install silently gets a writable
 * "read-only" session. Refusing is the conservative half of that trade: a
 * loud, actionable failure instead of a silent repository-safety hole.
 *
 * FAIL-CLOSED, WITH ONE EXCEPTION
 *
 * A version that cannot be read is refused just like an old one — an
 * unparseable `omp --version` is not evidence of safety. The exception is a
 * MISSING binary: nothing runs, so there is no isolation to protect, and the
 * spawn's own "CLI not found" message is the more useful error.
 *
 * Re-probe on each omp upgrade, as with the rest of the contract, and move
 * OMP_MIN_ALLOWLIST_VERSION only against a fresh measurement.
 * See docs/architecture/mcp-provider-matrix.md.
 */

import { execFileSync } from "child_process";

/**
 * First omp release measured to honour `--tools` for the tools Arij withholds.
 * Anything below this — including the unprobed 18.0.5 — is refused.
 */
export const OMP_MIN_ALLOWLIST_VERSION = "18.0.6";

/** Outcome of reading `omp --version`. */
export type OmpVersionProbe =
  | { status: "ok"; version: string }
  /** `omp` is not on PATH — the spawn's own ENOENT message is better. */
  | { status: "absent" }
  /** The binary is there but did not yield a version. */
  | { status: "unreadable"; detail: string };

interface ParsedVersion {
  parts: [number, number, number];
  /** A prerelease tag makes the version LOWER than the same release triple. */
  prerelease: boolean;
}

/**
 * Pulls a semantic version out of omp's `--version` output (`omp/18.0.6`).
 * Deliberately lenient about the surrounding text so a cosmetic change to the
 * banner does not become a hard refusal, and deliberately strict about the
 * triple itself.
 */
export function parseOmpVersion(raw: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(raw);
  return match ? match[0] : null;
}

function parseParts(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
}

/**
 * True when `version` is at least OMP_MIN_ALLOWLIST_VERSION, i.e. when the
 * `--tools` allowlist can be trusted to actually withhold a tool. An
 * unparseable version is not trusted.
 */
export function ompAllowlistIsEnforced(
  version: string,
  minimum: string = OMP_MIN_ALLOWLIST_VERSION,
): boolean {
  const found = parseParts(version);
  const floor = parseParts(minimum);
  if (!found || !floor) return false;
  for (let i = 0; i < 3; i++) {
    if (found.parts[i] > floor.parts[i]) return true;
    if (found.parts[i] < floor.parts[i]) return false;
  }
  // Same release triple: an 18.0.6-rc build predates 18.0.6 itself.
  return !found.prerelease;
}

/**
 * Only a trusted verdict is memoised. A refusal is re-probed on the next spawn
 * so that a user who reacts to the error by running `omp update` is unblocked
 * without restarting the Arij server.
 */
let trustedVersion: string | null = null;

/** Reads `omp --version`. Never throws. */
export function probeOmpVersion(): OmpVersionProbe {
  if (trustedVersion) return { status: "ok", version: trustedVersion };
  let output: string;
  try {
    output = execFileSync("omp", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { status: "absent" };
    const detail =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    return { status: "unreadable", detail };
  }
  const version = parseOmpVersion(output ?? "");
  if (!version) {
    const shown = (output ?? "").trim().split("\n")[0] ?? "";
    return {
      status: "unreadable",
      detail: shown ? `unrecognised output ${JSON.stringify(shown)}` : "no output",
    };
  }
  if (ompAllowlistIsEnforced(version)) trustedVersion = version;
  return { status: "ok", version };
}

/**
 * The reason a restricted omp spawn must not start, or `null` when it may.
 *
 * Call this from every path that hands omp a `--tools` allowlist and relies on
 * it: one-shot plan/chat/analyze sessions and the persistent RPC chat runner.
 * Code-mode spawns pass no allowlist, claim no isolation, and are not gated.
 */
export function ompRestrictedToolsBlockReason(): string | null {
  const probe = probeOmpVersion();

  // Not installed: let the spawn fail with its own "CLI not found" message.
  if (probe.status === "absent") return null;

  if (probe.status === "unreadable") {
    return (
      `Could not determine the Oh My Pi version, so Arij will not start a ` +
      `tool-restricted omp session: read-only isolation relies on omp ` +
      `${OMP_MIN_ALLOWLIST_VERSION} or newer honouring the \`--tools\` ` +
      `allowlist, and earlier releases keep \`write\` mounted despite it. ` +
      `\`omp --version\` failed: ${probe.detail}. Repair the omp install or ` +
      `upgrade it with \`omp update\`, then retry.`
    );
  }

  if (!ompAllowlistIsEnforced(probe.version)) {
    return (
      `Oh My Pi ${probe.version} is too old for a tool-restricted Arij ` +
      `session: only omp ${OMP_MIN_ALLOWLIST_VERSION} and newer are measured ` +
      `to honour the \`--tools\` allowlist. Earlier releases keep the ` +
      `\`write\` tool mounted despite \`--tools read,grep,glob\`, so a plan, ` +
      `chat, review or analyze session could modify the worktree. Upgrade omp ` +
      `with \`omp update\` (or install ${OMP_MIN_ALLOWLIST_VERSION}+) and retry.`
    );
  }

  return null;
}

/** Test-only: drop the memoised trusted version. */
export function resetOmpVersionProbeForTests(): void {
  trustedVersion = null;
}
