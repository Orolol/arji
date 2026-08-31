import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerUsageSnapshots, settings } from "@/lib/db/schema";
import {
  CLAUDE_WEEKLY_BUDGET_SETTING_KEY,
  MONTHLY_CAP_SETTING_KEY,
  type AgentUsageRow,
  type ClaudeQuota,
  type CodexLiveQuota,
  type DayUsageRow,
  type ProjectUsageRow,
  type ProviderUsageRow,
  type SubscriptionStatus,
  type UsageBar,
  type UsageDashboard,
  type UsageDayBar,
  type UsageMonthlyCap,
  type UsageProjectBar,
  type UsageRange,
  type UsageReport,
  type UsageTotals,
  type WindowUsage,
} from "@/lib/types/usage";
import type { CachedQuota } from "@/lib/usage/quota-cache";

/**
 * Aggregations behind `GET /api/usage`.
 *
 * Two rules run through every query here:
 *
 * 1. **All aggregation happens in SQL** — one statement per section, never a
 *    full table pulled into JS (same discipline as lib/agent-config/stats.ts).
 * 2. **`SUM` without `COALESCE`** — a group where no session ever reported a
 *    cost must come back as `null`, not `0`. Codex sessions report no
 *    tokens/cost to Arij at all, so faking zeros would quietly claim the
 *    provider is free. Unknown stays unknown all the way to the em-dash.
 *
 * Provider is normalized with `COALESCE(provider,'claude-code')` everywhere,
 * matching the Stats tab, because the column is nullable on legacy rows.
 */

const CLAUDE_PROVIDER = "claude-code";
const CODEX_PROVIDER = "codex";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_STRIP_LENGTH = 30;

