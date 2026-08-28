import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  DISPATCH_RELIABILITY_WINDOW_DAYS,
  DISPATCH_ROLES,
  DISPATCH_ROLE_AGENT_TYPES,
  type DispatchReliabilityRow,
  type DispatchRole,
} from "./dispatch-reliability-constants";

/**
 * Reliability & cost aggregates for the Agent Config "Stats" tab.
 *
 * All aggregation happens in SQL (single statement per helper) — never by
 * loading full tables into JS. Optional `projectId` scopes both helpers to
 * one project; omitted means "across all projects".
 *
 * Scope: EVERY agent_sessions row counts, regardless of agent type —
 * including background 'memory_distill' and 'dreaming' runs. This is
 * deliberate: their
 * tokens are real spend that must show up in cost totals, and the grouping
 * key is (named agent × provider), which already blends agent types (builds,
 * reviews, QA) for the same pair. Excluding one background type would make
 * the totals lie.
 */

/** One row per (named agent × provider) over agent_sessions. */
export interface AgentReliabilityRow {
  /** Denormalized named-agent name; null for sessions without a named agent. */
  agentName: string | null;
  provider: string;
  /** Every session ever created for this pair (any status). */
  runCount: number;
  completedCount: number;
  failedCount: number;
  /** completed / (completed + failed); null when no terminal run exists. */
  successRate: number | null;
  /** Median wall-clock duration of terminal runs (ms); null when unknown. */
  medianDurationMs: number | null;
  /** Sum of reported session costs; null when no session reported one. */
  totalCostUsd: number | null;
}

/** Per-project review bounce: review -> in_progress rework loops. */
export interface ProjectReviewBounceRow {
  projectId: string;
  projectName: string | null;
  /** Distinct epics that ever reached the review column. */
  reviewedEpics: number;
  /** Count of review -> in_progress transitions (an epic can bounce twice). */
  bounceTransitions: number;
  /** bounceTransitions / reviewedEpics; null when nothing reached review. */
  bounceRate: number | null;
}

interface RawAgentRow {
  agent_name: string | null;
  provider: string;
  run_count: number;
  completed_count: number;
  failed_count: number;
  total_cost_usd: number | null;
  median_duration_ms: number | null;
}

