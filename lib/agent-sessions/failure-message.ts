/**
 * Failure-message composition for agent sessions.
 *
 * A failed session must never surface to the user as a bare, meaningless
 * label ("Agent error", "Unknown error"). Providers usually supply an error
 * string (stderr, exit-code line), but two cases slip past it:
 *
 *   1. the process exits non-zero (or dies) without writing anything to
 *      stderr — the most common shape of the "agent produced no output"
 *      failure (E-arij-010);
 *   2. the dispatch route never receives a result at all (e.g. the process
 *      was lost with a server restart), so its `result?.error` is undefined.
 *
 * In both cases `lib/agent-sessions/lifecycle.ts` synthesizes an explicit
 * message from this module at the single choke point where session rows are
 * finalized, so the card, the notification and the session view all carry
 * the same honest text — and the user is told WHERE to look for the full
 * capture instead of being left with a label.
 *
 * Pure and dependency-free: the lifecycle (server-side) is the only caller
 * of the message builder; `buildSessionLogsRecord` keeps the persisted
 * session log honest when no result envelope survived.
 */

/** Result envelope of a finished provider run (structural, no import). */
export interface SessionResultLike {
  success: boolean;
  result?: string;
  error?: string | null;
  /** null only in the synthesized no-result record: duration unknown. */
  duration: number | null;
  cliSessionId?: string;
  endedWithQuestion?: boolean;
}

export interface SessionFailureMessageInput {
  /**
   * True when the session captured any text output (final result text or
   * streamed chunks) before failing. Drives the "no output at all" wording.
   */
  hadOutput: boolean;
  /**
   * Where the full process capture lives (e.g. the session's logsPath or
   * the session-view URL). Omitted when unknown — the session view still
   * keeps whatever chunks were captured.
   */
  logPath?: string | null;
}

function logHint(logPath?: string | null): string {
  const path = logPath?.trim();
  if (!path) {
    return " The session view keeps whatever output was captured (Raw Logs tab).";
  }
  return ` The full process capture is at ${path}.`;
}

/**
 * Builds the explicit error message for a failed session that carries no
 * error text of its own.
 *
 * Examples:
 *   "The agent session failed without any error message and without any
 *    output — the process exited (or was lost) without writing stderr or
 *    text. The full process capture is at /app/data/sessions/s1/logs.json."
 *
 *   "The agent session failed without an error message, but it did produce
 *    output before failing. The session view keeps it (Response tab)."
 */
export function buildSessionFailureMessage(
  input: SessionFailureMessageInput
): string {
  if (input.hadOutput) {
    return (
      "The agent session failed without an error message, but it did produce " +
      `output before failing.${logHint(input.logPath)}`
    );
  }
  return (
    "The agent session failed without any error message and without any output " +
    "— the process exited (or was lost) without writing stderr or text." +
    logHint(input.logPath)
  );
}

/**
 * The record persisted to the session's logs file.
 *
 * The dispatch routes write `JSON.stringify(result)` to `logsPath` — which
 * throws (and is silently swallowed) when `result` is `undefined`, leaving
 * the failure with NO on-disk trace at all. When the result envelope did
 * not survive, synthesize one from the terminal error so the session's
 * history is complete even for the worst case.
 */
export function buildSessionLogsRecord(
  result: SessionResultLike | undefined | null,
  terminalError?: string | null
): SessionResultLike {
  if (result) return result;
  return {
    success: false,
    error: terminalError ?? null,
    duration: null,
  };
}