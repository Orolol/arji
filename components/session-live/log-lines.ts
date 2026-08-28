/**
 * Pure helpers behind the LIVE LOG terminal card. No React, no fetch — every
 * one of them is a function of its arguments, so they are unit-tested
 * directly in `__tests__/session-live-log-lines.test.ts`.
 */

/**
 * The line grammar the frames draw, plus two the caller supplies:
 * `live` (assigned to the trailing line of a running session, never returned
 * by the classifier) and `plain` (dim mono with no glyph — everything the
 * classifier is not sure about).
 */
export type LogLineKind =
  | "done"
  | "command"
  | "summary"
  | "live"
  | "error"
  | "plain";

/** `$ ` — a shell command. `TimelineLine` re-adds the prefix glyph. */
const COMMAND_PREFIX = /^\s*\$\s+/;
/** U+2713 — a completed step. */
const DONE_PREFIX = /^\s*✓\s+/;
/** U+00B7 — a summary / test-result line. Ink, not dim: it is the payload. */
const SUMMARY_PREFIX = /^\s*·\s+/;

/**
 * A failure line. The documented fifth kind — no frame draws one, and
 * `TimelineLine kind="error"` renders it in `--strata-you-deep`, the same
 * coral as a `−N` deletion count.
 *
 * DEVIATION FROM THE BRIEF, deliberate: the brief spells this
 * `/^\s*(?:✗|×|error|fatal|failed|ERR!)\b/i`, but a trailing `\b` after `✗`,
 * `×` or `!` can never match — all three are non-word characters, so a
 * boundary would need a word character on BOTH sides and `"✗ 2 failed"`
 * (a case the brief's own test plan requires to classify as `error`) falls
 * through to `plain`. The word boundary belongs only on the three alphabetic
 * alternatives, which do need it so that `"Errors: 0"` stays `plain`.
 */
const ERROR_PREFIX = /^\s*(?:✗|×|ERR!|(?:error|fatal|failed)\b)/i;

/**
 * Which kind a raw log line is, and the text to render for it.
 *
 * Conservative by construction: only the four glyph-led shapes the design
 * defines are recognised, everything else is `plain`. A false `✓` stamped on
 * ordinary output would be a lie about what the agent did.
 */
export function classifyLogLine(raw: string): {
  kind: LogLineKind;
  body: string;
} {
  const command = COMMAND_PREFIX.exec(raw);
  if (command) return { kind: "command", body: raw.slice(command[0].length) };

  const done = DONE_PREFIX.exec(raw);
  if (done) return { kind: "done", body: raw.slice(done[0].length) };

  const summary = SUMMARY_PREFIX.exec(raw);
  if (summary) return { kind: "summary", body: raw.slice(summary[0].length) };

  // The whole line, glyph included: an error is read verbatim.
  if (ERROR_PREFIX.test(raw)) return { kind: "error", body: raw };

  return { kind: "plain", body: raw };
}

/**
 * SQLite's `CURRENT_TIMESTAMP` writes `"YYYY-MM-DD HH:MM:SS"` in UTC with no
 * zone marker, while `agent_sessions.started_at` is a full ISO string. V8
 * parses the bare form as LOCAL time, so east of Greenwich every chunk would
 * land BEFORE the session started and every stamp would vanish. Normalise the
 * bare shape to UTC before parsing; anything else is handed to `Date` as-is.
 */
function toEpochMs(value: string): number {
  const trimmed = value.trim();
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
  const normalised = bare.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  return new Date(normalised).getTime();
}

/**
 * `mm:ss` since the session started, floored to the second, both halves
 * zero-padded to two digits — minutes may run past two (`"102:07"`).
 *
 * `null` when either timestamp is missing or unparseable, or when the delta
 * is negative. Derived PER CHUNK, not per line: `agent_session_chunks` has a
 * `created_at`, nothing stores a per-line time. The caller owns that rule.
 */
export function elapsedStamp(
  startedAt: string | null,
  at: string | null
): string | null {
  if (!startedAt || !at) return null;

  const start = toEpochMs(startedAt);
  const end = toEpochMs(at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 0) return null;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Full width of a FILES TOUCHED mini-bar, in px, at the largest file. */
export const BAR_MAX_PX = 52;

/**
 * Scale one file's added/removed counts onto the 52px mini-bar.
 *
 * The bar length is the file's share of the LARGEST total in the list, so the
 * rows read against each other; the split between the two segments is that
 * file's own added/removed ratio. A side with a non-zero count never
 * disappears — it floors at 1px — and the two together never exceed 52.
 */
export function scaleDiffBar(
  added: number,
  removed: number,
  maxTotal: number
): { addedPx: number; removedPx: number } {
  const total = added + removed;
  if (!(maxTotal > 0) || total <= 0) return { addedPx: 0, removedPx: 0 };

  const px = Math.round((total / maxTotal) * BAR_MAX_PX);

  let addedPx = added > 0 ? Math.max(1, Math.round((added / total) * px)) : 0;
  let removedPx = removed > 0 ? Math.max(1, px - addedPx) : 0;

  if (addedPx + removedPx > BAR_MAX_PX) {
    // Give the overflow back to whichever side is larger; both stay >= 1.
    if (addedPx >= removedPx) addedPx = BAR_MAX_PX - removedPx;
    else removedPx = BAR_MAX_PX - addedPx;
  }

  return { addedPx, removedPx };
}

/**
 * A trailing `+N` / `+N −M` inside a log line — `"✓ edit lib/sse/stream.ts
 * +46 −18"`. Split off so `DiffDelta` can draw the counts in the added/removed
 * colours instead of leaving them dim inside the sentence.
 *
 * Deliberately conservative: a false positive only tints a number green.
 */
const INLINE_DELTA = /\s\+(\d+)(?:\s+[−-](\d+))?\s*$/;

export function splitInlineDelta(body: string): {
  text: string;
  added: number | null;
  removed: number | null;
} {
  const match = INLINE_DELTA.exec(body);
  if (!match) return { text: body, added: null, removed: null };

  return {
    text: body.slice(0, match.index),
    added: Number(match[1]),
    removed: match[2] === undefined ? null : Number(match[2]),
  };
}
