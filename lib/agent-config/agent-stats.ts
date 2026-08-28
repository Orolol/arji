import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchRoleCaseExpression } from "./stats";
import type { DispatchRole } from "./dispatch-reliability-constants";

/**
 * The two aggregates behind the /agents workshop (frame 7a).
 *
 *   - `getAgentDayStats()`  — TODAY, every named agent, for the roster cards.
 *   - `getNamedAgentStats()` — the trailing 14 days for ONE selected agent,
 *     for THE NUMBERS band.
 *
 * AGGREGATE-IN-SQL DISCIPLINE (same rule as lib/agent-config/stats.ts): the
 * roster aggregate is ONE statement covering EVERY agent in one pass — the
 * roster renders a card per named agent and must never issue a query per
 * agent. The only JS-side work is filling the 14-day calendar from at most 14
 * grouped rows.
 *
 * DEVIATION, stated plainly: the per-agent band needs four differently-shaped
 * results (scalars + median, a day series, a role split, an escalation count),
 * and SQLite cannot return them from one statement without json_group_array
 * gymnastics. It therefore issues FOUR statements for ONE agent — a constant,
 * not an N. The invariant that actually matters ("never a query per agent in a
 * list") is untouched.
 *
 * SCOPE: every agent_sessions row counts regardless of agent type, including
 * background 'memory_distill' and 'dreaming' runs — their tokens are real
 * spend that must show up in cost totals. Only the task split partitions by
 * dispatch role.
 *
 * TIME: everything is UTC. `date()` and `julianday()` are called without a
 * modifier on purpose; do not "fix" them into localtime. `julianday()` rather
 * than a string comparison is a bug fix, not a style choice — `created_at`
 * holds ISO strings written by the app AND 'YYYY-MM-DD HH:MM:SS' written by
 * the column default, and a space sorts before 'T'.
 */

/** One row per named agent, over TODAY only — the roster card's three figures. */
export interface AgentDayStats {
  namedAgentId: string;
  runsToday: number;
  /** completed / (completed + failed) today; null when nothing is terminal. */
  cleanRate: number | null;
  /** Sum of reported costs today; null when no session reported one. */
  costTodayUsd: number | null;
  /** Sessions currently `running` for this agent, any day. */
  liveSessions: number;
}

/** One calendar day of the sparkline. `failed` > 0 draws the coral cap. */
export interface AgentDaySeriesPoint {
  date: string;
  runs: number;
  failed: number;
}

/** One dispatch role of the task split. */
export interface AgentRoleSplitRow {
  role: DispatchRole;
  runs: number;
}

/** The 14-day payload behind THE NUMBERS. */
export interface NamedAgentStats {
  windowDays: number;
  runCount: number;
  completedCount: number;
  failedCount: number;
  /** completed / (completed + failed); null when nothing is terminal. */
  cleanRate: number | null;
  medianDurationMs: number | null;
  totalCostUsd: number | null;
  /** Blame-attributed escalations; null when the agent has no terminal run. */
  escalationCount: number | null;
  /** Exactly `windowDays` entries, oldest first, zero-filled. */
  days: AgentDaySeriesPoint[];
  byRole: AgentRoleSplitRow[];
}

export const AGENT_STATS_WINDOW_DAYS = 14;

interface RawDayStatsRow {
  named_agent_id: string;
  runs_today: number;
  completed_today: number;
  failed_today: number;
  cost_today: number | null;
  live_sessions: number;
}

/**
 * Today's run count, clean rate, cost and live-session count for EVERY named
 * agent, in one pass.
 *
 * `SUM(CASE … THEN total_cost_usd END)` deliberately has no `ELSE 0`: that is
 * what preserves NULL when no session reported a cost, so the card can render
 * an em-dash instead of a fake `$0`.
 *
 * `live_sessions` is intentionally NOT date-filtered — a session started
 * yesterday and still running is live now.
 */
