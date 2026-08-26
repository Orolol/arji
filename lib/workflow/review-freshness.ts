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
function sessionAtSql() {
  return sql`REPLACE(COALESCE(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}), ' ', 'T')`;
}

/**
 * Newest EPIC-SCOPED review session that completed with an actual verdict
 * (`outcome = 'answered'`).
 *
 * Epic-scoped (`user_story_id IS NULL`) because reviews and merges are
 * epic-level by design, so a story review must never satisfy the epic's merge
 * gate. A review that answered `changes_requested` through submit_findings is
 * NOT clean, findings or no findings: the verdict is the authoritative
 * channel (lib/pipeline/findings.ts), so an explicit NO must never satisfy
 * the gate. NULL stays clean — that is every MCP-less provider, whose only
 * verdict signal is the prose scan this gate never read.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastCleanReviewAtSql() {
  return sql<string | null>`MAX(CASE
    WHEN ${agentSessions.status} = 'completed'
     AND ${agentSessions.userStoryId} IS NULL
     AND ${agentSessions.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
     AND ${agentSessions.outcome} = 'answered'
     AND (${agentSessions.reviewVerdict} IS NULL
          OR ${agentSessions.reviewVerdict} <> 'changes_requested')
    THEN ${sessionAtSql()} END)`;
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
