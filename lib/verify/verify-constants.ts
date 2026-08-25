/**
 * Client-safe settings contract for Arij's deterministic verification stage.
 *
 * This module deliberately has no database or other server-only import. The
 * settings UI and server-side verification runner must agree on the exact
 * keys, value shapes and fallback behaviour without pulling SQLite into the
 * client bundle.
 */

/** Global settings key containing the ordered commands Arij should run. */
export const VERIFY_COMMANDS_SETTING_KEY = "verify_commands";

/** Global settings key containing the hard timeout for each command. */
export const VERIFY_TIMEOUT_MS_SETTING_KEY = "verify_timeout_ms";

/** Ten minutes per command unless a project or global setting overrides it. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

export interface VerifyCommand {
  name: string;
  command: string;
}

/** Persisted outcome of one human-configured command. */
export interface VerifyCommandResult extends VerifyCommand {
  /** Null when the command timed out or could not be started. */
  exitCode: number | null;
  durationMs: number;
  /** Bounded, interleaved stdout/stderr tail. */
  tail: string;
}

/** Client-safe shape returned by the manual verification endpoint. */
export interface VerificationReport {
  id: string;
  projectId: string;
  epicId: string;
  agentSessionId: string | null;
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  commands: VerifyCommandResult[];
}

/** Runtime guard for one persisted command outcome. */
export function isVerifyCommandResult(
  entry: unknown,
): entry is VerifyCommandResult {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const command = entry as Record<string, unknown>;
  return (
    typeof command.name === "string" &&
    typeof command.command === "string" &&
    (typeof command.exitCode === "number" || command.exitCode === null) &&
    typeof command.durationMs === "number" &&
    typeof command.tail === "string"
  );
}

/** Runtime guard for the JSON report returned to client components. */
export function isVerificationReport(value: unknown): value is VerificationReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (
    typeof report.id !== "string" ||
    typeof report.projectId !== "string" ||
    typeof report.epicId !== "string" ||
    (report.agentSessionId !== null &&
      typeof report.agentSessionId !== "string") ||
    (report.status !== "pass" && report.status !== "fail") ||
    typeof report.startedAt !== "string" ||
    typeof report.finishedAt !== "string" ||
    !Array.isArray(report.commands)
  ) {
    return false;
  }

  return report.commands.every(isVerifyCommandResult);
}

/**
 * No commands is the safe default and keeps the pre-verification pipeline
 * behaviour unchanged. This is intentionally an array (rather than a
 * built-in test command): Arij never guesses which project command to run.
 */
export const DEFAULT_VERIFY_COMMANDS: readonly VerifyCommand[] = Object.freeze(
  [] as VerifyCommand[]
);

/** Per-project override for {@link VERIFY_COMMANDS_SETTING_KEY}. */
export function verifyCommandsSettingKey(projectId: string): string {
  return `${VERIFY_COMMANDS_SETTING_KEY}:${projectId}`;
}

/** Per-project override for {@link VERIFY_TIMEOUT_MS_SETTING_KEY}. */
export function verifyTimeoutMsSettingKey(projectId: string): string {
  return `${VERIFY_TIMEOUT_MS_SETTING_KEY}:${projectId}`;
}

/**
 * Decode the value shape returned by GET /api/settings or stored by its PATCH
 * counterpart. The second pass also tolerates a JSON array entered through a
 * string-based settings control and consequently encoded twice.
 */
function decodeJsonSetting(value: unknown): unknown {
  let parsed = value;
  for (let pass = 0; pass < 2 && typeof parsed === "string"; pass += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

/**
 * Parses the configured command list.
 *
 * `null` means absent or invalid and tells the resolver to fall through to
 * the next level. An empty array is deliberately valid: it lets one project
 * disable verification even when commands are configured globally.
 */
export function parseVerifyCommands(value: unknown): VerifyCommand[] | null {
  const parsed = decodeJsonSetting(value);
  if (!Array.isArray(parsed)) return null;

  const commands: VerifyCommand[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }

    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.command !== "string"
    ) {
      return null;
    }

    const name = candidate.name.trim();
    const command = candidate.command.trim();
    if (!name || !command) return null;
    commands.push({ name, command });
  }

  return commands;
}

/**
 * Parses a positive per-command timeout in milliseconds. Invalid values are
 * tri-state `null`, so a bad project override can still fall through to a
 * valid global setting and ultimately to the ten-minute default.
 */
export function parseVerifyTimeoutMs(value: unknown): number | null {
  const parsed = decodeJsonSetting(value);
  const timeout =
    typeof parsed === "number"
      ? parsed
      : typeof parsed === "string" && parsed.trim() !== ""
        ? Number(parsed)
        : NaN;

  if (!Number.isFinite(timeout) || timeout <= 0) return null;
  const rounded = Math.round(timeout);
  return rounded > 0 ? rounded : null;
}

export interface VerifyConfig {
  /** Derived from commands; false is the bit-for-bit passthrough path. */
  enabled: boolean;
  commands: readonly VerifyCommand[];
  timeoutMs: number;
}

/**
 * Client-safe resolver over a settings map returned by GET /api/settings.
 * With a project id it walks project value → global value → built-in default;
 * without one it resolves the global Settings form against the defaults.
 */
export function resolveVerifyConfig(
  settings: Record<string, unknown> | null | undefined,
  projectId?: string | null
): VerifyConfig {
  const map = settings ?? {};

  const pick = <T>(
    projectKey: string | null,
    globalKey: string,
    parse: (value: unknown) => T | null,
    fallback: T
  ): T => {
    if (projectKey !== null) {
      const projectValue = parse(map[projectKey]);
      if (projectValue !== null) return projectValue;
    }
    const globalValue = parse(map[globalKey]);
    return globalValue ?? fallback;
  };

  const commands = pick(
    projectId ? verifyCommandsSettingKey(projectId) : null,
    VERIFY_COMMANDS_SETTING_KEY,
    parseVerifyCommands,
    DEFAULT_VERIFY_COMMANDS
  );

  return {
    enabled: commands.length > 0,
    commands,
    timeoutMs: pick(
      projectId ? verifyTimeoutMsSettingKey(projectId) : null,
      VERIFY_TIMEOUT_MS_SETTING_KEY,
      parseVerifyTimeoutMs,
      DEFAULT_VERIFY_TIMEOUT_MS
    ),
  };
}
