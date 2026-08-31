/**
 * The French relative age the roster prints after `PROJECT · agent ·`.
 *
 * Frame 11a draws three of the shapes — `il y a 4 min`, `hier`, `3d` — and the
 * fourth (`à l'instant`) is what the first of them degrades to. There is no
 * shared helper: `lib/utils/format-elapsed.ts` formats a RUNNING duration
 * (`4m12`, ticking) and `Chrono` renders it, which is a different thing from
 * "how old is this row". Reusing it would print a chrono on a conversation
 * nobody is running.
 *
 * The hours band (`il y a 3 h`) is an extension of the frame's own vocabulary:
 * the frame happens to sample 4 minutes, yesterday and 3 days, and something
 * has to be said between one hour and one day. Saying `il y a 180 min` is the
 * only alternative and it is worse.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * @param createdAt ISO / SQLite timestamp.
 * @param now injected so tests do not depend on the wall clock.
 * @returns the label, or `null` when the timestamp cannot be read — the caller
 *          prints an em-dash rather than guessing an age.
 */
export function relativeAge(
  createdAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!createdAt) return null;
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return null;

  // A row stamped slightly in the future (clock skew between the SQLite write
  // and the browser) is "just now", never a negative age.
  const elapsed = Math.max(0, now - at);

  if (elapsed < MINUTE_MS) return "à l'instant";
  if (elapsed < HOUR_MS) return `il y a ${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) return `il y a ${Math.floor(elapsed / HOUR_MS)} h`;

  const days = Math.floor(elapsed / DAY_MS);
  if (days === 1) return "hier";
  return `${days}d`;
}
