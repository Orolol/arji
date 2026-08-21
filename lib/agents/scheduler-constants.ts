/**
 * Client-safe constants for the agent scheduler's per-project concurrency
 * budget. Kept separate from lib/agents/scheduler.ts (which imports the
 * database) so client components can import the setting keys without pulling
 * server modules into the bundle — same pattern as
 * lib/agent-config/review-segregation-constants.ts.
 */

/**
 * Global settings key: default "Max concurrent agents" for projects without
 * a per-project override. Stored in the key/value settings table
 * (JSON-encoded by the settings PATCH route).
 */
export const AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY = "agent_max_concurrent";

/**
 * Per-project settings key (`agent_max_concurrent:<projectId>`), following
 * the `webhook_url:<id>` convention. Overrides the global key.
 */
export function agentMaxConcurrentSettingKey(projectId: string): string {
  return `${AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY}:${projectId}`;
}

/**
 * "No cap" budget. Stored as `0` in settings (a human types 0 for unlimited)
 * and carried around as Infinity so `running < limit` needs no special case.
 */
export const UNLIMITED_MAX_CONCURRENT_AGENTS = Number.POSITIVE_INFINITY;

/**
 * Built-in fallback when neither settings key is set: no cap. Arij queues
 * nothing by default — the machine, the CLIs and the user's own judgement are
 * the limit. Set an explicit number in Agent Configuration → Runtime to get
 * a queue back.
 */
export const DEFAULT_MAX_CONCURRENT_AGENTS = UNLIMITED_MAX_CONCURRENT_AGENTS;

/** True for a budget the scheduler can gate on: a positive integer, or "no cap". */
export function isValidMaxConcurrent(value: unknown): value is number {
  return (
    value === UNLIMITED_MAX_CONCURRENT_AGENTS ||
    (typeof value === "number" && Number.isInteger(value) && value >= 1)
  );
}

/** Human-readable budget for the UI ("Unlimited" rather than "Infinity"). */
export function formatMaxConcurrent(value: number): string {
  return Number.isFinite(value) ? String(value) : "Unlimited";
}

/**
 * Parses a raw settings value (JSON-encoded string, number, or numeric
 * string) into a usable concurrency budget. Returns null for anything that is
 * neither a positive integer nor the unlimited sentinel, so callers fall
 * through to the next default.
 *
 * `0` means unlimited: a budget of literally zero would deadlock the queue,
 * and 0 is what a user types for "no limit".
 */
export function parseMaxConcurrentSetting(value: unknown): number | null {
  let parsed: unknown = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — fall through to numeric coercion
    }
  }

  const num =
    typeof parsed === "number"
      ? parsed
      : typeof parsed === "string" && parsed.trim() !== ""
        ? Number(parsed)
        : NaN;

  if (num === 0 || num === Number.POSITIVE_INFINITY) {
    return UNLIMITED_MAX_CONCURRENT_AGENTS;
  }
  if (!Number.isInteger(num) || num < 1) return null;
  return num;
}