/** SQLite hands back numbers or null; anything else is treated as absent. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** COUNT(*) is always present; this only guards against a driver surprise. */
function count(value: unknown): number {
  return num(value) ?? 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface RawUsageAggregate {
  sessions: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/**
 * Every row counts as a session — including queued/running ones, which carry
 * NULL usage. That keeps "sessions all time" honest (it is a run counter, not
 * a billing counter) while the money columns stay null-aware.
 */
function getTotals(): UsageTotals {
  const row = db.all<RawUsageAggregate>(sql`
    SELECT
      COUNT(*) AS sessions,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
  `)[0];

  return {
    sessions: count(row?.sessions),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    costUsd: num(row?.cost_usd),
  };
}

// ---------------------------------------------------------------------------
// Groupings
// ---------------------------------------------------------------------------

interface RawAgentUsageRow extends RawUsageAggregate {
  named_agent_id: string | null;
  name: string | null;
  provider: string;
  last_active_at: string | null;
}

/**
 * Grouped by (named agent name x normalized provider) — the SAME key the
 * Agent Config Stats tab uses, so the two surfaces can never disagree on a
 * run count. `named_agent_id` is MAX()'d because it is denormalized per
 * session and may be NULL on older rows for the same agent name.
 */
function getByAgent(): AgentUsageRow[] {
  const rows = db.all<RawAgentUsageRow>(sql`
    SELECT
      MAX(named_agent_id) AS named_agent_id,
      named_agent_name AS name,
      COALESCE(provider, 'claude-code') AS provider,
      COUNT(*) AS sessions,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_cost_usd) AS cost_usd,
      MAX(COALESCE(ended_at, started_at, created_at)) AS last_active_at
    FROM agent_sessions
    GROUP BY named_agent_name, COALESCE(provider, 'claude-code')
    ORDER BY
      (SUM(total_cost_usd) IS NULL),
      SUM(total_cost_usd) DESC,
      COUNT(*) DESC
  `);

  return rows.map((row) => ({
    namedAgentId: str(row.named_agent_id),
    name: str(row.name),
    provider: row.provider,
    sessions: count(row.sessions),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: num(row.cost_usd),
    lastActiveAt: str(row.last_active_at),
  }));
}

interface RawProviderUsageRow extends RawUsageAggregate {
  provider: string;
}

function getByProvider(): ProviderUsageRow[] {
  const rows = db.all<RawProviderUsageRow>(sql`
    SELECT
      COALESCE(provider, 'claude-code') AS provider,
      COUNT(*) AS sessions,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    GROUP BY COALESCE(provider, 'claude-code')
    ORDER BY
      (SUM(total_cost_usd) IS NULL),
      SUM(total_cost_usd) DESC,
      COUNT(*) DESC
  `);

  return rows.map((row) => ({
    provider: row.provider,
    sessions: count(row.sessions),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: num(row.cost_usd),
  }));
}

interface RawProjectUsageRow extends RawUsageAggregate {
  project_id: string;
  project_name: string | null;
}

/**
 * LEFT JOIN, not INNER: a session whose project row was deleted still spent
 * real money and must keep showing up (with a null name the UI renders as the
 * raw id).
 */
function getByProject(): ProjectUsageRow[] {
  const rows = db.all<RawProjectUsageRow>(sql`
    SELECT
      s.project_id AS project_id,
      p.name AS project_name,
      COUNT(*) AS sessions,
      SUM(s.input_tokens) AS input_tokens,
      SUM(s.output_tokens) AS output_tokens,
      SUM(s.total_cost_usd) AS cost_usd
    FROM agent_sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    GROUP BY s.project_id
    ORDER BY
      (SUM(s.total_cost_usd) IS NULL),
      SUM(s.total_cost_usd) DESC,
      COUNT(*) DESC
  `);

  return rows.map((row) => ({
    projectId: row.project_id,
    projectName: str(row.project_name),
    sessions: count(row.sessions),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: num(row.cost_usd),
  }));
}

// ---------------------------------------------------------------------------
// 30-day strip
// ---------------------------------------------------------------------------

/**
 * LOCAL calendar date key from LOCAL getters.
 *
 * Deliberately NOT `toISOString().slice(0,10)` (UTC skew: an evening session
 * would land on tomorrow) and deliberately NOT built by subtracting
 * `i * 86400000` ms from now (DST skew: one day per year would be duplicated
 * or missing). `Date.setDate()` does calendar arithmetic in local time, which
 * is exactly what SQLite's `date(...,'localtime')` produces — Node and SQLite
 * share the system timezone, so the keys line up.
 */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface RawDayRow {
  day: string;
  sessions: number;
  cost_usd: number | null;
}

/**
 * Exactly 30 entries, oldest first. Days with no terminal session are
 * zero-filled as `{ sessions: 0, costUsd: null }` — zero runs is a fact, zero
 * dollars would be a claim.
 */
function getByDay(): DayUsageRow[] {
  const rows = db.all<RawDayRow>(sql`
    SELECT
      date(ended_at, 'localtime') AS day,
      COUNT(*) AS sessions,
      SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    WHERE ended_at IS NOT NULL
      AND date(ended_at, 'localtime') >= date('now', 'localtime', '-29 days')
    GROUP BY day
  `);

  const byDate = new Map<string, RawDayRow>();
  for (const row of rows) {
    if (typeof row.day === "string") byDate.set(row.day, row);
  }

  const result: DayUsageRow[] = [];
  for (let offset = DAY_STRIP_LENGTH - 1; offset >= 0; offset--) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    const hit = byDate.get(key);
    result.push(
      hit
        ? { date: key, sessions: count(hit.sessions), costUsd: num(hit.cost_usd) }
        : { date: key, sessions: 0, costUsd: null },
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rolling windows
// ---------------------------------------------------------------------------

/**
 * Usage is written exactly once, at the terminal transition, so `ended_at` is
 * the only honest attribution timestamp: queued/running rows have NULL usage
 * and would otherwise dilute a window with zeros.
 *
 * The cutoff is computed in JS and compared as a plain string: every stored
 * timestamp is ISO-8601 UTC with milliseconds and a trailing `Z`, a format
 * whose lexicographic order matches chronological order.
 */
function getWindowUsage(cutoffIso: string, provider: string | null): WindowUsage {
  const row = db.all<RawUsageAggregate>(sql`
    SELECT
      COUNT(*) AS sessions,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    WHERE ended_at IS NOT NULL
      AND ended_at >= ${cutoffIso}
      AND (${provider} IS NULL OR COALESCE(provider, 'claude-code') = ${provider})
  `)[0];

  return {
    sessions: count(row?.sessions),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    costUsd: num(row?.cost_usd),
  };
}

/** Rolling, not calendar: "last 7 days" means the last 168 hours, everywhere. */
function cutoffIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Optional weekly Claude budget (global settings key, no project suffix).
 * Anything that is not a positive finite number — absent, null, 0, a string,
 * corrupt JSON — means "no budget", never a budget of zero.
 */
function getClaudeWeeklyBudget(): number | null {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, CLAUDE_WEEKLY_BUDGET_SETTING_KEY))
    .get();
  if (!row) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * Live poll inputs to the assembly (feat/live-quota). Both default to the
 * "no live data" state so every pre-existing `getUsageReport()` call — and
 * every test written against it — keeps compiling and takes the fallback
 * paths byte-for-byte.
 */
export interface LiveQuotaInputs {
  claudeLive: CachedQuota<ClaudeQuota>;
  codexLive: CachedQuota<CodexLiveQuota>;
}

const NO_LIVE: LiveQuotaInputs = {
  claudeLive: { data: null, capturedAtIso: null },
  codexLive: { data: null, capturedAtIso: null },
};

/**
 * Three kinds of truth live in this array, discriminated by the UNCHANGED
 * `source` enum plus the `sourceDetail` refinement and the non-null
 * `claudeLive`/`codexLive` payloads:
 *
 * - **live-cli**: freshly polled from the provider's own CLI (metadata read,
 *   zero tokens; see lib/usage/claude-quota.ts / codex-appserver.ts). Real
 *   account quota, at most QUOTA_TTL_MS old. A poller failure must be
 *   invisible except for the card falling back to the rows below.
 * - **rollout-snapshot** (codex): percentages from codex's own `rate_limits`
 *   events, as fresh as the last rollout file — `capturedAt` verbatim so the
 *   UI can say how old it is. No snapshot => every field null, no invented
 *   gauge.
 * - **arij-sessions** (claude): claude exposes NO account quota to the
 *   metered path, so this is a count of what Arij itself spawned — a floor on
 *   the account's usage, never remaining quota; the card carries that
 *   disclaimer permanently. When claude live data IS present, metered ships
 *   TOO (both truths in one payload — the UI demotes, never the API).
 */
function getSubscriptions(
  byProvider: ProviderUsageRow[],
  live: LiveQuotaInputs,
): SubscriptionStatus[] {
  const result: SubscriptionStatus[] = [];

  const snapshot = db
    .select()
    .from(providerUsageSnapshots)
    .where(eq(providerUsageSnapshots.provider, CODEX_PROVIDER))
    .get();
  const hasCodexSessions = byProvider.some(
    (row) => row.provider === CODEX_PROVIDER,
  );

  const codexLiveData = live.codexLive.data;
  if (codexLiveData) {
    // Primary/secondary mirror the "codex" bucket (fallback buckets[0]) so
    // SnapshotWindow-shaped consumers stay coherent; the full multi-bucket
    // truth rides in `codexLive`.
    const bucket =
      codexLiveData.buckets.find((entry) => entry.limitId === CODEX_PROVIDER) ??
      codexLiveData.buckets[0];
    result.push({
      provider: CODEX_PROVIDER,
      source: "provider-reported",
      sourceDetail: "live-cli",
      plan: codexLiveData.planType,
      capturedAt: live.codexLive.capturedAtIso,
      primary: bucket
        ? {
            usedPercent: bucket.usedPercent,
            windowMinutes: bucket.windowDurationMins,
            resetsAt: bucket.resetsAtUnix,
          }
        : null,
      secondary: bucket?.secondary
        ? {
            usedPercent: bucket.secondary.usedPercent,
            windowMinutes: bucket.secondary.windowDurationMins,
            resetsAt: bucket.secondary.resetsAtUnix,
          }
        : null,
      metered: null,
      claudeLive: null,
      codexLive: codexLiveData,
    });
  } else if (snapshot || hasCodexSessions) {
    // Live poll failed or is disabled: today's rollout-snapshot shape
    // verbatim, plus the three new keys in their fallback state.
    result.push({
      provider: CODEX_PROVIDER,
      source: "provider-reported",
      sourceDetail: "rollout-snapshot",
      plan: snapshot?.planType ?? null,
      capturedAt: snapshot?.capturedAt ?? null,
      primary:
        snapshot && num(snapshot.primaryUsedPercent) !== null
          ? {
              usedPercent: num(snapshot.primaryUsedPercent),
              windowMinutes: num(snapshot.primaryWindowMinutes),
              resetsAt: num(snapshot.primaryResetsAt),
            }
          : null,
      secondary:
        snapshot && num(snapshot.secondaryUsedPercent) !== null
          ? {
              usedPercent: num(snapshot.secondaryUsedPercent),
              windowMinutes: num(snapshot.secondaryWindowMinutes),
              resetsAt: num(snapshot.secondaryResetsAt),
            }
          : null,
      metered: null,
      claudeLive: null,
      codexLive: null,
    });
  }

  // Claude's card is unconditional: the page must always state what Arij
  // itself burned, even on a database with zero sessions. The metered block
  // ships even when live data is present — both truths in one payload.
  const budgetUsdWeek = getClaudeWeeklyBudget();
  const claudeLast5h = getWindowUsage(cutoffIso(FIVE_HOURS_MS), CLAUDE_PROVIDER);
  const claudeLast7d = getWindowUsage(cutoffIso(SEVEN_DAYS_MS), CLAUDE_PROVIDER);
  const spent = claudeLast7d.costUsd;
  const metered = {
    last5h: claudeLast5h,
    last7d: claudeLast7d,
    budgetUsdWeek,
    // Unclamped on purpose: going over budget must read as "142%", not a
    // gauge quietly pinned at 100.
    budgetUsedPercent:
      budgetUsdWeek !== null && spent !== null
        ? Math.round((spent / budgetUsdWeek) * 100)
        : null,
  };

  const claudeLiveData = live.claudeLive.data;
  if (claudeLiveData) {
    result.push({
      provider: CLAUDE_PROVIDER,
      source: "provider-reported",
      sourceDetail: "live-cli",
      plan: claudeLiveData.subscriptionType,
      capturedAt: live.claudeLive.capturedAtIso,
      // Claude windows use ISO resets_at strings; the unix-seconds
      // SubscriptionWindowStatus path stays null ON PURPOSE — the UI reads
      // `claudeLive` exclusively, never a converted hybrid.
      primary: null,
      secondary: null,
      metered,
      claudeLive: claudeLiveData,
      codexLive: null,
    });
  } else {
    result.push({
      provider: CLAUDE_PROVIDER,
      source: "metered-via-arij",
      sourceDetail: "arij-sessions",
      plan: null,
      capturedAt: null,
      primary: null,
      secondary: null,
      metered,
      claudeLive: null,
      codexLive: null,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dashboard block (frame 8d) — range-scoped, additive, reads nothing above
// ---------------------------------------------------------------------------

/**
 * TIMESTAMP DISCIPLINE FOR EVERYTHING BELOW.
 *
 * Every cutoff is computed in JS and bound as a parameter — never
 * `date('now')` in SQL. `getByDay` above does use SQLite's clock, and that is
 * precisely why its tests cannot freeze time: `vi.setSystemTime` does not
 * reach SQLite. The dashboard queries must stay fake-timer-controllable, so
 * the only date function they call is `date(<column>,'localtime')`, which is a
 * formatter, not a clock read.
 *
 * Attribution is `ended_at`, never `created_at`: usage is written exactly once,
 * at the terminal transition, so queued/running rows carry NULL usage and
 * would dilute a window with zeros.
 */

/** Rolling window length per range. `all` = no cutoff whatsoever. */
const RANGE_MS: Record<UsageRange, number | null> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/** How many BY DAY bars a range draws. Capped at 30: a bar per day since the
 *  first session ever is unreadable, so `all` still shows the last 30 days. */
const RANGE_DAY_BARS: Record<UsageRange, number> = {
  "7d": 7,
  "30d": DAY_STRIP_LENGTH,
  all: DAY_STRIP_LENGTH,
};

/** The frame's documented alert threshold on the monthly cap. */
const CAP_ALERT_PERCENT = 80;

/** Anything unrecognised is the default window — same tolerance as `?fresh`. */
export function parseUsageRange(value: string | null | undefined): UsageRange {
  return value === "7d" || value === "all" ? value : "30d";
}

/** ISO instant of local midnight, `daysAgo` local calendar days back. */
function localMidnightIso(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

/** ISO instant of the first moment of the current LOCAL month. */
function localMonthStartIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

interface RawDashboardTotals {
  sessions: number;
  cost_usd: number | null;
}

function getDashboardTotals(since: string | null): {
  sessions: number;
  costUsd: number | null;
} {
  const row = db.all<RawDashboardTotals>(sql`
    SELECT
      COUNT(*) AS sessions,
      SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    WHERE ended_at IS NOT NULL
      AND (${since} IS NULL OR ended_at >= ${since})
  `)[0];

  return { sessions: count(row?.sessions), costUsd: num(row?.cost_usd) };
}

/**
 * `status='completed' AND outcome='answered'` is the codebase's own "delivered"
 * predicate (lib/pipeline/findings.ts, lib/workflow/review-freshness.ts) —
 * deliberately not a new definition.
 *
 * The denominator is sessions with a NON-NULL outcome. `agent_sessions.outcome`
 * is NULL while queued/running, for user-cancelled sessions and on legacy rows;
 * counting those would drag the percentage down for reasons that have nothing
 * to do with cleanliness. No terminal session at all => null => em-dash.
 */
function getCleanPercent(since: string | null): number | null {
  const row = db.all<{ clean: number | null; terminal: number }>(sql`
    SELECT
      SUM(CASE WHEN status = 'completed' AND outcome = 'answered' THEN 1 ELSE 0 END) AS clean,
      COUNT(*) AS terminal
    FROM agent_sessions
    WHERE outcome IS NOT NULL
      AND ended_at IS NOT NULL
      AND (${since} IS NULL OR ended_at >= ${since})
  `)[0];

  const terminal = count(row?.terminal);
  if (terminal === 0) return null;
  return ((num(row?.clean) ?? 0) / terminal) * 100;
}

/**
 * Distinct epics that crossed INTO a terminal column in the window.
 *
 * `COUNT(DISTINCT epic_id)` plus the `from_status` guard stops one ticket being
 * counted twice as it walks `review -> done -> released`. `ticket_activity_log`
 * is unindexed on `to_status` and never pruned, so the window cutoff is not an
 * optimisation, it is what keeps this off a full-table scan.
 *
 * `datetime()` on BOTH sides, unlike every `ended_at` comparison in this file.
 * `agent_sessions.ended_at` is uniformly ISO-8601-with-Z, so raw string order
 * is chronological order there; `ticket_activity_log.created_at` is NOT — rows
 * written through `logTransition` are ISO, rows that fell back to the column's
 * `CURRENT_TIMESTAMP` default are `YYYY-MM-DD HH:MM:SS`, and both formats are
 * present in live databases. A raw compare drops the space-separated rows on
 * the cutoff day, because ' ' sorts before 'T'. `datetime()` reads a clock
 * ONLY for the literal 'now', which is never passed here, so this stays
 * fake-timer-controllable.
 */
function getTicketsShipped(since: string | null): number {
  const row = db.all<{ shipped: number }>(sql`
    SELECT COUNT(DISTINCT epic_id) AS shipped
    FROM ticket_activity_log
    WHERE to_status IN ('done', 'released')
      AND from_status NOT IN ('done', 'released')
      AND (${since} IS NULL OR datetime(created_at) >= datetime(${since}))
  `)[0];

  return count(row?.shipped);
}

/**
 * Optional monthly spend cap (global settings key). Same defensive parse as
 * `getClaudeWeeklyBudget`: absent, null, 0, a string or corrupt JSON all mean
 * "no cap", never a cap of zero — which is what keeps "no cap" and "a cap of
 * zero" distinguishable after the inline editor writes `null` to clear it.
 */
function getMonthlyCapUsd(): number | null {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, MONTHLY_CAP_SETTING_KEY))
    .get();
  if (!row) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * The cap is a CALENDAR-month figure, unlike every rolling window on this
 * screen: a "plafond mensuel" that slid would never reset. The month start is
 * built from local getters for the same reason `localDateKey` exists.
 */
function getMonthlyCap(): UsageMonthlyCap {
  const capUsd = getMonthlyCapUsd();
  const monthStart = localMonthStartIso();
  const row = db.all<{ cost_usd: number | null }>(sql`
    SELECT SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    WHERE ended_at IS NOT NULL
      AND ended_at >= ${monthStart}
  `)[0];
  const spentUsd = num(row?.cost_usd);

  return {
    capUsd,
    spentUsd,
    // Unclamped on purpose, mirroring `budgetUsedPercent`: going over the cap
    // must read as "142%", not a gauge quietly pinned at 100. The BAR clamps;
    // the readout never does.
    usedPercent:
      capUsd !== null && spentUsd !== null
        ? Math.round((spentUsd / capUsd) * 100)
        : null,
    alertPercent: CAP_ALERT_PERCENT,
  };
}

interface RawBarRow {
  key_a: string | null;
  key_b: string | null;
  label: string | null;
  sessions: number;
  cost_usd: number | null;
  color_index?: number | null;
}

/**
 * Share of the BAND TOTAL (not of the max) — verified against the frame:
 * $96/$52/$22/$14 over a $184 total renders 52/28/12/8%. When the band total
 * is null or 0 every share is null and the row draws a track with no fill.
 */
function withSharePercent<T extends { costUsd: number | null }>(
  rows: T[],
): (T & { sharePercent: number | null })[] {
  const total = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  return rows.map((row) => ({
    ...row,
    sharePercent:
      total > 0 && row.costUsd !== null ? (row.costUsd / total) * 100 : null,
  }));
}

/**
 * Same grouping key as `getByAgent` — `named_agent_name x normalized provider`,
 * which is also the key the Agent Config Stats tab uses, so the three surfaces
 * can never disagree on a run count.
 */
function getDashboardByAgent(since: string | null): UsageBar[] {
  const rows = db.all<RawBarRow>(sql`
    SELECT
      named_agent_name AS key_a,
      COALESCE(provider, 'claude-code') AS key_b,
      named_agent_name AS label,
      COUNT(*) AS sessions,
      SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    WHERE ended_at IS NOT NULL
      AND (${since} IS NULL OR ended_at >= ${since})
    GROUP BY named_agent_name, COALESCE(provider, 'claude-code')
    ORDER BY
      (SUM(total_cost_usd) IS NULL),
      SUM(total_cost_usd) DESC,
      COUNT(*) DESC
  `);

  return withSharePercent(
    rows.map((row) => ({
      key: `${str(row.key_a) ?? ""}|${str(row.key_b) ?? CLAUDE_PROVIDER}`,
      label: str(row.label) ?? "Unnamed",
      costUsd: num(row.cost_usd),
      sessions: count(row.sessions),
    })),
  );
}

/**
 * `projects.color_index` does not exist in the schema yet (the redesign ships
 * no migration). The column is probed rather than assumed so the identity
 * colour becomes real the day it lands, and until then every row reports
 * `colorIndex: null` and the UI hashes the project id instead — never the
 * array position, which reshuffles whenever any project is touched.
 */
function projectsHaveColorIndex(): boolean {
  try {
    return db
      .all<{ name: string }>(sql`PRAGMA table_info(projects)`)
      .some((column) => column.name === "color_index");
  } catch {
    return false;
  }
}

/** LEFT JOIN, not INNER: a session whose project row was deleted still spent
 *  real money and must keep showing up. */
function getDashboardByProject(since: string | null): UsageProjectBar[] {
  const withColor = projectsHaveColorIndex();
  const rows = db.all<RawBarRow>(sql`
    SELECT
      s.project_id AS key_a,
      p.name AS label,
      ${withColor ? sql`p.color_index` : sql`NULL`} AS color_index,
      COUNT(*) AS sessions,
      SUM(s.total_cost_usd) AS cost_usd
    FROM agent_sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.ended_at IS NOT NULL
      AND (${since} IS NULL OR s.ended_at >= ${since})
    GROUP BY s.project_id
    ORDER BY
      (SUM(s.total_cost_usd) IS NULL),
      SUM(s.total_cost_usd) DESC,
      COUNT(*) DESC
  `);

  return withSharePercent(
    rows.map((row) => {
      const projectId = str(row.key_a) ?? "";
      return {
        key: projectId,
        projectId,
        // The raw id when the project row was deleted, and an explicit label
        // when the session carried no project at all — never a blank cell.
        label: str(row.label) ?? (projectId || "No project"),
        colorIndex: num(row.color_index),
        costUsd: num(row.cost_usd),
        sessions: count(row.sessions),
      };
    }),
  );
}

interface RawDashboardDayRow {
  day: string;
  sessions: number;
  cost_usd: number | null;
  failed: number | null;
}

/**
 * Same zero-fill discipline as `getByDay`: days with no terminal session are
 * `{ sessions: 0, costUsd: null, failedSessions: 0 }` — zero runs is a fact,
 * zero dollars would be a claim.
 *
 * The cutoff is local midnight `bars - 1` days ago, computed in JS, so the
 * whole query is fake-timer-controllable.
 */
function getDashboardByDay(bars: number): UsageDayBar[] {
  const cutoff = localMidnightIso(bars - 1);
  const rows = db.all<RawDashboardDayRow>(sql`
    SELECT
      date(ended_at, 'localtime') AS day,
      COUNT(*) AS sessions,
      SUM(total_cost_usd) AS cost_usd,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM agent_sessions
    WHERE ended_at IS NOT NULL
      AND ended_at >= ${cutoff}
    GROUP BY day
  `);

  const byDate = new Map<string, RawDashboardDayRow>();
  for (const row of rows) {
    if (typeof row.day === "string") byDate.set(row.day, row);
  }

  const result: UsageDayBar[] = [];
  for (let offset = bars - 1; offset >= 0; offset--) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    const hit = byDate.get(key);
    result.push(
      hit
        ? {
            date: key,
            sessions: count(hit.sessions),
            costUsd: num(hit.cost_usd),
            failedSessions: count(hit.failed),
          }
        : { date: key, sessions: 0, costUsd: null, failedSessions: 0 },
    );
  }
  return result;
}

/**
 * Yesterday's night-run spend.
 *
 * Night runs have NO table — `lib/night/registry.ts` is in-process state a
 * restart wipes — but `agent_sessions.batch_run_id` is durable and every night
 * run id carries the `night_` prefix (lib/night/constants.ts). The underscore
 * is escaped: unescaped it is a LIKE wildcard and `nightXrun` would match.
 *
 * null (no night sessions yesterday, or none reported a cost) drops the
 * footnote's tail rather than printing "$0".
 */
function getNightYesterdayUsd(): number | null {
  const yesterdayStart = localMidnightIso(1);
  const todayStart = localMidnightIso(0);
  const row = db.all<{ cost_usd: number | null }>(sql`
    SELECT SUM(total_cost_usd) AS cost_usd
    FROM agent_sessions
    WHERE batch_run_id LIKE 'night!_%' ESCAPE '!'
      AND ended_at >= ${yesterdayStart}
      AND ended_at < ${todayStart}
  `)[0];

  return num(row?.cost_usd);
}

/** The whole 8d block, in one place, for one range. */
function getDashboard(range: UsageRange): UsageDashboard {
  const windowMs = RANGE_MS[range];
  const since = windowMs === null ? null : cutoffIso(windowMs);

  const { sessions, costUsd } = getDashboardTotals(since);
  const ticketsShipped = getTicketsShipped(since);

  return {
    range,
    since,
    totals: {
      costUsd,
      sessions,
      cleanPercent: getCleanPercent(since),
      ticketsShipped,
      // Division by zero is not a dollar figure: nothing shipped => null =>
      // em-dash. Never Infinity, never 0.
      costPerTicketUsd:
        costUsd !== null && ticketsShipped > 0 ? costUsd / ticketsShipped : null,
    },
    cap: getMonthlyCap(),
    byAgent: getDashboardByAgent(since),
    byProject: getDashboardByProject(since),
    byDay: getDashboardByDay(RANGE_DAY_BARS[range]),
    nightYesterdayUsd: getNightYesterdayUsd(),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * One fat read for the whole Usage page — a handful of grouped statements.
 * `live` is optional and defaults to the no-live state so existing callers
 * and tests take the fallback paths unchanged. Codex `dailyUsage` lands ONLY
 * inside `subscriptions[codex].codexLive` — `byDay` stays Arij-metered
 * (exactly 30 zero-filled local days), the two histories are different
 * populations (all devices vs this machine) and must never merge.
 *
 * `range` scopes ONLY the additive `dashboard` block; the eight original keys
 * keep their all-time / 30-day / rolling semantics byte-for-byte. It defaults
 * to "30d" so a zero-arg `getUsageReport()` stays exactly today's call.
 */
export function getUsageReport(
  live: LiveQuotaInputs = NO_LIVE,
  range: UsageRange = "30d",
): UsageReport {
  const byProvider = getByProvider();
  const windows = {
    last5h: getWindowUsage(cutoffIso(FIVE_HOURS_MS), null),
    last7d: getWindowUsage(cutoffIso(SEVEN_DAYS_MS), null),
  };

  return {
    totals: getTotals(),
    byAgent: getByAgent(),
    byProvider,
    byProject: getByProject(),
    byDay: getByDay(),
    windows,
    subscriptions: getSubscriptions(byProvider, live),
    generatedAt: new Date().toISOString(),
    dashboard: getDashboard(range),
  };
}