export function getAgentReliabilityStats(
  projectId?: string,
): AgentReliabilityRow[] {
  const scope = projectId ?? null;

  // Median without a MEDIAN() builtin: rank terminal durations per group
  // with window functions, then average the middle row(s) — rn IN
  // ((cnt+1)/2, (cnt+2)/2) picks the single middle row for odd counts and
  // both middle rows for even counts (integer division).
  const rows = db.all<RawAgentRow>(sql`
    WITH scoped_sessions AS (
      SELECT
        named_agent_name AS agent_name,
        COALESCE(provider, 'claude-code') AS provider,
        status,
        total_cost_usd,
        CASE
          WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
            AND status IN ('completed', 'failed')
          THEN (julianday(ended_at) - julianday(started_at)) * 86400000.0
        END AS duration_ms
      FROM agent_sessions
      WHERE (${scope} IS NULL OR project_id = ${scope})
    ),
    agg AS (
      SELECT
        agent_name,
        provider,
        COUNT(*) AS run_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(total_cost_usd) AS total_cost_usd
      FROM scoped_sessions
      GROUP BY agent_name, provider
    ),
    ranked_durations AS (
      SELECT
        agent_name,
        provider,
        duration_ms,
        ROW_NUMBER() OVER (
          PARTITION BY agent_name, provider ORDER BY duration_ms
        ) AS rn,
        COUNT(*) OVER (PARTITION BY agent_name, provider) AS cnt
      FROM scoped_sessions
      WHERE duration_ms IS NOT NULL
    ),
    medians AS (
      SELECT agent_name, provider, AVG(duration_ms) AS median_duration_ms
      FROM ranked_durations
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY agent_name, provider
    )
    SELECT
      agg.agent_name,
      agg.provider,
      agg.run_count,
      agg.completed_count,
      agg.failed_count,
      agg.total_cost_usd,
      medians.median_duration_ms
    FROM agg
    LEFT JOIN medians
      ON medians.agent_name IS agg.agent_name
      AND medians.provider = agg.provider
    ORDER BY agg.run_count DESC, agg.agent_name IS NULL, agg.agent_name, agg.provider
  `);

  return rows.map((row) => {
    const terminal = row.completed_count + row.failed_count;
    return {
      agentName: row.agent_name,
      provider: row.provider,
      runCount: row.run_count,
      completedCount: row.completed_count,
      failedCount: row.failed_count,
      successRate: terminal > 0 ? row.completed_count / terminal : null,
      medianDurationMs:
        typeof row.median_duration_ms === "number"
          ? Math.round(row.median_duration_ms)
          : null,
      totalCostUsd: row.total_cost_usd,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Dispatch reliability (named agent × role, windowed)                 */
/* ------------------------------------------------------------------ */

interface RawDispatchRow {
  named_agent_id: string;
  agent_name: string | null;
  role: string;
  sample_size: number;
  completed_count: number;
  failed_count: number;
  median_duration_ms: number | null;
}

/**
 * `CASE agent_type WHEN 'build' THEN 'build' … END`, generated from
 * DISPATCH_ROLE_AGENT_TYPES so the grouping the badge shows and the mapping
 * the rest of the app uses can never disagree. Unmapped/legacy agent types
 * fall through to NULL and are filtered out.
 *
 * Exported (and only exported — the body is untouched) so the per-agent task
 * split in lib/agent-config/agent-stats.ts groups by the SAME expression: the
 * split a user reads and the role mapping the dispatcher uses can never
 * disagree. Callers must alias agent_sessions as `s`.
 */
export function dispatchRoleCaseExpression(): SQL {
  const branches: SQL[] = [];
  for (const role of DISPATCH_ROLES) {
    for (const agentType of DISPATCH_ROLE_AGENT_TYPES[role]) {
      branches.push(sql`WHEN ${agentType} THEN ${role}`);
    }
  }
  return sql`CASE s.agent_type ${sql.join(branches, sql` `)} END`;
}

export interface DispatchReliabilityQuery {
  /** Scopes to one project; omitted means "across all projects". */
  projectId?: string;
  /** Defaults to DISPATCH_RELIABILITY_WINDOW_DAYS. */
  windowDays?: number;
  /** Window anchor; defaults to now. Injected by tests for determinism. */
  nowIso?: string;
}

/**
 * Success rate and median duration per (named agent × dispatch role) over the
 * trailing window — the single aggregate behind both the picker badge and the
 * Full Auto argmax.
 *
 * ONE statement, every group in one pass: the pickers render a row per named
 * agent and must never issue a query per agent. Only terminal runs
 * (completed / failed) count, so `sample_size` is exactly the denominator of
 * the success rate — a queued or still-running session is not evidence of
 * anything yet. Sessions with no named agent are excluded: the badge and the
 * argmax both address agents by id.
 */
export function getNamedAgentDispatchReliability(
  query: DispatchReliabilityQuery = {},
): DispatchReliabilityRow[] {
  const scope = query.projectId ?? null;
  const windowDays = query.windowDays ?? DISPATCH_RELIABILITY_WINDOW_DAYS;
  const now = query.nowIso ? new Date(query.nowIso) : new Date();
  const cutoff = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // julianday() rather than string comparison: created_at holds ISO strings
  // from the app and 'YYYY-MM-DD HH:MM:SS' from the column default, which do
  // not sort against each other.
  const rows = db.all<RawDispatchRow>(sql`
    WITH scoped_sessions AS (
      SELECT
        s.named_agent_id AS named_agent_id,
        COALESCE(s.named_agent_name, a.name) AS agent_name,
        ${dispatchRoleCaseExpression()} AS role,
        s.status AS status,
        CASE
          WHEN s.started_at IS NOT NULL AND s.ended_at IS NOT NULL
          THEN (julianday(s.ended_at) - julianday(s.started_at)) * 86400000.0
        END AS duration_ms
      FROM agent_sessions s
      LEFT JOIN named_agents a ON a.id = s.named_agent_id
      WHERE s.named_agent_id IS NOT NULL
        AND s.status IN ('completed', 'failed')
        AND s.created_at IS NOT NULL
        AND julianday(s.created_at) >= julianday(${cutoff})
        AND (${scope} IS NULL OR s.project_id = ${scope})
    ),
    roled AS (
      SELECT * FROM scoped_sessions WHERE role IS NOT NULL
    ),
    agg AS (
      SELECT
        named_agent_id,
        MAX(agent_name) AS agent_name,
        role,
        COUNT(*) AS sample_size,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM roled
      GROUP BY named_agent_id, role
    ),
    ranked_durations AS (
      SELECT
        named_agent_id,
        role,
        duration_ms,
        ROW_NUMBER() OVER (
          PARTITION BY named_agent_id, role ORDER BY duration_ms
        ) AS rn,
        COUNT(*) OVER (PARTITION BY named_agent_id, role) AS cnt
      FROM roled
      WHERE duration_ms IS NOT NULL
    ),
    medians AS (
      SELECT named_agent_id, role, AVG(duration_ms) AS median_duration_ms
      FROM ranked_durations
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY named_agent_id, role
    )
    SELECT
      agg.named_agent_id,
      agg.agent_name,
      agg.role,
      agg.sample_size,
      agg.completed_count,
      agg.failed_count,
      medians.median_duration_ms
    FROM agg
    LEFT JOIN medians
      ON medians.named_agent_id = agg.named_agent_id
      AND medians.role = agg.role
    ORDER BY agg.role, agg.agent_name, agg.named_agent_id
  `);

  return rows.map((row) => ({
    namedAgentId: row.named_agent_id,
    agentName: row.agent_name,
    role: row.role as DispatchRole,
    sampleSize: row.sample_size,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    successRate:
      row.sample_size > 0 ? row.completed_count / row.sample_size : null,
    medianDurationMs:
      typeof row.median_duration_ms === "number"
        ? Math.round(row.median_duration_ms)
        : null,
  }));
}

interface RawBounceRow {
  project_id: string;
  project_name: string | null;
  reviewed_epics: number;
  bounce_transitions: number;
}

export function getReviewBounceStats(
  projectId?: string,
): ProjectReviewBounceRow[] {
  const scope = projectId ?? null;

  const rows = db.all<RawBounceRow>(sql`
    SELECT
      t.project_id AS project_id,
      p.name AS project_name,
      COUNT(DISTINCT CASE WHEN t.to_status = 'review' THEN t.epic_id END)
        AS reviewed_epics,
      SUM(
        CASE
          WHEN t.from_status = 'review' AND t.to_status = 'in_progress' THEN 1
          ELSE 0
        END
      ) AS bounce_transitions
    FROM ticket_activity_log t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE (${scope} IS NULL OR t.project_id = ${scope})
    GROUP BY t.project_id
    HAVING reviewed_epics > 0 OR bounce_transitions > 0
    ORDER BY p.name, t.project_id
  `);

  return rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    reviewedEpics: row.reviewed_epics,
    bounceTransitions: row.bounce_transitions,
    bounceRate:
      row.reviewed_epics > 0
        ? row.bounce_transitions / row.reviewed_epics
        : null,
  }));
}