export function getAgentDayStats(): AgentDayStats[] {
  const rows = db.all<RawDayStatsRow>(sql`
    SELECT
      named_agent_id AS named_agent_id,
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END)
        AS runs_today,
      SUM(CASE WHEN date(created_at) = date('now') AND status = 'completed' THEN 1 ELSE 0 END)
        AS completed_today,
      SUM(CASE WHEN date(created_at) = date('now') AND status = 'failed' THEN 1 ELSE 0 END)
        AS failed_today,
      SUM(CASE WHEN date(created_at) = date('now') THEN total_cost_usd END)
        AS cost_today,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END)
        AS live_sessions
    FROM agent_sessions
    WHERE named_agent_id IS NOT NULL
    GROUP BY named_agent_id
  `);

  return rows.map((row) => {
    const terminal = row.completed_today + row.failed_today;
    return {
      namedAgentId: row.named_agent_id,
      runsToday: row.runs_today,
      cleanRate: terminal > 0 ? row.completed_today / terminal : null,
      costTodayUsd: row.cost_today,
      liveSessions: row.live_sessions,
    };
  });
}

export interface NamedAgentStatsQuery {
  /** Defaults to AGENT_STATS_WINDOW_DAYS. */
  windowDays?: number;
  /** Window anchor; defaults to now. Injected by tests for determinism. */
  nowIso?: string;
}

interface RawAggregateRow {
  run_count: number;
  completed_count: number;
  failed_count: number;
  total_cost_usd: number | null;
  median_duration_ms: number | null;
}

interface RawDayRow {
  day: string;
  runs: number;
  failed: number;
}

interface RawRoleRow {
  role: string;
  runs: number;
}

interface RawEscalationRow {
  escalation_count: number;
}

/** `YYYY-MM-DD` for a Date, in UTC. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The window is `windowDays` CALENDAR days ending today (UTC), anchored at
 * 00:00:00Z of the earliest one. Aligning the cutoff to a day boundary is what
 * lets the scalar totals and the day series describe the same period: a
 * rolling `now - 14 * 24h` cutoff would admit runs belonging to a 15th
 * calendar day that the series has no column for.
 */
function windowCutoffIso(now: Date, windowDays: number): string {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return start.toISOString();
}

