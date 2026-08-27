/**
 * The per-epic session facts every merge gate is built on.
 *
 * "Has this epic been cleanly reviewed since its branch last changed?" and
 * "which findings has a reviewer since adjudicated?" are both answered by
 * conditional aggregates over `agent_sessions`. Full Auto's sweep snapshot
 * (lib/auto-mode/select.ts) and the board list query
 * (app/api/projects/[projectId]/epics/route.ts) both need them, and a second
 * hand-written copy of these CASE expressions is precisely how a card would
 * start claiming "ready to merge" for an epic the supervisor refuses.
 *
 * ## Shape: project the rows, then aggregate them
 *
 * The facts are computed in two levels over ONE scan. The inner level tags
 * each session row ("this is a clean review, at T"), and carries one window
 * aggregate — the epic's newest clean-verdict start — down to every row. The
 * outer level groups.
 *
 * The window is what makes `supersessionAt` expressible: it is the newest
 * code session BEFORE the newest clean verdict, and a plain grouped SELECT
 * cannot filter one aggregate by another. Approximating it with "the newest
 * code session, if it happens to predate the newest clean verdict" gets the
 * ordinary review → fix → re-review cycle right and then resurrects settled
 * findings the moment any later build lands — which is `stale_review`, not
 * an unadjudicated finding.
 *
 * It is not free: the PARTITION BY sorts the rows, roughly doubling this
 * scan. Measured on the whole board query, 30-run average — 166 epics / 520
 * sessions / 180 open findings (about today's database): 1.00 ms for the two
 * flat scans this replaced, 1.26 ms here. At 120 / 4800 / 720: 4.83 ms
 * against 6.82 ms. So the scan this shape saves (see `epicSessionFactsCte`)
 * pays for most of the sort, and an `agent_sessions(epic_id)` index does not
 * recover the rest — SQLite still builds a temp b-tree for the GROUP BY.
 * Worth re-measuring if the table grows an order of magnitude; not worth an
 * approximate merge gate today.
 */

import { and, eq, sql, type SQL } from "drizzle-orm";
import { type ArijDatabase } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";

/**
 * Agent types that constitute "a review happened". Same family the workflow
 * engine's `hasCompletedReview` recognises (lib/workflow/context.ts).
 */
const REVIEW_AGENT_TYPES_SQL =
  "'review_security','review_code','review_compliance','review_feature'";

/**
 * Agent types that constitute "the code changed". `merge` counts: a
 * merge-fix agent rewrites the branch, so a review that predates it is stale.
 */
const CODE_AGENT_TYPES_SQL = "'build','ticket_build','team_build','merge'";

const TERMINAL_STATUSES_SQL = "'completed','failed','cancelled'";

/**
 * Session timestamps mix ISO-8601 (`2026-08-16T09:00:00.000Z`, written by
 * routes) and SQLite CURRENT_TIMESTAMP (`2026-08-16 09:00:00`). Normalising
 * the separator makes lexicographic MAX/compare chronologically correct —
 * the same normalisation lib/kanban/merge-readiness.ts does in JS.
 */
function reviewStartedAtSql() {
  return sql`REPLACE(COALESCE(${agentSessions.startedAt}, ${agentSessions.createdAt}), ' ', 'T')`;
}

function sessionAtSql() {
  return sql`REPLACE(COALESCE(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}), ' ', 'T')`;
}

/**
 * "This session recorded a verdict", as a reusable WHEN clause — the common
 * half of the two verdict windows.
 *
 * Epic-scoped (`user_story_id IS NULL`) because reviews and merges are
 * epic-level by design, so a story review must never speak for the epic.
 * `review_verdict IS NOT NULL` is what makes this "recorded": a session that
 * completed, answered and deposited nothing weighed nothing, so it must
 * neither supersede a finding nor impose a rejection. That is every MCP-less
 * provider, every token that 401'd mid-review, and every reviewer whose prose
 * no parser could read.
 *
 * That clause is belt-and-braces rather than load-bearing: both users of this
 * predicate also compare the verdict, and `NULL <> 'changes_requested'` /
 * `NULL = 'changes_requested'` are both NULL, so a verdict-less row drops out
 * either way. It stays because the rule should be readable here, not inferred
 * from three-valued logic further down.
 */
function isVerdictBearingReviewSql(): SQL {
  return sql`${agentSessions.status} = 'completed'
     AND ${agentSessions.userStoryId} IS NULL
     AND ${agentSessions.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
     AND ${agentSessions.outcome} = 'answered'
     AND ${agentSessions.reviewVerdict} IS NOT NULL`;
}

/**
 * "This session is a clean review", as a reusable WHEN clause.
 *
 * Epic-scoped (`user_story_id IS NULL`) because reviews and merges are
 * epic-level by design, so a story review must never satisfy the epic's merge
 * gate. A review that answered `changes_requested` through submit_findings is
 * NOT clean, findings or no findings: the verdict is the authoritative
 * channel (lib/pipeline/findings.ts), so an explicit NO must never satisfy
 * the gate. NULL stays clean — that is every MCP-less provider, whose only
 * verdict signal is the prose scan this gate never read.
 */
