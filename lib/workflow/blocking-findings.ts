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
 *   - it predates the supersession cutoff: the newest code change that a
 *     recorded clean verdict has since read. See `supersessionAt`
 *     (lib/workflow/review-freshness.ts) for why BOTH halves are required —
 *     an approval on an untouched branch adjudicates nothing, and used to
 *     clear findings that were still sitting in the code it had just read.
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
 *   - a review that deposited NO verdict never supersedes anything, and
 *     neither does one that read no new code. Absence of evidence must not
 *     read as evidence of absence.
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
 * Callers therefore aggregate the cutoff once per epic and hand the column
 * in. The two grouped callers read it off `epicSessionFactsCte`, the single
 * scan that already produces their other session facts;
 * `readEpicSessionFacts` reads the scalars the one per-epic caller needs.
 * Both are built from the same projection, so neither can drift into its own
 * idea of "superseded".
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { reviewComments } from "@/lib/db/schema";
import {
  BLOCKING_FINDING_PREFIXES,
  FINDING_SEVERITY_PREFIXES,
} from "@/lib/review/finding-severity";

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
 * The predicate. Combine with `status = 'open'` — this fragment says which
 * open rows count, not which rows are open.
 *
 * `cutoffAt` is the epic's supersession cutoff, already normalised: pass
 * `epicSessionFactsCte(...).supersessionAt` from a grouped caller, or
 * `readEpicSessionFacts(...).supersessionAt ?? ""` from a per-epic one. A
 * NULL column is COALESCEd to `''` below, which supersedes nothing — the safe
 * direction.
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
