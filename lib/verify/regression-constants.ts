/**
 * Client-safe constants for the mandatory bug regression check
 * (lib/verify/regression-check.ts). Kept free of any database / server
 * import so client components (settings UI, ticket verify section) can
 * import the setting keys, defaults and parsers without pulling server
 * modules into the bundle — same convention as
 * lib/pipeline/constants.ts and lib/night/constants.ts.
 */

/* ------------------------------------------------------------------ */
/* Settings keys                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tri-state switch (boolean | "true" | "false" | anything else = not
 * configured). Default OFF: an absent key means the pipeline never runs
 * the regression check.
 */
export const BUG_REGRESSION_CHECK_SETTING_KEY = "bug_regression_check";

/**
 * Glob patterns selecting the test files the check looks for in the
 * branch diff. Stored as a JSON array of strings (a plain string is
 * accepted and treated as one pattern).
 */
export const TEST_FILE_PATTERNS_SETTING_KEY = "test_file_patterns";

/**
 * Command template run to prove green (on the branch) then red (on the
 * merge-base). `{files}` is replaced with the space-quoted detected test
 * files; a command without the placeholder cannot target the diff and is
 * rejected by the parser.
 */
export const BUG_REGRESSION_COMMAND_SETTING_KEY =
  "bug_regression_command";

/**
 * Kill threshold in milliseconds for each of the two command runs. Absent
 * or unusable falls back to {@link DEFAULT_BUG_REGRESSION_TIMEOUT_MS}.
 */
export const BUG_REGRESSION_TIMEOUT_SETTING_KEY =
  "bug_regression_timeout_ms";

export const REGRESSION_COMMAND_FILE_PLACEHOLDER = "{files}";

export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
];

export const DEFAULT_BUG_REGRESSION_COMMAND = `npx vitest run {files}`;

/** Directory prefix of the temporary detached worktree the red run uses. */
export const REGRESSION_WORKTREE_PREFIX = "regression-check-";

/** Ten minutes covers a targeted vitest run comfortably. */
export const DEFAULT_BUG_REGRESSION_TIMEOUT_MS = 10 * 60_000;

/**
 * Output signatures of a failure caused by the RUNNER never getting off the
 * ground — the binary is missing, its config would not load, it found no
 * tests, or a bare package specifier did not resolve. A non-zero exit
 * matching one of these says nothing about the test and is reported as
 * `command_error`.
 *
 * Deliberately excluded: relative module-resolution errors
 * (`Cannot find module './x'`, `ERR_MODULE_NOT_FOUND` for a project path,
 * vitest's `Failed to resolve import`). Those name a file the branch adds,
 * which makes them the EXPECTED shape of the red run — the most ordinary
 * bug fix there is adds a module and imports it from the new test, and the
 * merge-base cannot resolve it. Treating them as environmental rejected
 * genuine reproductions. On the green side the deterministic
 * `node_modules`-present fact (lib/verify/regression-check.ts) settles the
 * dependency question instead, and a relative import that fails on the
 * branch is the fix's own defect, not the environment's.
 */
export const REGRESSION_STARTUP_FAILURE_PATTERNS: readonly RegExp[] = [
  /cannot find package/i,
  /no test files found/i,
  /failed to load config/i,
  /command not found/i,
  // Anchored to a shell's own "<program>: not found" line so an assertion
  // message merely containing "not found" is not mistaken for one.
  /^\s*(?:sh|bash|zsh)(?:\[\d+\])?:\s*(?:\d+:\s*)?.*:\s*not found\s*$/im,
];

/** Normalized failure reasons reported when the red → green cycle breaks. */
export type RegressionFailureReason =
  | "no_test_in_diff"
  | "test_passes_on_base"
  | "test_fails_on_branch"
  | "command_error";

/* ------------------------------------------------------------------ */
/* Setting parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parses a raw settings value into a tri-state: null means "not
 * configured". Mirrors parsePipelineEnabledSetting.
 */
export function parseBugRegressionSetting(value: unknown): boolean | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — compared literally below
    }
  }
  if (parsed === true || parsed === "true") return true;
  if (parsed === false || parsed === "false") return false;
  return null;
}

/**
 * Parses the configured glob patterns from a raw settings value: a JSON
 * array of strings, or a single string split on commas / newlines. Null
 * when nothing usable remains — callers fall back to
 * {@link DEFAULT_TEST_FILE_PATTERNS}.
 */
export function parseTestFilePatterns(value: unknown): string[] | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — handled below
    }
  }

  let raw: string[] | null = null;
  if (Array.isArray(parsed)) {
    raw = parsed.filter((p): p is string => typeof p === "string");
  } else if (typeof parsed === "string") {
    raw = parsed
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  const cleaned = (raw ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Parses the regression command template. A template without the
 * `{files}` placeholder would run the whole suite on every invocation —
 * rejected (null) so callers fall back to
 * {@link DEFAULT_BUG_REGRESSION_COMMAND}.
 */
export function parseBugRegressionCommand(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — handled below
    }
  }
  if (typeof parsed !== "string") return null;
  const trimmed = parsed.trim();
  if (!trimmed.includes(REGRESSION_COMMAND_FILE_PLACEHOLDER)) return null;
  return trimmed;
}

/**
 * Parses the per-run command timeout. Only a finite positive number of
 * milliseconds is a timeout; anything else is null so callers fall back to
 * {@link DEFAULT_BUG_REGRESSION_TIMEOUT_MS} (a zero or negative value would
 * kill every run instantly).
 */
export function parseBugRegressionTimeoutMs(value: unknown): number | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    const raw = parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A bare "600000" written straight into the settings table.
      parsed = raw;
    }
  }
  // JSON.parse of a JSON-encoded string yields a string again.
  if (typeof parsed === "string") parsed = Number(parsed.trim());
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
  return parsed > 0 ? Math.round(parsed) : null;
}