function isCleanReviewSql(): SQL {
  return sql`${agentSessions.status} = 'completed'
     AND ${agentSessions.userStoryId} IS NULL
     AND ${agentSessions.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
     AND ${agentSessions.outcome} = 'answered'
     AND (${agentSessions.reviewVerdict} IS NULL
          OR ${agentSessions.reviewVerdict} <> 'changes_requested')`;
}

/** A verdict-bearing review that did NOT ask for changes. */
function isCleanVerdictReviewSql(): SQL {
  return sql`${isVerdictBearingReviewSql()}
     AND ${agentSessions.reviewVerdict} <> 'changes_requested'`;
}

/** A verdict-bearing review that DID ask for changes. */
function isNegativeVerdictReviewSql(): SQL {
  return sql`${isVerdictBearingReviewSql()}
     AND ${agentSessions.reviewVerdict} = 'changes_requested'`;
}

/**
 * "This session changed the branch." Story-scoped ones INCLUDED: a story
 * build commits to the epic's branch, so a review that predates it is stale.
 * Failed and cancelled count — a half-finished build still leaves commits.
 */
function isTerminalCodeSessionSql(): SQL {
  return sql`${agentSessions.status} IN (${sql.raw(TERMINAL_STATUSES_SQL)})
     AND ${agentSessions.agentType} IN (${sql.raw(CODE_AGENT_TYPES_SQL)})`;
}

/**
 * Level one: every session row of the selected scope, tagged.
 *
 * `epicCleanVerdictAt` is the epic's newest clean-verdict start, computed as
 * a WINDOW so each row can be compared against it — that is the only thing
 * the outer aggregate cannot do for itself, and `supersessionAt` needs it.
 */
function epicSessionRows(database: ArijDatabase, scope: SQL) {
  return database
    .select({
      epicId: agentSessions.epicId,
      costUsd: agentSessions.totalCostUsd,
      cleanReviewAt: sql<string | null>`CASE
        WHEN ${isCleanReviewSql()} THEN ${sessionAtSql()} END`.as(
        "clean_review_at"
      ),
      cleanVerdictAt: sql<string | null>`CASE
        WHEN ${isCleanVerdictReviewSql()} THEN ${reviewStartedAtSql()} END`.as(
        "clean_verdict_at"
      ),
      negativeVerdictAt: sql<string | null>`CASE
        WHEN ${isNegativeVerdictReviewSql()} THEN ${reviewStartedAtSql()} END`.as(
        "negative_verdict_at"
      ),
      terminalCodeAt: sql<string | null>`CASE
        WHEN ${isTerminalCodeSessionSql()} THEN ${sessionAtSql()} END`.as(
        "terminal_code_at"
      ),
      epicCleanVerdictAt: sql<string | null>`MAX(CASE
        WHEN ${isCleanVerdictReviewSql()} THEN ${reviewStartedAtSql()} END)
        OVER (PARTITION BY ${agentSessions.epicId})`.as(
        "epic_clean_verdict_at"
      ),
    })
    .from(agentSessions)
    .where(scope)
    .as("epic_session_rows");
}

type EpicSessionRows = ReturnType<typeof epicSessionRows>;

/**
 * Level two: the aggregates, as a column map.
 *
 * - `lastCleanReviewAt` — newest CLEAN review (NULL verdicts included: it
 *   answers "how fresh is the verdict", and NULL is every MCP-less provider).
 * - `lastNegativeVerdictReviewAt` — when the newest RECORDED rejection
 *   started (the same anchor `readSessionFindingsWindow` uses). Against
 *   `supersessionAt` it answers "is a rejection still unanswered" — the fact
 *   `hasStandingNegativeVerdict` turns into a board blocker and the workflow
 *   engine into a merge refusal. It cannot come from `lastCleanReviewAt`,
 *   which is a MAX over clean rounds: a later rejection leaves that value
 *   untouched at the older approving round, invisible.
 * - `lastTerminalCodeAt` — newest code session, the freshness half.
 * - `supersessionAt` — the newest code change a recorded clean verdict has
 *   since READ. A `[critical]` filed before it has been adjudicated; one
 *   filed at or after it has not. BOTH halves are required, and the code half
 *   is the one that was missing: on an untouched branch a clean verdict used
 *   to clear findings still sitting in the very code it had just read —
 *   `review_code` files a `[critical]`, a `review_security` pass (a different
 *   dimension, which never re-read code quality) returns `approved`, and the
 *   finding stopped blocking the board, the merge selector and `review ->
 *   done` alike.
 *
 * What `supersessionAt` still does NOT distinguish is the review DIMENSION:
 * after a fix, a clean `review_security` verdict supersedes a `review_code`
 * finding. That matches lib/pipeline/findings.ts, whose window is per
 * stage-run and type-blind too; narrowing it needs a per-type window keyed on
 * `review_comments.agent_session_id` and belongs with that module.
 */
