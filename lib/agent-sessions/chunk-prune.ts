/**
 * Retention pruning for `agent_session_chunks`.
 *
 * Session output is the single largest thing Arij stores and nothing ever
 * removed any of it: on the live database 126,953 chunk rows hold 395.5 MB,
 * the largest single session 51.3 MB across 1,715 chunks. The write-path cap
 * bounds what one chunk may cost; this bounds how long the whole stream is
 * kept.
 *
 * What a prune keeps, and why it keeps exactly that:
 *
 *   - `agent_sessions.last_non_empty_text` — the agent's final word, read by
 *     the sessions list, the completion toast, Dreaming, memory distillation
 *     and the forensic prompt. It lives on the session ROW, so pruning chunks
 *     cannot destroy it; where a legacy row never got one, it is derived from
 *     the chunks and written BEFORE anything is deleted.
 *   - The tail of every stream, sized per stream by what depends on it (see
 *     `SESSION_CHUNK_RETAINED_TAIL_CHARS` in lib/routines/retention.ts).
 *     `readChunkTail` in lib/pipeline/forensic.ts slices the last N characters
 *     of a stream, so retaining at least N characters makes what a forensic
 *     agent reads identical before and after a prune. That is the invariant
 *     this module is built around, and the one its tests pin.
 *
 * What a prune DOES cost, stated rather than discovered later: the Arij
 * action list a session detail reconstructs by scanning the `raw` stream
 * (`lib/agent-sessions/arij-actions.ts`) is reduced to the retained tail for a
 * pruned session. The database-recorded half of that list — comments,
 * findings, artifacts, status moves — is unaffected, and it is the half that
 * carries the durable record.
 *
 * Nothing here decides which sessions are eligible beyond the caller's
 * cutoff: the terminal-status and age filters are applied in SQL below, so a
 * running or queued session is never a candidate at all.
 */

import type Database from "better-sqlite3";
import { chunkPruneMarker } from "@/lib/agent-sessions/chunk-retention";
import { extractLastNonEmptyText } from "@/lib/agent-sessions/last-text";
import type { AgentSessionStreamType } from "@/lib/agent-sessions/chunks";

/**
 * The only statuses a prune may touch. Mirrors the terminal set in
 * lib/agent-sessions/lifecycle.ts — a status with no outgoing transition.
 * A NULL status (legacy rows, which default to `queued`) is excluded by `IN`,
 * so an unclassified row is never pruned either.
 */
export const PRUNABLE_SESSION_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

/** Streams a prune walks. */
const PRUNED_STREAM_TYPES: readonly AgentSessionStreamType[] = [
  "raw",
  "output",
  "response",
];

/**
 * Do not rewrite a boundary chunk to save less than this.
 *
 * Two jobs. It stops a multi-kilobyte row being rewritten to reclaim thirty
 * characters — and, because the marker a prune writes is itself content the
 * NEXT run measures, it is what makes a prune idempotent: the second pass
 * over an already-pruned stream sees an excess of one marker, declines to cut
 * it, and reports the session as untouched.
 */
export const PRUNE_MIN_TRUNCATION_CHARS = 4096;

export interface SessionChunkPruneOptions {
  projectId: string;
  /**
   * Sessions whose terminal timestamp is at or before this ISO instant are
   * eligible. Derived by the caller from the retention window.
   */
  cutoff: string;
  /** Per-stream character budget kept for every pruned session. */
  tailChars: Record<AgentSessionStreamType, number>;
  /**
   * Stop the run once this many chunk rows have been deleted, leaving the
   * rest for the next daily pass. Scanning is cheap and index-backed;
   * deleting hundreds of thousands of rows in one synchronous pass on the
   * shared better-sqlite3 connection is not.
   */
  maxDeletedChunks: number;
  /** Stamped into the marker so a reader can date the elision. */
  prunedAt: string;
}

export interface SessionChunkPruneResult {
  /** Terminal, past-window sessions examined. */
  scannedSessions: number;
  /** Sessions where at least one stream actually shrank. */
  prunedSessions: number;
  deletedChunks: number;
  /** Boundary chunks rewritten down to their tail. */
  truncatedChunks: number;
  /** Characters of stored content removed, markers already netted out. */
  reclaimedChars: number;
  /** `last_non_empty_text` values derived from chunks about to be deleted. */
  preservedLastTexts: number;
  /** True when `maxDeletedChunks` stopped the run with work left over. */
  reachedDeleteBudget: boolean;
}

