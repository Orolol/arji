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
   * Hard ceiling on the chunk rows one run may delete, leaving the rest for
   * the next daily pass. Scanning is cheap and index-backed; deleting
   * hundreds of thousands of rows in one synchronous pass on the shared
   * better-sqlite3 connection is not.
   *
   * A ceiling on the RUN, not a checkpoint between sessions: one session held
   * 1,715 chunks on the live database, so a budget only consulted before each
   * session would let a single session overshoot it by three orders of
   * magnitude and hold the connection for the whole of it. The allowance is
   * threaded down into each stream and bounds the DELETE itself.
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
  /**
   * True when `maxDeletedChunks` stopped the run with work left over — either
   * before a session it never opened, or part-way through one it did.
   */
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
  /** The run's delete allowance, not the retained tail, is what stopped here. */
  budgetExhausted: boolean;
}

const UNCHANGED_STREAM: StreamPruneOutcome = {
  deletedChunks: 0,
  truncatedChunks: 0,
  reclaimedChars: 0,
  budgetExhausted: false,
};

const BUDGET_STOPPED_STREAM: StreamPruneOutcome = {
  ...UNCHANGED_STREAM,
  budgetExhausted: true,
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

  /**
   * Prune one stream down to its retained tail, deleting at most `allowance`
   * rows.
   *
   * The allowance is the run's remaining delete budget, and it is the reason
   * this does not simply delete everything older than the boundary. When it
   * cannot afford the whole older run, it deletes the `allowance` OLDEST rows
   * instead and moves the marker onto the oldest survivor — so the stream is
   * left in the same shape a full prune leaves it in, just further from the
   * end: a marker saying what went, and untouched content after it. The next
   * daily pass carries on from there.
   *
   * The retained tail is never at risk from a partial pass: it deletes a
   * subset of what a full pass would, so a tail that survives the full cut
   * survives this one a fortiori.
   */
  function pruneStream(
    sessionId: string,
    streamType: AgentSessionStreamType,
    budget: number,
    prunedAt: string,
    allowance: number,
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

    const deletable = Math.min(older.length, Math.max(0, allowance));
    // Rows to delete and no allowance to delete them with. Rewriting the
    // boundary now would write a marker for an elision that has not happened.
    if (older.length > 0 && deletable === 0) return BUDGET_STOPPED_STREAM;

    // `older` is newest-first, so its LAST `deletable` entries are the oldest
    // rows in the stream — the end a prune eats from. Index -1 means the whole
    // older run went and the boundary itself is the oldest survivor, which is
    // the only case where trimming it down to its tail is in order.
    const survivorIndex = older.length - deletable - 1;
    const anchor = survivorIndex >= 0 ? older[survivorIndex] : boundary;
    const truncate = survivorIndex < 0 && worthTruncating;
    const deletedRows = older.slice(older.length - deletable);

    const content = chunkContent(anchor.id);
    const retainedContent = truncate
      ? sliceTail(content, neededFromBoundary)
      : content;
    const deletedChars =
      deletedRows.reduce((sum, row) => sum + row.chars, 0) +
      (content.length - retainedContent.length);

    // The marker is the FIRST thing that survives, so everything after it is
    // untouched tail and a reader can trust the closing lines. Its own
    // characters are netted out of the reported saving.
    const marker = chunkPruneMarker(deletedChars, prunedAt);
    rewriteChunkContent.run(`${marker}\n${retainedContent}`, anchor.id);

    const deletedChunks =
      deletable > 0
        ? deleteOlderChunks.run(sessionId, streamType, anchor.sequence).changes
        : 0;

    return {
      deletedChunks,
      truncatedChunks: truncate ? 1 : 0,
      reclaimedChars: deletedChars - (marker.length + 1),
      budgetExhausted: deletable < older.length,
    };
  }

  function pruneSession(
    session: EligibleSessionRow,
    options: SessionChunkPruneOptions,
    allowance: number,
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
    let budgetExhausted = false;
    for (const streamType of PRUNED_STREAM_TYPES) {
      // Spent down as the streams are walked: the three of them share ONE
      // allowance, so a session cannot exceed the run's budget by walking
      // three streams that each respect it separately.
      const outcome = pruneStream(
        session.id,
        streamType,
        options.tailChars[streamType],
        options.prunedAt,
        allowance - deletedChunks,
      );
      deletedChunks += outcome.deletedChunks;
      truncatedChunks += outcome.truncatedChunks;
      reclaimedChars += outcome.reclaimedChars;
      if (outcome.budgetExhausted) budgetExhausted = true;
    }

    return {
      deletedChunks,
      truncatedChunks,
      reclaimedChars,
      budgetExhausted,
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
        const allowance = options.maxDeletedChunks - result.deletedChunks;
        if (allowance <= 0) {
          result.reachedDeleteBudget = true;
          break;
        }
        result.scannedSessions += 1;

        // One session at a time: an interrupted run can leave earlier
        // sessions pruned and later ones untouched, but never a stream whose
        // head is gone and whose survivor carries no marker.
        const outcome = database.transaction(() =>
          pruneSession(session, options, allowance),
        )();

        result.deletedChunks += outcome.deletedChunks;
        result.truncatedChunks += outcome.truncatedChunks;
        result.reclaimedChars += outcome.reclaimedChars;
        if (outcome.preservedLastText) result.preservedLastTexts += 1;
        if (outcome.deletedChunks > 0 || outcome.truncatedChunks > 0) {
          result.prunedSessions += 1;
        }
        // The allowance ran out INSIDE this session. Stopping here rather
        // than opening the next one keeps `scannedSessions` honest: a session
        // this run never had the budget to touch was not examined.
        if (outcome.budgetExhausted) {
          result.reachedDeleteBudget = true;
          break;
        }
      }

      return result;
    },
  };
}
