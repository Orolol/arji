/**
 * Presentational helpers for the night-run surfaces (dialog headline, epic
 * rows, monitor chip). Pure and client-safe: the server has its own copy of
 * the summary wording in `buildNightRunSummaryTitle` (lib/notifications) —
 * this module never imports it, so the browser bundle stays free of db code.
 */

import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";
import { NIGHT_STOPPED_ABORT_REASON } from "@/lib/night/constants";
import { formatElapsed } from "@/lib/utils/format-elapsed";

/**
 * Per-status wording. `done` reads "to merge" and `asked` reads "paused"
 * because a night run never merges anything: a green epic's passing review
 * lands it in To Merge awaiting the morning merge, and a question parks the
 * run.
 */
export const NIGHT_RUN_STATUS_LABELS: Record<TicketExecutionStatus, string> = {
  done: "to merge",
  asked: "paused",
  failed: "failed",
  skipped: "skipped",
  running: "running",
  pending: "pending",
};

/** Order buckets appear in the headline — outcomes first, then leftovers. */
const HEADLINE_ORDER: TicketExecutionStatus[] = [
  "done",
  "asked",
  "failed",
  "skipped",
  "running",
  "pending",
];

/**
 * "5 in review, 1 paused, 2 failed" — zero buckets are omitted. Returns
 * "no epics" when the run produced nothing at all (interrupted before the
 * first wave settled).
 */
export function formatNightRunCounts(
  counts: Partial<Record<TicketExecutionStatus, number>> | null | undefined
): string {
  const parts: string[] = [];
  for (const status of HEADLINE_ORDER) {
    const value = counts?.[status] ?? 0;
    if (value > 0) {
      parts.push(`${value} ${NIGHT_RUN_STATUS_LABELS[status]}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "no epics";
}

/**
 * "$4.20", or "≥$4.20" when at least one session reported no cost (only
 * Claude Code returns `total_cost_usd`, so other providers are invisible).
 * Returns null when nothing was reported at all.
 */
export function formatNightRunCost(
  totalCostUsd: number | null | undefined,
  costIsPartial: boolean
): string | null {
  if (totalCostUsd == null || !Number.isFinite(totalCostUsd)) return null;
  if (totalCostUsd <= 0) return null;
  return `${costIsPartial ? "≥" : ""}$${totalCostUsd.toFixed(2)}`;
}

/** Wall-clock span of a run; "—" while it is still going and unknown. */
export function formatNightRunDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): string {
  if (!startedAt) return "—";
  const end = endedAt ? new Date(endedAt) : new Date();
  if (Number.isNaN(end.getTime())) return "—";
  return formatElapsed(startedAt, end);
}

/** Why a run ended before its last wave. */
export type NightRunAbortKind = "stopped" | "breaker" | "cost" | "other";

/**
 * Human sentence for the reason a run stopped early. The engine emits
 * "stopped by user", "circuit breaker: N consecutive pipeline failures" and
 * "cost cap reached: $X of $Y" — all already readable, so this only
 * classifies them for styling/testing.
 */
export function nightRunAbortKind(
  abortReason: string | null | undefined
): NightRunAbortKind | null {
  if (!abortReason) return null;
  if (abortReason === NIGHT_STOPPED_ABORT_REASON) return "stopped";
  if (abortReason.startsWith("circuit breaker")) return "breaker";
  if (abortReason.startsWith("cost cap")) return "cost";
  return "other";
}

/**
 * Banner sentence for the summary dialog. A user stop is not an incident —
 * it gets its own neutral wording instead of the "Run stopped early: <engine
 * reason>" phrasing the breaker/cost aborts use.
 */
export function nightRunAbortSentence(
  abortReason: string | null | undefined,
  abortedAtWave: number | null | undefined
): string | null {
  const kind = nightRunAbortKind(abortReason);
  if (!kind) return null;
  const after = abortedAtWave != null ? ` (after wave ${abortedAtWave})` : "";
  if (kind === "stopped") {
    return `You stopped this run${after}. Epics already running were left to finish; the rest were skipped.`;
  }
  return `Run stopped early: ${abortReason}${after}. Remaining epics were skipped.`;
}
