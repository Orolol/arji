/**
 * "Which open findings actually block this epic", as reusable SQL.
 *
 * `lib/pipeline/findings.ts` has always answered this narrowly: a
 * `review_comments` row blocks when it is open, agent-authored, prefixed
 * `[critical]`/`[major]`, and filed inside the CURRENT review stage's window.
 * Three other gates asked the much cruder question "is any row still open?"
 * — the board list query, Full Auto's merge selector, and the workflow
 * engine's `review -> done` guard.
 *
 * That gap had a permanent symptom, because nothing resolves a
 * `review_comments` row until a human approves the ticket (the pipeline
 * deliberately never auto-resolves). An epic whose newest review came back
 * APPROVED still reported "N open findings" and never reached "Ready to
 * merge", for rows the reviewer itself had classified as non-blocking, or for
 * rows a later verdict had already superseded. The ticket that could be
 * approved was the one the board refused to show as approvable.
 *
 * So the definition lives here once and every gate reads it:
 *
 *   A row blocks unless it is an agent finding the newest verdict cleared.
 *
 * Concretely a row does NOT block only when it is agent-authored AND either
 *   - its severity is below `[critical]`/`[major]` — the reviewer's own
 *     vocabulary for "not blocking", and what `approved_with_minor_issues`
 *     means; or
 *   - it predates the start of the newest review that RECORDED A VERDICT,
 *     which re-read the fixed code and did not re-report it.
 *
 * Everything else blocks, and the exclusions are as load-bearing as the rule:
 *   - a HUMAN's open review comment always blocks. It carries no severity
 *     vocabulary and it is a deliberate hold, not an agent's triage;
 *   - an agent row with no recognised prefix blocks. An unclassified concern
 *     is not a cleared one — and since the prefix match is case-sensitive,
 *     `[MAJOR]` lands here rather than passing as a superseded `[major]`;
 *   - a `[critical]` filed BY the approving review still blocks. The reviewer
 *     contradicted itself, and the finding is the more specific, human-
 *     resolvable artifact — the same rule `assessReviewOutcome` applies;
 *   - a review that deposited NO verdict never supersedes anything. See
 *     `lastVerdictBearingReviewStartedAtSql` for why absence of evidence
 *     must not read as evidence of absence.
 *
 * ## Why the cutoff is a parameter
 *
 * It was briefly a correlated scalar subquery, which reads beautifully and
 * costs a full scan of an unindexed `agent_sessions` PER CANDIDATE ROW.
 * Measured on 120 epics / 4800 sessions / 720 open findings, 30-run average:
 * 0.16 ms for the pre-change count, 102.7 ms correlated, 1.67 ms hoisted —
 * identical results, and `EXPLAIN QUERY PLAN` confirms the difference is
 * `CORRELATED SCALAR SUBQUERY` versus one `MATERIALIZE`. The board polls its
 * query on every `session:*` SSE event, so the correlated form was a
 * regression waiting on table growth.
 *
 * Callers therefore aggregate the cutoff once per epic and hand the column in.
 * `reviewVerdictWindowsByEpic` builds that subquery for the two grouped
 * callers; `readReviewVerdictWindow` reads the scalars the one per-epic
 * caller needs. Both derive from the same fragments, so neither can drift
 * into its own idea of "superseded".
 */

import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { type ArijDatabase } from "@/lib/db";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import {
  BLOCKING_FINDING_PREFIXES,
  FINDING_SEVERITY_PREFIXES,
} from "@/lib/review/finding-severity";
import {
  lastCleanVerdictReviewStartedAtSql,
  lastNegativeVerdictReviewStartedAtSql,
} from "./review-freshness";

/**
 * `SUBSTR(body, 1, n) = '[severity]'` for each prefix, OR-ed — the SQL
 * spelling of `body.startsWith(prefix)` in lib/review/finding-severity.ts.
 * `=` uses SQLite's default BINARY collation, so it is case-sensitive exactly
 * like the JavaScript check; `LIKE` would not be. The COALESCE keeps a NULL
 * body (impossible under today's NOT NULL, reachable for a row written before
 * it — SQLite does not enforce retroactively) matching nothing, so it reads as
 * unclassified and blocks rather than evaluating to NULL and slipping through.
 */
