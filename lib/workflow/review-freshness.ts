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
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { sessionAtSql } from "@/lib/agent-sessions/session-time";
import {
  cleanReviewVerdictSql,
  ORDINARY_REVIEW_AGENT_TYPES,
} from "@/lib/pipeline/findings";

/**
 * Agent types that constitute "a review happened", as a SQL literal list.
 * Derived from the single definition in lib/pipeline/findings.ts so the merge
 * gate, the board badge and the reviewer dispatcher cannot drift apart.
 *
 * Narrower than the workflow engine's `hasCompletedReview`, which matches any
 * type containing "review" (lib/workflow/context.ts): that is the lax floor,
 * this is the gate.
 */
const REVIEW_AGENT_TYPES_SQL = ORDINARY_REVIEW_AGENT_TYPES.map(
  (type) => `'${type}'`
).join(",");

/**
 * Agent types that constitute "the code changed". `merge` counts: a
 * merge-fix agent rewrites the branch, so a review that predates it is stale.
 */
const CODE_AGENT_TYPES_SQL = "'build','ticket_build','team_build','merge'";

const TERMINAL_STATUSES_SQL = "'completed','failed','cancelled'";

/**
 * Newest EPIC-SCOPED review session that completed with an actual verdict
 * (`outcome = 'answered'`) AND was clean.
 *
 * Epic-scoped (`user_story_id IS NULL`) because reviews and merges are
 * epic-level by design, so a story review must never satisfy the epic's merge
 * gate.
 *
 * The per-row verdict rule is NOT written here. `submit_findings` is the
 * authoritative channel, and the module that owns that rule owns this
 * expression too (lib/pipeline/findings.ts `cleanReviewVerdictSql`): a review
 * that answered `changes_requested` is not clean, and neither is one whose
 * deposit channel Arij could not wire — an empty findings list from a review
 * that could not file anything is silence, not approval.
 *
 * The duplication this replaces was not cosmetic. While only findings.ts read
 * `agent_sessions.mcp_channel`, a review whose channel Arij could not wire was
 * judged by prose there and "not clean" here — so nothing charged it
 * (reconcileInFlight only charges an unverifiable review) and `needsReview`
 * stayed true every sweep: a reviewer dispatched forever on an epic that
 * never parked.
 *
 * Group by `agent_sessions.epic_id`.
 */
export function lastCleanReviewAtSql(database: ArijDatabase = defaultDb) {
  return sql<string | null>`MAX(CASE
    WHEN ${agentSessions.status} = 'completed'
     AND ${agentSessions.userStoryId} IS NULL
     AND ${agentSessions.agentType} IN (${sql.raw(REVIEW_AGENT_TYPES_SQL)})
     AND ${agentSessions.outcome} = 'answered'
     AND ${cleanReviewVerdictSql(database)}
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
