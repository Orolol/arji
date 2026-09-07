/**
 * The write-path cap on `agent_sessions.prompt`, and the marker that says
 * where the middle of a capped prompt went.
 *
 * THE STORED PROMPT IS DIAGNOSTIC. Nothing replays it: a resume hands the CLI
 * the id it minted (`validateResumeSession` reads `cli_session_id`, provider
 * and scope), a retry re-resolves the named agent and asks the dispatch route
 * to rebuild the prompt from live project state (`buildRetryDispatch`). The
 * column exists so a human can open "voir le prompt exact" and see what went
 * in, and so `stripPromptEcho` can recognise a CLI echoing its own prompt
 * back at us. Both survive an elided middle; neither needs 4.97 MB.
 *
 * Why a module of its own — the same reason as its sibling `chunk-cap.ts`:
 * the cut is `Buffer` work that belongs on the server, and the marker has to
 * be legible in the session detail, which is a client component. This file is
 * the vocabulary both ends share. It touches no database, no `fs` and no
 * `Buffer`.
 *
 * Measured on the live database (2026-09-05): 939 sessions carry a prompt,
 * 68.9 MB in total, average 71.7 KB, largest 4.97 MB. Nothing bounded it on
 * the way in — this is the storage-side counterpart to the prompt-snowball
 * budgeting `lib/claude/prompt-builder.ts` already applies on the way out.
 */

/**
 * Ceiling on the UTF-8 bytes stored for one prompt.
 *
 * 128 KiB is the knee of the measured distribution, not a round number
 * borrowed from the chunk cap: p50 is 51.0 KiB, p90 94.9 KiB, p95 122.5 KiB
 * and p96 127.5 KiB, then it breaks — p99 is 589.3 KiB and the maximum is
 * 4.97 MB. So the cap leaves 96% of prompts stored byte-exact (which also
 * keeps `stripPromptEcho` on its cheap exact-substring path) and bites only
 * the 37 rows above it, which between them hold 26.8 MB of the 68.9 MB. It
 * reclaims 22.0 MB — 32% of all stored prompt bytes — from 4% of the rows.
 *
 * Deliberately NOT tied to `SESSION_CHUNK_MAX_STORED_BYTES`: that one answers
 * "how much of one burst of agent output may be kept", this one "how much of
 * one composed prompt is worth keeping for a human to read". They would move
 * for unrelated reasons.
 */
export const SESSION_PROMPT_MAX_STORED_BYTES = 128 * 1024;

/**
 * Head and tail kept when a prompt is over the cap, in UTF-8 bytes.
 *
 * The 81/16 split is the chunk cap's, and it lands right for a prompt too:
 * the head holds the system section, the project header and the start of the
 * spec, and the tail holds the parts appended last and read hardest — the
 * task/instructions block, and the Arij tools section `process-manager.ts`
 * appends at spawn time. What an over-cap prompt has in the middle is bulk:
 * spec, memory, comment history, findings. The ~4 KiB the two leave under the
 * cap is slack for the marker, which is ~90 bytes — so a capped prompt is
 * always strictly under {@link SESSION_PROMPT_MAX_STORED_BYTES}, never one
 * marker over it.
 */
export const SESSION_PROMPT_STORED_HEAD_BYTES = 104 * 1024;
export const SESSION_PROMPT_STORED_TAIL_BYTES = 20 * 1024;

/**
 * The invariant fixed part of the marker. Derived from the cap rather than
 * spelled out, so the sentence a reader sees and the limit the code enforces
 * cannot drift apart. It says "diagnostic" out loud: someone reading a capped
 * prompt should not wonder whether the agent was handed the elided version.
 */
export const SESSION_PROMPT_ELISION_LABEL = `prompt capped by Arij at ${
  SESSION_PROMPT_MAX_STORED_BYTES / 1024
} KiB — stored for diagnostics, the agent received the whole prompt`;

