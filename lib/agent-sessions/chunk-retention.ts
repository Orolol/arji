/**
 * The marker a pruned chunk stream carries, and the matcher that recognises
 * it.
 *
 * Sibling of `chunk-cap.ts` and client-safe for the same reason: the pruner
 * imports `@/lib/db`, so it can never be pulled into a client bundle, but the
 * session detail is exactly where a reader has to be told why a transcript
 * now starts in the middle of a sentence. This file is the vocabulary both
 * ends share — no database, no `fs`, no `Buffer`.
 *
 * Written by the retention routine (`lib/routines/retention.ts`), which keeps
 * only the tail of each stream for a terminal session past its window. The
 * marker is the FIRST thing in what survives, never the last: everything
 * after it is the untouched tail, so a reader can trust the closing lines.
 */

/** The invariant part of the marker, so the sentence and the code agree. */
export const SESSION_CHUNK_PRUNE_LABEL = "pruned by Arij data retention";

/**
 * The line written where a retained tail was cut out of the stream.
 *
 * Counted in CHARACTERS, not bytes: the retention tail budgets are character
 * budgets (`readChunkTail` slices characters), and reporting bytes here would
 * be a second, differently-derived number for the same elision.
 */
export function chunkPruneMarker(prunedChars: number, prunedAt: string): string {
  return `[… ${prunedChars.toLocaleString(
    "en-US",
  )} earlier characters ${SESSION_CHUNK_PRUNE_LABEL} on ${prunedAt} …]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Source of a regular expression matching exactly what
 * {@link chunkPruneMarker} writes. A source string rather than a shared
 * `RegExp`, for the reason `chunk-cap.ts` gives: a `RegExp` object carries
 * `lastIndex` and two callers sharing one would interfere.
 */
const MARKER_SOURCE = `\\[… [\\d,]+ earlier characters ${escapeRegExp(
  SESSION_CHUNK_PRUNE_LABEL,
)} on [^\\]]+ …\\]`;

/**
 * A fresh capturing splitter, the counterpart of
 * `chunkElisionMarkerSplitter`: `text.split(chunkPruneMarkerSplitter())`
 * yields the surrounding text and the markers themselves, interleaved, so the
 * session detail can style Arij's own voice without exploding the rest of a
 * megabyte-sized page into one node per line.
 */
export function chunkPruneMarkerSplitter(): RegExp {
  return new RegExp(`(${MARKER_SOURCE})`);
}

/** True when `line` is, on its own, one of Arij's retention markers. */
export function isChunkPruneMarker(line: string): boolean {
  return new RegExp(`^${MARKER_SOURCE}$`).test(line.trim());
}