export function getNamedAgentStats(
  agentId: string,
  query: NamedAgentStatsQuery = {},
): NamedAgentStats {
  const windowDays = query.windowDays ?? AGENT_STATS_WINDOW_DAYS;
  const now = query.nowIso ? new Date(query.nowIso) : new Date();
  const cutoff = windowCutoffIso(now, windowDays);

  // 1/4 — run count, terminal split, cost sum and median duration.
  //
  // SQLite has no MEDIAN(): rank the terminal durations with window functions
  // and average the middle row(s) — rn IN ((cnt+1)/2, (cnt+2)/2) picks the one
  // middle row for an odd count and both for an even one (integer division).
  // Same pattern as getAgentReliabilityStats / getNamedAgentDispatchReliability.
  const aggregate = db.all<RawAggregateRow>(sql`
    WITH scoped AS (
      SELECT
        s.status AS status,
        s.total_cost_usd AS total_cost_usd,
        CASE
          WHEN s.started_at IS NOT NULL AND s.ended_at IS NOT NULL
            AND s.status IN ('completed', 'failed')
          THEN (julianday(s.ended_at) - julianday(s.started_at)) * 86400000.0
        END AS duration_ms
      FROM agent_sessions s
      WHERE s.named_agent_id = ${agentId}
        AND s.created_at IS NOT NULL
        AND julianday(s.created_at) >= julianday(${cutoff})
    ),
    agg AS (
      SELECT
        COUNT(*) AS run_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        -- No ELSE 0: a null cost must stay null so the numeral shows an
        -- em-dash rather than a fabricated $0.
        SUM(total_cost_usd) AS total_cost_usd
      FROM scoped
    ),
    ranked_durations AS (
      SELECT
        duration_ms,
        ROW_NUMBER() OVER (ORDER BY duration_ms) AS rn,
        COUNT(*) OVER () AS cnt
      FROM scoped
      WHERE duration_ms IS NOT NULL
    ),
    medians AS (
      SELECT AVG(duration_ms) AS median_duration_ms
      FROM ranked_durations
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
    )
    SELECT
      agg.run_count,
      agg.completed_count,
      agg.failed_count,
      agg.total_cost_usd,
      (SELECT median_duration_ms FROM medians) AS median_duration_ms
    FROM agg
  `)[0];

  const runCount = aggregate?.run_count ?? 0;
  const completed = aggregate?.completed_count ?? 0;
  const failed = aggregate?.failed_count ?? 0;
  const terminal = completed + failed;

  // 2/4 — one row per day that has sessions; JS zero-fills the calendar below.
  const dayRows = db.all<RawDayRow>(sql`
    SELECT
      date(s.created_at) AS day,
      COUNT(*) AS runs,
      SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM agent_sessions s
    WHERE s.named_agent_id = ${agentId}
      AND s.created_at IS NOT NULL
      AND julianday(s.created_at) >= julianday(${cutoff})
    GROUP BY date(s.created_at)
  `);

  const byDay = new Map(dayRows.map((row) => [row.day, row]));
  const days: AgentDaySeriesPoint[] = [];
  const cursor = new Date(cutoff);
  for (let i = 0; i < windowDays; i += 1) {
    const date = utcDay(cursor);
    const row = byDay.get(date);
    days.push({ date, runs: row?.runs ?? 0, failed: row?.failed ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // 3/4 — the task split, grouped by the SAME CASE expression the dispatcher's
  // reliability aggregate uses. Unmapped/legacy agent types fall through to
  // NULL and are dropped by the HAVING.
  const roleRows = db.all<RawRoleRow>(sql`
    SELECT
      ${dispatchRoleCaseExpression()} AS role,
      COUNT(*) AS runs
    FROM agent_sessions s
    WHERE s.named_agent_id = ${agentId}
      AND s.created_at IS NOT NULL
      AND julianday(s.created_at) >= julianday(${cutoff})
    GROUP BY role
    HAVING role IS NOT NULL
    ORDER BY runs DESC, role
  `);

  // 4/4 — escalations.
  //
  // BLAME HEURISTIC, NOT A RECORDED EVENT. There is no escalation table: the
  // pipeline runner emits two trace strings (PIPELINE_REASONS.escalation /
  // .effortEscalation) which lib/pipeline/index.ts persists into
  // ticket_activity_log with actor='system'. Joining a trace to its OWN
  // session under-counts badly, because a provider escalation drops the named
  // agent entirely (lib/pipeline/stages.ts returns namedAgentId: null). So the
  // responsible agent is taken to be the most recent FAILED session of the
  // same epic that ended at or before the trace.
  //
  // Matching is on the reason PREFIX, never an exact string — PIPELINE_REASON_PREFIX
  // exists precisely so new trace lines need no query change. The day a
  // dedicated escalation event lands, this becomes exact.
  const escalations = db.all<RawEscalationRow>(sql`
    WITH traces AS (
      SELECT t.id AS id, t.epic_id AS epic_id, t.created_at AS created_at
      FROM ticket_activity_log t
      WHERE t.actor = 'system'
        AND (
          t.reason LIKE 'Pipeline escalation:%'
          OR t.reason LIKE 'Pipeline effort escalation:%'
        )
        AND t.created_at IS NOT NULL
        AND julianday(t.created_at) >= julianday(${cutoff})
    )
    SELECT COUNT(*) AS escalation_count
    FROM traces t
    WHERE (
      SELECT s.named_agent_id
      FROM agent_sessions s
      WHERE s.epic_id = t.epic_id
        AND s.status = 'failed'
        AND s.named_agent_id IS NOT NULL
        AND s.ended_at IS NOT NULL
        AND julianday(s.ended_at) <= julianday(t.created_at)
      ORDER BY julianday(s.ended_at) DESC
      LIMIT 1
    ) = ${agentId}
  `)[0];

  return {
    windowDays,
    runCount,
    completedCount: completed,
    failedCount: failed,
    cleanRate: terminal > 0 ? completed / terminal : null,
    medianDurationMs:
      typeof aggregate?.median_duration_ms === "number"
        ? Math.round(aggregate.median_duration_ms)
        : null,
    totalCostUsd: aggregate?.total_cost_usd ?? null,
    // A real 0 is meaningful ("nothing escalated"), but only once there is
    // something to have escalated. With no terminal run the honest answer is
    // "unknown", which the numeral renders as an em-dash.
    escalationCount: terminal > 0 ? (escalations?.escalation_count ?? 0) : null,
    days,
    byRole: roleRows.map((row) => ({
      role: row.role as DispatchRole,
      runs: row.runs,
    })),
  };
}