/**
 * The line written between the head and the tail of a capped prompt.
 *
 * Counted in BYTES, not characters: bytes are what the cap is expressed in
 * and what the cut is measured against, and reporting characters here would
 * be a second, differently-derived number for the same elision.
 *
 * Persisted into the stored prompt and parsed back by `MARKER_ELIDED_BYTES`,
 * so the numeral is pinned to "en-US" and never follows the interface locale.
 */
export function promptElisionMarker(elidedBytes: number): string {
  return `[… ${elidedBytes.toLocaleString(
    "en-US"
  )} bytes elided — ${SESSION_PROMPT_ELISION_LABEL} …]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Source of a regular expression matching exactly what
 * {@link promptElisionMarker} writes — the digits and thousands separators
 * are the only variable part.
 *
 * Exposed as a source string rather than a shared `RegExp` on purpose: a
 * `RegExp` object carries `lastIndex`, and two callers sharing one would
 * interfere. Build your own with the helpers below.
 */
const MARKER_SOURCE = `\\[… [\\d,]+ bytes elided — ${escapeRegExp(
  SESSION_PROMPT_ELISION_LABEL
)} …\\]`;

/**
 * A fresh capturing splitter: `text.split(promptElisionMarkerSplitter())`
 * yields the surrounding text and the marker itself, interleaved, so the
 * prompt pane can style the marker without exploding the rest of a
 * six-figure-character prompt into one node per line.
 */
export function promptElisionMarkerSplitter(): RegExp {
  return new RegExp(`(${MARKER_SOURCE})`);
}

/** True when `line` is, on its own, Arij's prompt elision marker. */
export function isPromptElisionMarker(line: string): boolean {
  return new RegExp(`^${MARKER_SOURCE}$`).test(line.trim());
}

/** The two ends of a capped prompt, as they were cut. */
export interface CappedPromptParts {
  head: string;
  tail: string;
  /**
   * Bytes the cap dropped between {@link head} and {@link tail}, read back
   * out of the marker.
   *
   * Load-bearing rather than decorative: `head`, this count and `tail` add up
   * to the byte length of the prompt the CLI was actually handed, which is
   * the only thing that says where an echo of it ENDS. Matching `tail`
   * instead closes the span at the first place the prompt happens to repeat
   * its own closing lines — see `replacePromptEchoes` in
   * lib/claude/resolve-session-output.ts.
   */
  elidedBytes: number;
}

/**
 * The digits inside a marker, with the group `toLocaleString("en-US")` writes.
 * Anchored to the marker's opening so it cannot pick a number out of the
 * label.
 */
const MARKER_ELIDED_BYTES = /^\[… ([\d,]+) bytes elided/;

/**
 * Reads a stored prompt back into the two ends the cap kept, or null when the
 * prompt was stored whole.
 *
 * The inverse of the write: `head + "\n" + marker + "\n" + tail`, so the one
 * newline the writer added to each side is removed here. In the original
 * prompt `head` was immediately followed by `tail` with the elided middle in
 * between — which is what lets `stripPromptEcho` still recognise an echo of
 * the WHOLE prompt from the two ends Arij kept.
 *
 * The marker is read, not discarded: its byte count is the missing middle's
 * length, so `head.length + elidedBytes + tail.length` recovers the byte
 * length of the prompt that was stored — the metadata an echo scrub needs to
 * know where a copy of it ends.
 *
 * Requires exactly one marker (a capturing split yields three parts). A
 * prompt that itself quoted a marker would split into more, and is treated as
 * uncapped — the conservative answer, and the behaviour that predates the cap.
 */
export function splitCappedPrompt(stored: string): CappedPromptParts | null {
  const parts = stored.split(promptElisionMarkerSplitter());
  if (parts.length !== 3) return null;
  const [head, marker, tail] = parts;
  const elided = MARKER_ELIDED_BYTES.exec(marker);
  // Unreachable through the splitter, which only matches markers carrying a
  // digit group; belt and braces, because the byte count is arithmetic every
  // caller downstream trusts.
  if (!elided) return null;
  return {
    head: head.endsWith("\n") ? head.slice(0, -1) : head,
    tail: tail.startsWith("\n") ? tail.slice(1) : tail,
    elidedBytes: Number(elided[1].replaceAll(",", "")),
  };
}
