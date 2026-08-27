/**
 * The two session facts every merge gate is built on, as reusable SQL.
 *
 * "Has this epic been cleanly reviewed since its branch last changed?" is
 * answered by exactly two conditional aggregates over `agent_sessions`. Full
 * Auto's sweep snapshot (lib/auto-mode/select.ts) and the board list query
 * (app/api/projects/[projectId]/epics/route.ts) both need them, and a second
 * hand-written copy of these CASE expressions is precisely how a card would
 * start claiming "ready to merge" for an epic the supervisor refuses.
 *
 * Each export is a FUNCTION, not a shared `sql` value: a fragment gets an
 * alias attached per query (`.as(...)`), so handing the same instance to two
 * builders would couple them.
 */

import { sql, type SQLWrapper } from "drizzle-orm";
import { agentSessions } from "@/lib/db/schema";

/**
 * The `agent_sessions` columns these fragments read, structurally.
 *
 * Typed by the columns rather than by the table so a correlated subquery can
 * pass an `alias()` handle: an aliased table carries its alias in every
 * column's type parameters, so it is not assignable to `typeof agentSessions`
 * however identical the columns are.
 */
export type ReviewFreshnessColumns = Record<
  | "status"
  | "userStoryId"
  | "agentType"
  | "outcome"
  | "reviewVerdict"
  | "startedAt"
  | "createdAt",
  SQLWrapper
>;

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
function sessionAtSql() {
  return sql`REPLACE(COALESCE(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}), ' ', 'T')`;
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
 *
 * `session` is a parameter so a CORRELATED subquery can pass its own alias
 * (lib/workflow/blocking-findings.ts) and still test the same conditions.
 */
export function isCleanReviewSql(
  session: ReviewFreshnessColumns = agentSessions
) {
  return sql`${session.status} = 'completed'
     AND ${session.userStoryId} IS NULL
     AND ${session.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
     AND ${session.outcome} = 'answered'
     AND (${session.reviewVerdict} IS NULL
          OR ${session.reviewVerdict} <> 'changes_requested')`;
}

/**
 * Newest EPIC-SCOPED review session that completed with an actual verdict
 * (`outcome = 'answered'`) — see `isCleanReviewSql` for the exclusions.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastCleanReviewAtSql() {
  return sql<string | null>`MAX(CASE
    WHEN ${isCleanReviewSql()}
    THEN ${sessionAtSql()} END)`;
}

/**
 * When the newest clean review STARTED — the findings window of the round
 * that last passed judgement, in the same shape
 * `readSessionFindingsWindow` uses (`started_at`, falling back to the row's
 * creation).
 *
 * Its companion above answers "how fresh is the verdict"; this one answers
 * "which findings did that verdict weigh". A `[critical]` filed BEFORE this
 * instant belongs to a round the reviewer has since re-run on fixed code and
 * not re-reported — stale bookkeeping, not an open problem. One filed at or
 * after it was filed by (or alongside) the very review that approved, and a
 * self-contradicting reviewer never clears the gate.
 *
 * MAX over the clean rounds' starts, not "the start of the row that produced
 * the MAX end": reviews on one epic are serialised, so the newest start IS
 * the newest round, and reading one aggregate is cheaper than correlating two.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastCleanReviewStartedAtSql(
  session: ReviewFreshnessColumns = agentSessions
) {
  return sql<string | null>`MAX(CASE
    WHEN ${isCleanReviewSql(session)}
    THEN REPLACE(COALESCE(${session.startedAt}, ${session.createdAt}), ' ', 'T')
    END)`;
}

/**
 * Newest terminal code-writing session on the epic, story-scoped ones
 * INCLUDED: a story build commits to the epic's branch, so a review that
 * predates it is stale.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastTerminalCodeAtSql() {
  return sql<string | null>`MAX(CASE
    WHEN ${agentSessions.status} IN (${sql.raw(TERMINAL_STATUSES_SQL)})
     AND ${agentSessions.agentType} IN (${sql.raw(CODE_AGENT_TYPES_SQL)})
    THEN ${sessionAtSql()} END)`;
}
