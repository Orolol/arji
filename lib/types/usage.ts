/**
 * Shared API contract for the usage observatory.
 * Server: lib/usage/aggregate.ts + app/api/usage/route.ts.
 * Client: hooks/useUsage.ts + app/usage/page.tsx via `import type` ONLY
 * (type-only imports erase at runtime, keeping the builders decoupled).
 *
 * Number-or-null semantics: null means "provider never reported this"
 * (e.g. codex token/cost columns) — render an em-dash, never 0.
 */

export interface UsageTotals {
  sessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface AgentUsageRow {
  namedAgentId: string | null;
  name: string | null;          // null = sessions with no named agent
  provider: string;
  sessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  lastActiveAt: string | null;  // ISO UTC
}

export interface ProviderUsageRow {
  provider: string;
  sessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface ProjectUsageRow {
  projectId: string;
  projectName: string | null;
  sessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface DayUsageRow {
  date: string;                 // local calendar date, "YYYY-MM-DD"
  sessions: number;
  costUsd: number | null;
}

export interface WindowUsage {
  sessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface SubscriptionWindowStatus {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;      // unix SECONDS (provider-emitted)
}

/* ----- Live provider quota (spawned-CLI metadata reads; PR feat/live-quota) ----- */

/** One claude rate-limit window. resetsAtIso is the provider's ISO-8601 STRING,
 *  passed through verbatim — claude emits ISO strings, codex emits unix seconds;
 *  the two parsers are separate on purpose and must never share conversion code. */
export interface ClaudeQuotaWindow {
  utilizationPercent: number;   // 0-100 as emitted ("utilization")
  resetsAtIso: string | null;   // ISO-8601 as emitted ("resets_at")
}

export interface ClaudeModelScopedWindow extends ClaudeQuotaWindow {
  displayName: string;          // "display_name", e.g. "Opus 4.5"
}

export interface ClaudeExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilizationPercent: number | null;
}

/** Stable subset of claude 2.1.221 get_usage. Gate: rate_limits_available === true
 *  (false ⇒ the poller returns null, never a partial object). */
export interface ClaudeQuota {
  subscriptionType: string | null;        // "max"
  fiveHour: ClaudeQuotaWindow | null;
  sevenDay: ClaudeQuotaWindow | null;
  sevenDayOpus: ClaudeQuotaWindow | null;   // optional in the wire shape
  sevenDaySonnet: ClaudeQuotaWindow | null; // optional in the wire shape
  modelScoped: ClaudeModelScopedWindow[];   // [] when absent
  extraUsage: ClaudeExtraUsage | null;
}

/** One bucket from codex rateLimitsByLimitId. Window semantics are NOT constant
 *  (this account moved 300/10080 → 10080/null); render what is delivered. */
export interface CodexQuotaBucket {
  limitId: string;                 // "codex", "codex_bengalfox", ...
  limitName: string | null;        // "GPT-5.3-Codex-Spark" | null
  usedPercent: number;             // primary.usedPercent
  windowDurationMins: number | null;
  resetsAtUnix: number | null;     // unix SECONDS
  secondary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAtUnix: number | null;
  } | null;                        // CAN BE NULL (is null on this account today)
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;          // provider sends a string, e.g. "0"
}

export interface CodexDailyUsageDay {
  date: string;                    // provider "startDate", "YYYY-MM-DD" — sparse
  tokens: number;
}

/** Stable subset of codex 0.141.0 account/rateLimits/read + account/usage/read. */
export interface CodexLiveQuota {
  planType: string | null;         // "prolite"
  buckets: CodexQuotaBucket[];     // ALL of rateLimitsByLimitId, "codex" first,
                                   // rest in object-key order; ≥1 entry required
  credits: CodexCredits | null;
  dailyUsage: CodexDailyUsageDay[]; // as delivered (sparse, ascending) — SERVER-SIDE,
                                    // all devices, NOT Arij-metered
  lifetimeTokens: number | null;
}

export type SubscriptionSourceDetail =
  | "live-cli"           // freshly polled from the provider CLI (quota-cache)
  | "rollout-snapshot"   // codex ~/.codex/sessions replay (existing path)
  | "arij-sessions";     // metered from Arij's own DB (existing path)

export interface SubscriptionStatus {
  provider: string;             // "codex" | "claude-code"
  source: "provider-reported" | "metered-via-arij";   // UNCHANGED enum
  sourceDetail: SubscriptionSourceDetail;              // NEW (feat/live-quota)
  plan: string | null;
  capturedAt: string | null;    // live-cli: poll wall-clock ISO; rollout: snapshot capturedAt
  primary: SubscriptionWindowStatus | null;
  secondary: SubscriptionWindowStatus | null;
  metered: {
    last5h: WindowUsage;
    last7d: WindowUsage;
    budgetUsdWeek: number | null;
    budgetUsedPercent: number | null; // unclamped, integer-rounded; null without budget
  } | null;                     // metered-via-arij only
  claudeLive: ClaudeQuota | null;    // NEW — non-null only for claude-code + live-cli
  codexLive: CodexLiveQuota | null;  // NEW — non-null only for codex + live-cli
}

/* ----- The 8d dashboard block (range-scoped; the screen reads ONLY this) ----- */

/**
 * The three windows the header's segmented control offers. `all` means "no
 * cutoff at all", NOT "a very long window" — `UsageDashboard.since` is null
 * for it so a reader can tell the two apart.
 */
export type UsageRange = "7d" | "30d" | "all";

/** One name/value bar in BY AGENT or BY PROJECT. */
export interface UsageBar {
  key: string;                 // stable react key: "name|provider" or projectId
  label: string;               // display label, already resolved
  costUsd: number | null;      // null = the group never reported a cost
  sessions: number;
  /** 0-100, share of the band's total cost; null when the band total is null/0. */
  sharePercent: number | null;
}

export interface UsageProjectBar extends UsageBar {
  projectId: string;
  /**
   * `projects.color_index` when that column exists; null on every row today
   * (the column is not in the schema yet — see lib/usage/aggregate.ts). The UI
   * falls back to a stable hash of `projectId`, never to array position.
   */
  colorIndex: number | null;
}

export interface UsageDayBar {
  date: string;                // local "YYYY-MM-DD"
  sessions: number;
  costUsd: number | null;
  /**
   * `status='failed'` sessions that ENDED that day; 0 is a fact, not a claim.
   * A failed session that never received an `ended_at` is invisible here,
   * exactly as it is invisible to `byDay` — usage is written once, at the
   * terminal transition.
   */
  failedSessions: number;
}

export interface UsageMonthlyCap {
  capUsd: number | null;       // settings key; null = never configured
  spentUsd: number | null;     // month-to-date spend; null = nothing reported
  usedPercent: number | null;  // UNCLAMPED, integer-rounded; null without a cap
  alertPercent: number;        // always 80 — the frame's documented threshold
}

export interface UsageDashboard {
  range: UsageRange;
  /** ISO cutoff used for every figure in this block; null for "all". */
  since: string | null;
  totals: {
    costUsd: number | null;
    sessions: number;
    /** 0-100. completed+answered over sessions with a non-null outcome; null when no terminal session exists. */
    cleanPercent: number | null;
    /** Distinct epics that reached done/released in the window; null when the log is empty for it. */
    ticketsShipped: number | null;
    costPerTicketUsd: number | null;
  };
  cap: UsageMonthlyCap;
  byAgent: UsageBar[];          // cost desc, nulls last
  byProject: UsageProjectBar[]; // cost desc, nulls last
  byDay: UsageDayBar[];         // min(rangeDays, 30) entries, oldest first, zero-filled
  /** Yesterday's night-run spend (batch_run_id LIKE 'night\_%'); null when none ran. */
  nightYesterdayUsd: number | null;
}

export interface UsageReport {
  totals: UsageTotals;
  byAgent: AgentUsageRow[];     // sorted cost desc, nulls last, then sessions desc
  byProvider: ProviderUsageRow[];
  byProject: ProjectUsageRow[];
  byDay: DayUsageRow[];         // EXACTLY 30 entries, oldest first, zero-filled
  windows: { last5h: WindowUsage; last7d: WindowUsage };
  subscriptions: SubscriptionStatus[];
  generatedAt: string;          // ISO UTC
  /**
   * The range-scoped block frame 8d renders. The eight keys above keep their
   * pre-existing all-time / 30-day / rolling semantics untouched — they still
   * feed `subscriptions` and the legacy consumers.
   */
  dashboard: UsageDashboard;
}

/** Global settings key (no project suffix): optional weekly Claude budget in USD. */
export const CLAUDE_WEEKLY_BUDGET_SETTING_KEY = "usage_budget_usd_7d_claude";

/**
 * Global settings key: optional monthly spend cap in USD (frame 8d, PLAFOND
 * MENSUEL). Lives in the generic `settings` key/value table — deliberately NOT
 * a new column or table. Distinct from CLAUDE_WEEKLY_BUDGET_SETTING_KEY, which
 * is a WEEKLY CLAUDE budget: different window, different population.
 */
export const MONTHLY_CAP_SETTING_KEY = "usage_budget_usd_month";