interface EligibleSessionRow {
  id: string;
  lastNonEmptyText: string | null;
}

interface StreamChunkRow {
  id: string;
  sequence: number;
  chars: number;
}

interface StreamPruneOutcome {
  deletedChunks: number;
  truncatedChunks: number;
  reclaimedChars: number;
}

const UNCHANGED_STREAM: StreamPruneOutcome = {
  deletedChunks: 0,
  truncatedChunks: 0,
  reclaimedChars: 0,
};

export interface SessionChunkPruner {
  prune(options: SessionChunkPruneOptions): SessionChunkPruneResult;
}

/**
 * A lone low surrogate at the front of a tail is a cut through the middle of
 * an astral character. Take one character MORE rather than one less, so the
 * retained tail never dips below the budget it was sized to.
 */
function sliceTail(content: string, chars: number): string {
  const tail = content.slice(-chars);
  if (tail.length >= content.length) return content;
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? content.slice(-(chars + 1)) : tail;
}

export function createSessionChunkPruner(
  database: Database.Database,
): SessionChunkPruner {
  // Prepared at construction, like the chunk store's: one prune walks three
  // streams for every terminal session in the project.
  // `REPLACE(..., ' ', 'T')` normalises the two timestamp shapes the column
  // can hold before comparing them as text. Every row written by the
  // application is ISO-8601 with a `T`, but `created_at` DEFAULTs to
  // `CURRENT_TIMESTAMP`, which SQLite renders space-separated — and
  // `'2026-09-05 10:00' <= '2026-09-05T09:00'` is true, because a space sorts
  // below `T`. Without this a same-day default-stamped row reads as older
  // than it is, and the direction of that error is deletion.
  const terminalAt =
    "REPLACE(COALESCE(ended_at, completed_at, created_at), ' ', 'T')";
  const selectEligibleSessions = database.prepare(
    `SELECT id, last_non_empty_text AS lastNonEmptyText
       FROM agent_sessions
      WHERE project_id = ?
        AND status IN (${PRUNABLE_SESSION_STATUSES.map(() => "?").join(", ")})
        AND ${terminalAt} <= ?
      ORDER BY ${terminalAt} ASC`,
  );

  const selectStreamChunks = database.prepare(
    `SELECT id, sequence, length(content) AS chars
       FROM agent_session_chunks
      WHERE session_id = ? AND stream_type = ?
      ORDER BY sequence DESC`,
  );

  const selectChunkContent = database.prepare(
    `SELECT content FROM agent_session_chunks WHERE id = ?`,
  );

  const deleteOlderChunks = database.prepare(
    `DELETE FROM agent_session_chunks
      WHERE session_id = ? AND stream_type = ? AND sequence < ?`,
  );

  // The rewritten row no longer holds the content its `chunk_key` digests, so
  // the key is dropped rather than left claiming to identify something else.
  // A terminal session takes no further appends, so nothing can dedupe
  // against it again.
  const rewriteChunkContent = database.prepare(
    `UPDATE agent_session_chunks SET content = ?, chunk_key = NULL WHERE id = ?`,
  );

  const updateLastNonEmptyText = database.prepare(
    `UPDATE agent_sessions SET last_non_empty_text = ? WHERE id = ?`,
  );

  function streamChunks(
    sessionId: string,
    streamType: AgentSessionStreamType,
  ): StreamChunkRow[] {
    return selectStreamChunks.all(sessionId, streamType) as StreamChunkRow[];
  }

  function chunkContent(chunkId: string): string {
    return (
      (selectChunkContent.get(chunkId) as { content: string } | undefined)
        ?.content ?? ""
    );
  }

  /**
   * Derive the agent's final word from the chunks about to be deleted.
   * Walks newest-first and stops at the first chunk that yields a line, so a
   * multi-megabyte stream is not read whole to answer a one-line question.
   */
  function deriveLastNonEmptyText(sessionId: string): string | null {
    for (const streamType of ["response", "output"] as const) {
      for (const row of streamChunks(sessionId, streamType)) {
        const text = extractLastNonEmptyText(chunkContent(row.id));
        if (text) return text;
      }
    }
    return null;
  }

  function pruneStream(
    sessionId: string,
    streamType: AgentSessionStreamType,
    budget: number,
    prunedAt: string,
  ): StreamPruneOutcome {
    const rows = streamChunks(sessionId, streamType);
    if (rows.length === 0) return UNCHANGED_STREAM;

    // Walk newest-first until the budget is covered. `length()` counts code
    // points where JS counts UTF-16 units, so a SQLite total that reaches the
    // budget guarantees the JS tail does too — the discrepancy only ever
    // leans towards keeping more.
    let retained = 0;
    let boundaryIndex = 0;
    for (let index = 0; index < rows.length; index += 1) {
      boundaryIndex = index;
      retained += rows[index].chars;
      if (retained >= budget) break;
    }

    const boundary = rows[boundaryIndex];
    const older = rows.slice(boundaryIndex + 1);
    const neededFromBoundary = budget - (retained - boundary.chars);
    const excessInBoundary = boundary.chars - neededFromBoundary;
    const worthTruncating = excessInBoundary >= PRUNE_MIN_TRUNCATION_CHARS;

    // Already inside its budget, give or take one marker: leave the rows —
    // and any marker an earlier run wrote — exactly as they are.
    if (older.length === 0 && !worthTruncating) return UNCHANGED_STREAM;

    const content = chunkContent(boundary.id);
    const retainedContent = worthTruncating
      ? sliceTail(content, neededFromBoundary)
      : content;
    const deletedChars =
      older.reduce((sum, row) => sum + row.chars, 0) +
      (content.length - retainedContent.length);

    // The marker is the FIRST thing that survives, so everything after it is
    // untouched tail and a reader can trust the closing lines. Its own
    // characters are netted out of the reported saving.
    const marker = chunkPruneMarker(deletedChars, prunedAt);
    rewriteChunkContent.run(`${marker}\n${retainedContent}`, boundary.id);

    const deletedChunks =
      older.length > 0
        ? deleteOlderChunks.run(sessionId, streamType, boundary.sequence)
            .changes
        : 0;

    return {
      deletedChunks,
      truncatedChunks: worthTruncating ? 1 : 0,
      reclaimedChars: deletedChars - (marker.length + 1),
    };
  }

  function pruneSession(
    session: EligibleSessionRow,
    options: SessionChunkPruneOptions,
  ): StreamPruneOutcome & { preservedLastText: boolean } {
    let preservedLastText = false;
    if (!session.lastNonEmptyText?.trim()) {
      const derived = deriveLastNonEmptyText(session.id);
      if (derived) {
        updateLastNonEmptyText.run(derived, session.id);
        preservedLastText = true;
      }
    }

    let deletedChunks = 0;
    let truncatedChunks = 0;
    let reclaimedChars = 0;
    for (const streamType of PRUNED_STREAM_TYPES) {
      const outcome = pruneStream(
        session.id,
        streamType,
        options.tailChars[streamType],
        options.prunedAt,
      );
      deletedChunks += outcome.deletedChunks;
      truncatedChunks += outcome.truncatedChunks;
      reclaimedChars += outcome.reclaimedChars;
    }

    return {
      deletedChunks,
      truncatedChunks,
      reclaimedChars,
      preservedLastText,
    };
  }

  return {
    prune(options: SessionChunkPruneOptions): SessionChunkPruneResult {
      const sessions = selectEligibleSessions.all(
        options.projectId,
        ...PRUNABLE_SESSION_STATUSES,
        options.cutoff,
      ) as EligibleSessionRow[];

      const result: SessionChunkPruneResult = {
        scannedSessions: 0,
        prunedSessions: 0,
        deletedChunks: 0,
        truncatedChunks: 0,
        reclaimedChars: 0,
        preservedLastTexts: 0,
        reachedDeleteBudget: false,
      };

      for (const session of sessions) {
        if (result.deletedChunks >= options.maxDeletedChunks) {
          result.reachedDeleteBudget = true;
          break;
        }
        result.scannedSessions += 1;

        // One session at a time: an interrupted run can leave earlier
        // sessions pruned and later ones untouched, but never a stream whose
        // head is gone and whose survivor carries no marker.
        const outcome = database.transaction(() =>
          pruneSession(session, options),
        )();

        result.deletedChunks += outcome.deletedChunks;
        result.truncatedChunks += outcome.truncatedChunks;
        result.reclaimedChars += outcome.reclaimedChars;
        if (outcome.preservedLastText) result.preservedLastTexts += 1;
        if (outcome.deletedChunks > 0 || outcome.truncatedChunks > 0) {
          result.prunedSessions += 1;
        }
      }

      return result;
    },
  };
}
