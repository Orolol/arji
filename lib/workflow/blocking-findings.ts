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
 * rows a later clean review had already superseded. The ticket that could be
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
 *   - it predates the start of the newest clean review, which re-read the
 *     fixed code and did not re-report it.
 *
 * Everything else blocks, and the exclusions are as load-bearing as the rule:
 *   - a HUMAN's open review comment always blocks. It carries no severity
 *     vocabulary and it is a deliberate hold, not an agent's triage;
 *   - an agent row with no recognised prefix blocks. An unclassified concern
 *     is not a cleared one;
 *   - a `[critical]` filed BY the approving review still blocks. The reviewer
 *     contradicted itself, and the finding is the more specific, human-
 *     resolvable artifact — the same rule `assessReviewOutcome` applies.
 *
 * Every consumer joins on `review_comments`, so the fragment is written
 * against that table and correlates to `agent_sessions` itself. That keeps it
 * usable both inside a grouped subquery (board, auto-mode) and in a plain
 * per-epic WHERE (the transition context).
 */

import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { agentSessions, reviewComments } from "@/lib/db/schema";
import {
  BLOCKING_FINDING_PREFIXES,
  FINDING_SEVERITY_PREFIXES,
} from "@/lib/review/finding-severity";
import { lastCleanReviewStartedAtSql } from "./review-freshness";

/**
 * Aliased so the correlated subquery can name its own `agent_sessions`
 * without colliding with an `agent_sessions` already in the outer query.
 * A fixed internal identifier, never user input — hence `sql.raw` below.
 */
const CLEAN_REVIEW_ALIAS = "clean_review_sessions";
const cleanReviewSessions = alias(agentSessions, CLEAN_REVIEW_ALIAS);

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
 * When the finding's own epic was last cleanly reviewed, as a correlated
 * scalar. `''` when it never was: every `[critical]`/`[major]` then sorts at
 * or after the cutoff and blocks, which is the honest reading of "no verdict
 * has weighed this yet".
 */
function supersessionCutoffSql(): SQL {
  return sql`COALESCE((
    SELECT ${lastCleanReviewStartedAtSql(cleanReviewSessions)}
    FROM ${agentSessions} AS ${sql.raw(CLEAN_REVIEW_ALIAS)}
    WHERE ${cleanReviewSessions.epicId} = ${reviewComments.epicId}
  ), '')`;
}

/**
 * The predicate. Combine with `status = 'open'` — this fragment says which
 * open rows count, not which rows are open.
 */
export function blocksMergeSql(): SQL {
  return sql`(
    ${reviewComments.author} <> 'agent'
    OR ${reviewComments.author} IS NULL
    OR NOT (${bodyStartsWithAnySql(FINDING_SEVERITY_PREFIXES)})
    OR (
      (${bodyStartsWithAnySql(BLOCKING_FINDING_PREFIXES)})
      AND REPLACE(COALESCE(${reviewComments.createdAt}, ''), ' ', 'T')
          >= ${supersessionCutoffSql()}
    )
  )`;
}