function epicSessionFactColumns(rows: EpicSessionRows) {
  return {
    epicId: rows.epicId,
    sessionsCostUsd: sql<number | null>`SUM(${rows.costUsd})`,
    lastCleanReviewAt: sql<string | null>`MAX(${rows.cleanReviewAt})`,
    lastTerminalCodeAt: sql<string | null>`MAX(${rows.terminalCodeAt})`,
    lastNegativeVerdictReviewAt: sql<string | null>`MAX(${rows.negativeVerdictAt})`,
    supersessionAt: sql<string | null>`MAX(CASE
      WHEN ${rows.terminalCodeAt} < ${rows.epicCleanVerdictAt}
      THEN ${rows.terminalCodeAt} END)`,
  };
}

/**
 * Every per-epic fact the merge gates read from `agent_sessions`, for one
 * project, published as a CTE.
 *
 * A CTE rather than a `.as()` subquery because both grouped callers need
 * these columns TWICE in one statement: once on the epic row (freshness,
 * verdict windows, cost) and once inside the blocking-findings count, which
 * joins `supersessionAt` per finding. Drizzle inlines a `.as()` subquery at
 * every reference, so the second use was a second full scan of an unindexed,
 * never-pruned table — on an endpoint the board refetches on every
 * `session:*` SSE event. Referenced from a `WITH` clause, `EXPLAIN QUERY
 * PLAN` reports a single `MATERIALIZE epic_session_facts`.
 *
 * `sessionsCostUsd` rides along for the board even though the sweep does not
 * read it: a SUM over a scan that already happens is cheaper than the split
 * definition that would let the two callers drift.
 *
 * Left-join it on `epic_id`, and pass `supersessionAt` to `blocksMergeSql`.
 */
export function epicSessionFactsCte(
  database: ArijDatabase,
  projectId: string
) {
  const rows = epicSessionRows(
    database,
    and(
      eq(agentSessions.projectId, projectId),
      sql`${agentSessions.epicId} IS NOT NULL`
    ) as SQL
  );
  const columns = epicSessionFactColumns(rows);
  return database.$with("epic_session_facts").as(
    database
      .select({
        epicId: columns.epicId,
        sessionsCostUsd: columns.sessionsCostUsd.as("sessions_cost_usd"),
        lastCleanReviewAt: columns.lastCleanReviewAt.as("last_clean_review_at"),
        lastTerminalCodeAt: columns.lastTerminalCodeAt.as(
          "last_terminal_code_at"
        ),
        lastNegativeVerdictReviewAt: columns.lastNegativeVerdictReviewAt.as(
          "last_negative_verdict_review_at"
        ),
        supersessionAt: columns.supersessionAt.as("supersession_at"),
      })
      .from(rows)
      .groupBy(rows.epicId)
  );
}

/**
 * The same facts for ONE epic, as scalars.
 *
 * Keyed exactly like the matching half of `MergeReadinessFacts`, so the read
 * drops straight into `hasStandingNegativeVerdict` with no adapter — an
 * adapter is where two names for one fact start disagreeing — and read from
 * HERE rather than sorting session rows in JavaScript, so the engine and the
 * board cannot end up with different ideas of which verdict spoke last.
 */
export interface EpicSessionFacts {
  /** `null` when no clean review has ever completed on the epic. */
  lastCleanReviewAt: string | null;
  /** `null` when no code session has ever run on the epic. */
  lastTerminalCodeAt: string | null;
  /** `null` when no review has ever recorded `changes_requested`. */
  lastNegativeVerdictReviewAt: string | null;
  /**
   * `null` when no clean verdict has read any code change, in which case
   * nothing is superseded. Not part of `MergeReadinessFacts`: the board never
   * compares it in JavaScript, because the comparison happens per finding row
   * inside `blocksMergeSql` and reaches the board already counted.
   */
  supersessionAt: string | null;
}

export function readEpicSessionFacts(
  database: ArijDatabase,
  epicId: string
): EpicSessionFacts {
  const rows = epicSessionRows(database, eq(agentSessions.epicId, epicId));
  const columns = epicSessionFactColumns(rows);
  // Grouped on one epic, so at most one row — and none at all when the epic
  // has no sessions, which reads the same as "no facts".
  const [row] = database
    .select({
      lastCleanReviewAt: columns.lastCleanReviewAt,
      lastTerminalCodeAt: columns.lastTerminalCodeAt,
      lastNegativeVerdictReviewAt: columns.lastNegativeVerdictReviewAt,
      supersessionAt: columns.supersessionAt,
    })
    .from(rows)
    .groupBy(rows.epicId)
    .all();
  return {
    lastCleanReviewAt: row?.lastCleanReviewAt ?? null,
    lastTerminalCodeAt: row?.lastTerminalCodeAt ?? null,
    lastNegativeVerdictReviewAt: row?.lastNegativeVerdictReviewAt ?? null,
    supersessionAt: row?.supersessionAt ?? null,
  };
}
