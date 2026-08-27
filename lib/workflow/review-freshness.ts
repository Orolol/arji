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

import { sql } from "drizzle-orm";
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
 * half of the two windows below.
 *
 * Epic-scoped (`user_story_id IS NULL`) because reviews and merges are
 * epic-level by design, so a story review must never speak for the epic.
 * `review_verdict IS NOT NULL` is what makes this "recorded": a session that
 * completed, answered and deposited nothing weighed nothing, so it must
 * neither supersede a finding nor impose a rejection. That is every MCP-less
 * provider, every token that 401'd mid-review, and every reviewer whose prose
 * no parser could read.
 */
function isVerdictBearingReviewSql() {
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
 *
 * `session` is a parameter so a CORRELATED subquery can pass its own alias
 * (lib/workflow/blocking-findings.ts) and still test the same conditions.
 */
export function isCleanReviewSql() {
  return sql`${agentSessions.status} = 'completed'
     AND ${agentSessions.userStoryId} IS NULL
     AND ${agentSessions.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
     AND ${agentSessions.outcome} = 'answered'
     AND (${agentSessions.reviewVerdict} IS NULL
          OR ${agentSessions.reviewVerdict} <> 'changes_requested')`;
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
 * When the newest review that RECORDED A VERDICT started — the findings
 * window of the round that last passed judgement, in the same shape
 * `readSessionFindingsWindow` uses (`started_at`, falling back to the row's
 * creation).
 *
 * `lastCleanReviewAtSql` answers "how fresh is the verdict"; this answers the
 * different question "which findings did a reviewer actually weigh". A
 * `[critical]` filed BEFORE this instant belongs to a round a later reviewer
 * re-read on fixed code and chose not to re-report — stale bookkeeping, not
 * an open problem. One filed at or after it was raised by (or alongside) that
 * very review, and a self-contradicting reviewer never clears the gate.
 *
 * `review_verdict IS NOT NULL` is the load-bearing difference from
 * `isCleanReviewSql`, which treats NULL as clean on purpose. NULL is the
 * absence of evidence: an MCP-less provider, a token that 401'd mid-review, a
 * reviewer whose prose no parser could read. Absence of evidence answers
 * "how fresh" (nothing better exists) but must never answer "was this finding
 * re-examined" — a review that deposited nothing re-examined nothing, and
 * letting it advance the cutoff would clear every earlier `[critical]` on the
 * strength of a session that said nothing at all.
 *
 * MAX over those rounds' starts, not "the start of the row that produced the
 * MAX end": reviews on one epic are serialised, so the newest start IS the
 * newest round, and reading one aggregate is cheaper than correlating two.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastCleanVerdictReviewStartedAtSql() {
  return sql<string | null>`MAX(CASE
    WHEN ${isVerdictBearingReviewSql()}
     AND ${agentSessions.reviewVerdict} <> 'changes_requested'
    THEN ${reviewStartedAtSql()} END)`;
}

/**
 * When the newest review that recorded `changes_requested` started.
 *
 * Its counterpart above is the newest CLEAN verdict. Compare the two and you
 * have "is a rejection still standing" — the fact
 * `lib/kanban/merge-readiness.ts` turns into a blocker and the workflow
 * engine turns into a merge refusal.
 *
 * It cannot be derived from `lastCleanReviewAtSql`, which is a MAX over clean
 * rounds: a later rejection leaves that value untouched at the older
 * approving round, so a rejection is simply invisible to it.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastNegativeVerdictReviewStartedAtSql() {
  return sql<string | null>`MAX(CASE
    WHEN ${isVerdictBearingReviewSql()}
     AND ${agentSessions.reviewVerdict} = 'changes_requested'
    THEN ${reviewStartedAtSql()} END)`;
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