function bodyStartsWithAnySql(
  prefixes: ReadonlyArray<{ prefix: string }>
): SQL {
  const [first, ...rest] = prefixes.map(
    ({ prefix }) =>
      sql`SUBSTR(COALESCE(${reviewComments.body}, ''), 1, ${sql.raw(String(prefix.length))}) = ${prefix}`
  );
  return rest.reduce<SQL>((acc, next) => sql`${acc} OR ${next}`, first);
}

/**
 * Per-epic review-verdict windows for one project, as a joinable subquery.
 *
 * Two columns from one grouped scan, because both gates need both facts:
 *   - `cleanVerdictAt` is the supersession cutoff `blocksMergeSql` compares
 *     findings against;
 *   - `negativeVerdictAt` is what `hasStandingNegativeVerdict`
 *     (lib/kanban/merge-readiness.ts) weighs against it to decide whether a
 *     rejection is still standing.
 *
 * Left-join on `epic_id`. The project scope keeps the aggregate off every
 * other project's sessions; the join to `epics` in the caller already made
 * the result project-local, so this only narrows what SQLite has to read.
 */
export function reviewVerdictWindowsByEpic(
  database: ArijDatabase,
  projectId: string
) {
  return database
    .select({
      epicId: agentSessions.epicId,
      cleanVerdictAt: lastCleanVerdictReviewStartedAtSql().as(
        "clean_verdict_at"
      ),
      negativeVerdictAt: lastNegativeVerdictReviewStartedAtSql().as(
        "negative_verdict_at"
      ),
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.epicId} IS NOT NULL`
      )
    )
    .groupBy(agentSessions.epicId)
    .as("review_verdict_windows");
}

/**
 * Deliberately keyed exactly like the matching half of `MergeReadinessFacts`,
 * so the scalar read drops straight into `hasStandingNegativeVerdict` with no
 * adapter. An adapter is where two names for one fact start disagreeing.
 */
export interface ReviewVerdictWindow {
  /** `null` when no clean verdict has ever been recorded on the epic. */
  lastCleanVerdictReviewAt: string | null;
  /** `null` when no review has ever recorded `changes_requested`. */
  lastNegativeVerdictReviewAt: string | null;
}

/**
 * The same two windows for a single epic.
 *
 * The one per-epic caller (`buildTransitionContext`) reads them as scalars
 * rather than joining — and reads them from HERE rather than sorting session
 * rows in JavaScript, so the engine and the board cannot end up with
 * different ideas of which verdict spoke last.
 */
export function readReviewVerdictWindow(
  database: ArijDatabase,
  epicId: string
): ReviewVerdictWindow {
  // Bare aggregates return exactly one row. `.all()` rather than `.get()` to
  // match how lib/workflow/context.ts reads everything else.
  const [row] = database
    .select({
      lastCleanVerdictReviewAt: lastCleanVerdictReviewStartedAtSql(),
      lastNegativeVerdictReviewAt: lastNegativeVerdictReviewStartedAtSql(),
    })
    .from(agentSessions)
    .where(eq(agentSessions.epicId, epicId))
    .all();
  return {
    lastCleanVerdictReviewAt: row?.lastCleanVerdictReviewAt ?? null,
    lastNegativeVerdictReviewAt: row?.lastNegativeVerdictReviewAt ?? null,
  };
}

/**
 * The predicate. Combine with `status = 'open'` — this fragment says which
 * open rows count, not which rows are open.
 *
 * `cutoffAt` is the epic's supersession cutoff, normalised and never NULL:
 * pass `supersessionCutoffsByEpic(...).cutoffAt` wrapped in a COALESCE, or the
 * string from `readSupersessionCutoff`.
 */
export function blocksMergeSql(cutoffAt: SQLWrapper | string): SQL {
  return sql`(
    ${reviewComments.author} <> 'agent'
    OR ${reviewComments.author} IS NULL
    OR NOT (${bodyStartsWithAnySql(FINDING_SEVERITY_PREFIXES)})
    OR (
      (${bodyStartsWithAnySql(BLOCKING_FINDING_PREFIXES)})
      AND REPLACE(COALESCE(${reviewComments.createdAt}, ''), ' ', 'T')
          >= COALESCE(${cutoffAt}, '')
    )
  )`;
}
