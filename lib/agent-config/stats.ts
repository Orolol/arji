import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

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
