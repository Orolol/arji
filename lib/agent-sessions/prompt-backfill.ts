/**
 * Retroactive application of the write-path prompt cap to
 * `agent_sessions.prompt`.
 *
 * The cap in `capSessionPrompt` (lib/agent-sessions/lifecycle.ts) stops the
 * column growing; it says nothing about what was already stored before it
 * landed. That is the second half of a size invariant, and it was briefly
 * unowned: the scheduled retention routine walks
 * `agent_session_chunks` only, so no scheduled path ever rewrote a prompt.
 *
 * Measured by running this sweep against a snapshot of the live database
 * (2026-09-05, 1,093,365,760 bytes on disk): 1,056 rows carried a prompt,
 * 78.2 MB in total, largest 5.0 MB, of which 38 rows were over the 128 KiB cap
 * and held 27.0 MB between them. The sweep capped all 38 across two projects
 * and reclaimed 22.2 MB — stored prompt bytes 78.2 MB -> 56.0 MB, largest
 * prompt 5.0 MB -> 0.1 MB, nothing left over the cap — and the VACUUM that
 * follows took 26.0 MB off the file. A second pass capped nothing, and none of
 * the rewritten rows contained U+FFFD: the boundary walk held on the real
 * multi-byte ones.
 *
 * Why a routine step and not a migration: the cut has to go through
 * `capTextHeadTail`'s UTF-8 boundary walk. SQLite's `substr()` counts
 * characters, and a hand-written `.sql` migration — which is the only kind
 * this repository has — cannot call into the shared cap. A cut that lands
 * inside a character decodes to U+FFFD, and these are real rows, some of them
 * multi-byte.
 *
 * What this does NOT cover, stated rather than discovered later: a project
 * with no enabled `retention` routine is never swept, exactly as its chunks
 * are never pruned. The routine is the unit of consent for rewriting stored
 * history, and prompts join it rather than getting a second, quieter one.
 *
 * Selection is in BYTES (`length(CAST(prompt AS BLOB))`), never `length()`.
 * `length()` on TEXT counts characters, so a 100k-character CJK prompt reads
 * as 100,000 against a 131,072 limit while actually occupying 300 KB — the
 * rows most worth capping are exactly the ones a character count hides.
 */

import type Database from "better-sqlite3";
import { capSessionPrompt } from "@/lib/agent-sessions/lifecycle";
import { SESSION_PROMPT_MAX_STORED_BYTES } from "@/lib/agent-sessions/prompt-cap";

/**
 * Rows one run may rewrite before it leaves the rest for tomorrow.
 *
 * Sized like the chunk pruner's budget and for the same reason — this runs
 * synchronously on the one better-sqlite3 connection every request shares —
 * but two orders of magnitude smaller, because the population is: 38 rows on
 * the live database against 126,953 chunk rows. 500 clears that backlog in a
 * single pass and still bounds a pathological one.
 */
export const DEFAULT_MAX_CAPPED_PROMPTS_PER_RUN = 500;

export interface SessionPromptBackfillOptions {
  projectId: string;
  /** Rows this run may rewrite, leaving any remainder for the next pass. */
  maxRows: number;
}

export interface SessionPromptBackfillResult {
  /** Rows found over the cap, up to the run's row budget. */
  scannedSessions: number;
  /** Rows actually rewritten. */
  cappedPrompts: number;
  /** Stored UTF-8 bytes removed, the elision marker already netted out. */
  reclaimedBytes: number;
  /** True when over-cap rows were left for the next run. */
  reachedRowBudget: boolean;
}

export interface SessionPromptBackfiller {
  backfill(options: SessionPromptBackfillOptions): SessionPromptBackfillResult;
}

/**
 * Rewrite this project's over-cap prompts through the shared head/tail cut.
 *
 * Idempotent for free rather than by a flag: a row the cap has already been
 * applied to is, by construction, under the cap, so the next run's selection
 * does not see it. That also means a natively capped row and a backfilled one
 * are indistinguishable — same marker, same shape — which is what lets
 * `splitCappedPrompt` and the `stripPromptEcho` capped path treat them alike.
 */
export function createSessionPromptBackfiller(
  database: Database.Database,
  capPrompt: (prompt: string) => string = capSessionPrompt,
): SessionPromptBackfiller {
  // `LIMIT ? + 1`: the extra row is how the run knows it left work behind
  // without paying for a second COUNT over the same predicate. Biggest first,
  // so a run that hits its budget has reclaimed the most bytes it could.
  const selectOversizedPrompts = database.prepare(
    `SELECT id, prompt
       FROM agent_sessions
      WHERE project_id = ?
        AND prompt IS NOT NULL
        AND length(CAST(prompt AS BLOB)) > ?
      ORDER BY length(CAST(prompt AS BLOB)) DESC
      LIMIT ?`,
  );

  const rewritePrompt = database.prepare(
    `UPDATE agent_sessions SET prompt = ? WHERE id = ?`,
  );

  return {
    backfill({
      projectId,
      maxRows,
    }: SessionPromptBackfillOptions): SessionPromptBackfillResult {
      const found = selectOversizedPrompts.all(
        projectId,
        SESSION_PROMPT_MAX_STORED_BYTES,
        maxRows + 1,
      ) as { id: string; prompt: string }[];

      const rows = found.slice(0, maxRows);
      const result: SessionPromptBackfillResult = {
        scannedSessions: rows.length,
        cappedPrompts: 0,
        reclaimedBytes: 0,
        reachedRowBudget: found.length > maxRows,
      };

      for (const row of rows) {
        const capped = capPrompt(row.prompt);
        // Defensive: the selection is the cap's own predicate, so a row that
        // comes back unchanged would mean the two disagree. Skipping the
        // write is the conservative answer either way.
        if (capped === row.prompt) continue;

        rewritePrompt.run(capped, row.id);
        result.cappedPrompts += 1;
        result.reclaimedBytes +=
          Buffer.byteLength(row.prompt, "utf8") -
          Buffer.byteLength(capped, "utf8");
      }

      return result;
    },
  };
}
