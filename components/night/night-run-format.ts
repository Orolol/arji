/**
 * Presentational helpers for the night-run surfaces (dialog headline, epic
 * rows, monitor chip). Pure and client-safe: the server has its own copy of
 * the summary wording in `buildNightRunSummaryTitle` (lib/notifications) —
 * this module never imports it, so the browser bundle stays free of db code.
 *
 * NO COPY IN THIS FILE. The status table holds catalogue KEY REFERENCES and
 * the two composing functions take their phrases ALREADY RESOLVED, in a
 * `copy` object supplied by the caller (`lib/i18n/catalogue.ts`, pattern 3):
 * this module composes, it does not word. That keeps every key a literal at a
 * real `useTranslations` call site while the table itself stays plain data —
 * it is evaluated at import time and read by logic that never renders text.
 */

import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { NIGHT_STOPPED_ABORT_REASON } from "@/lib/night/constants";
import { formatElapsed } from "@/lib/utils/format-elapsed";

/**
 * Per-status wording. `done` reads "to merge" and `asked` reads "paused"
 * because a night run never merges anything: a green epic's passing review
 * lands it in To Merge awaiting the morning merge, and a question parks the
 * run.
 */
export const NIGHT_RUN_STATUS_LABEL_KEYS: Record<
  TicketExecutionStatus,
  TranslationKey
> = {
  done: "NightRuns.status.done",
  asked: "NightRuns.status.asked",
  failed: "NightRuns.status.failed",
  skipped: "NightRuns.status.skipped",
  running: "NightRuns.status.running",
  pending: "NightRuns.status.pending",
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
 * The phrases the headline is made of, already resolved by the caller's
 * translator. `NightRuns.counts.bucket` carries the count/word order and
 * `NightRuns.status.*` the words themselves.
 */
export interface NightRunCountsCopy {
  bucket: (count: number, label: string) => string;
  statusLabel: (status: TicketExecutionStatus) => string;
  none: string;
}

/**
 * "5 in review, 1 paused, 2 failed" — zero buckets are omitted. Returns
 * "no epics" when the run produced nothing at all (interrupted before the
 * first wave settled).
 */
export function formatNightRunCounts(
  counts: Partial<Record<TicketExecutionStatus, number>> | null | undefined,
  copy: NightRunCountsCopy
): string {
  const parts: string[] = [];
  for (const status of HEADLINE_ORDER) {
    const value = counts?.[status] ?? 0;
    if (value > 0) {
      parts.push(copy.bucket(value, copy.statusLabel(status)));
    }
  }
  return parts.length > 0 ? parts.join(", ") : copy.none;
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
 * The two sentences the banner can carry, already resolved by the caller's
 * translator. The wave number decides between the `…AtWave` variant and the
 * plain one, so neither reads as a fragment a translator has to reassemble.
 */
export interface NightRunAbortCopy {
  stopped: (wave: number | null) => string;
  other: (reason: string, wave: number | null) => string;
}

/**
 * Banner sentence for the summary dialog. A user stop is not an incident —
 * it gets its own neutral wording instead of the "Run stopped early: <engine
 * reason>" phrasing the breaker/cost aborts use.
 *
 * `abortReason` is the ENGINE's own string, server-generated and deliberately
 * left out of the catalogue (`lib/i18n/catalogue.ts`, point 5); it rides
 * through as an argument.
 */
export function nightRunAbortSentence(
  abortReason: string | null | undefined,
  abortedAtWave: number | null | undefined,
  copy: NightRunAbortCopy
): string | null {
  const kind = nightRunAbortKind(abortReason);
  if (!kind) return null;
  const wave = abortedAtWave ?? null;
  if (kind === "stopped") return copy.stopped(wave);
  return copy.other(abortReason as string, wave);
}
