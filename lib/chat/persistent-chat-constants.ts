/**
 * Settings keys and parsers for the persistent chat runner.
 *
 * The parsers are pure so they can be unit-tested and so the keys are
 * discoverable from one place rather than only from the chat stream route.
 * Follows the same shape as `parseMaxConcurrentSetting`
 * (lib/agents/scheduler-constants.ts).
 */

export const PERSISTENT_CHAT_IDLE_TIMEOUT_SETTING =
  "chat_persistent_idle_timeout_ms";
export const PERSISTENT_CHAT_MAX_CONVERSATIONS_SETTING =
  "chat_persistent_max_conversations";
export const PERSISTENT_CHAT_TURN_STALL_SETTING =
  "chat_persistent_turn_stall_ms";

/**
 * Settings rows hold JSON, but hand-written rows are often bare (`900000`
 * rather than `"900000"`), so accept both before coercing.
 */
function coerceNumber(value: unknown): number | null {
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
        : null;
  return num !== null && Number.isFinite(num) ? num : null;
}

/**
 * A duration in milliseconds, or `fallback` when unset or unusable.
 *
 * Unlike the scheduler's concurrency cap, `0` is NOT "unlimited" here: a
 * zero-length idle or stall deadline would reap every process instantly, so
 * a non-positive value can only mean "leave the default alone".
 */
export function parsePersistentChatDurationSetting(
  value: unknown,
  fallback: number,
): number {
  const num = coerceNumber(value);
  return num !== null && num > 0 ? Math.floor(num) : fallback;
}

/**
 * The cap on simultaneously warm conversations, or `fallback` when unset.
 *
 * `0` is deliberately not "unlimited" either: each warm conversation holds a
 * CLI process worth a few hundred MB, so an unbounded pool is not a state a
 * user should be able to reach by typing zero.
 */
export function parsePersistentChatCapSetting(
  value: unknown,
  fallback: number,
): number {
  const num = coerceNumber(value);
  return num !== null && num >= 1 ? Math.floor(num) : fallback;
}
