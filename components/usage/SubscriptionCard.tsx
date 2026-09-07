"use client";

import { useLocale, useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import {
  FieldKicker,
  Mono,
  ProgressTrack,
  SurfaceCard,
} from "@/components/piscine";
import { cn } from "@/lib/utils";
import { formatCostUsd, formatTokens } from "@/lib/utils/format-usage";
import { formatDayLabel, formatRelative } from "@/lib/i18n/format";
import {
  formatCountdown,
  numberOrDash,
  parseIsoMs,
  providerLabel,
  windowLabel,
  type WindowLabelCopy,
} from "@/components/usage/formatters";
import type {
  ClaudeQuota,
  ClaudeQuotaWindow,
  CodexLiveQuota,
  CodexQuotaBucket,
  SubscriptionStatus,
  SubscriptionWindowStatus,
  WindowUsage,
} from "@/lib/types/usage";

/* -------------------------------------------------------------------------- */
/* Subscription cards                                                         */
/*                                                                            */
/* Lifted out of app/usage/page.tsx for the frame 8d re-skin and then actually */
/* converted to the Piscine language (the first pass moved the markup          */
/* verbatim, which left a legacy "cassette pêche" block sitting inside 8d):    */
/*                                                                            */
/*   - the shell is a `SurfaceCard` (radius 12 — this is a card, not a band);  */
/*   - every uppercase micro-label is a `FieldKicker`, i.e. TRACKED MONO, the  */
/*     one thing the system allows below the 11px floor. The old labels were   */
/*     10.5px Instrument Sans, which the floor does not exempt;                */
/*   - every mono run is a `Mono`, so tabular figures are not optional;        */
/*   - every gauge is a determinate `ProgressTrack` instead of a hand-rolled   */
/*     copy of its recipe;                                                     */
/*   - the two rules left in the card are 1.5px, the house border weight;      */
/*   - STALENESS IS NO LONGER A COLOUR. It used to be `text-priority-yellow`,  */
/*     which is colour encoding state — the one rule the system never bends.   */
/*     It is now an icon plus the word "stale", per "state is icon + word +    */
/*     motion".                                                                */
/*                                                                            */
/* Every testid, every string and every number on screen is unchanged.         */
/*                                                                            */
/* The frame does not draw these cards. That is a coverage gap in the design,  */
/* not a deletion order: they are the only place in the app that answers       */
/* "what does the provider itself say about my account quota".                 */
/* -------------------------------------------------------------------------- */

/**
 * `windowLabel` is a pure helper, so it takes RESOLVED PHRASES rather than a
 * translator (`lib/i18n/catalogue.ts`). This is where they are resolved, next
 * to their keys.
 */
function useWindowCopy(): WindowLabelCopy {
  const t = useTranslations("Usage");
  return {
    unknown: t("window.unknown"),
    weekly: t("window.weekly"),
    days: (count) => t("window.days", { count }),
    hours: (count) => t("window.hours", { count }),
    minutes: (count) => t("window.minutes", { count }),
  };
}

/**
 * The one "this data is old" marker in the card. Colour is not available to
 * say it (colour = stratum, never state), so it is said with an icon and a
 * word — the same way `ResetLine` says "window expired — data stale".
 */
function StaleMark() {
  return (
    <>
      <TriangleAlert
        width={11}
        height={11}
        aria-hidden="true"
        className="inline-block shrink-0 align-[-1px]"
      />{" "}
    </>
  );
}

/**
 * `nowMs` is the report's own generation time, not a render-time clock read:
 * the card renders a snapshot as-of the fetch, stays pure across re-renders
 * (react-hooks/purity), and the next Refresh moves the anchor forward.
 */
export function SubscriptionCard({
  sub,
  nowMs,
}: {
  sub: SubscriptionStatus;
  nowMs: number;
}) {
  const t = useTranslations("Usage");
  return (
    <SurfaceCard
      radius={12}
      className="w-[340px] max-w-full p-[16px]"
      data-testid={`usage-sub-${sub.provider}`}
    >
      <div className="flex items-center justify-between gap-[10px]">
        <Mono size={11.5} weight={700} uppercase tracking={0.08} tone="muted">
          {providerLabel(sub.provider)}
        </Mono>
        <span
          className="shrink-0 rounded-full border-[1.5px] border-border-soft px-[7px] py-[2px]"
          data-testid={`usage-sub-${sub.provider}-source`}
        >
          <FieldKicker size={10.5} stratum="card">
            {sub.source === "provider-reported"
              ? t("subscription.sourceProviderReported")
              : t("subscription.sourceMetered")}
          </FieldKicker>
        </span>
      </div>

      {sub.plan && (
        <Mono as="div" size={11} tone="muted" className="mt-[6px]">
          {t("subscription.plan", { plan: sub.plan })}
        </Mono>
      )}

      {/*
        Body precedence: a live CLI poll wins over every derived view. The
        `source` pill above already flips to "Provider-reported" via the API,
        so the discriminator here is the payload itself (§2c: `claudeLive` /
        `codexLive` are non-null only for `sourceDetail: "live-cli"`).
      */}
      {sub.claudeLive ? (
        <ClaudeLiveBody sub={sub} live={sub.claudeLive} nowMs={nowMs} />
      ) : sub.codexLive ? (
        <CodexLiveBody sub={sub} live={sub.codexLive} nowMs={nowMs} />
      ) : sub.metered ? (
        <MeteredBody sub={sub} metered={sub.metered} />
      ) : (
        <ProviderReportedBody sub={sub} nowMs={nowMs} />
      )}
    </SurfaceCard>
  );
}

/* ----- Live: claude ------------------------------------------------------ */

/**
 * Claude's own account quota, as answered by `claude` over a
 * `control_request get_usage` metadata read (no prompt, zero model tokens).
 *
 * Every gauge here is a `utilization` the provider emitted; nothing is
 * derived, summed or extrapolated. The Arij meter still ships below the
 * divider because it answers a different question ("what did THIS machine
 * spend") — the two are labelled, never blended.
 */
function ClaudeLiveBody({
  sub,
  live,
  nowMs,
}: {
  sub: SubscriptionStatus;
  live: ClaudeQuota;
  nowMs: number;
}) {
  const locale = useLocale();
  const t = useTranslations("Usage");
  const capturedMs =
    sub.capturedAt === null ? null : new Date(sub.capturedAt).getTime();
  const ageMs =
    capturedMs === null || Number.isNaN(capturedMs) ? null : nowMs - capturedMs;
  const stale = ageMs !== null && ageMs > 24 * 3600_000;
  const extra = live.extraUsage;

  return (
    <>
      <ClaudeWindow
        label={t("subscription.claudeFiveHour")}
        window={live.fiveHour}
        nowMs={nowMs}
        testId="usage-sub-claude-live-5h"
      />
      <ClaudeWindow
        label={t("subscription.claudeSevenDay")}
        window={live.sevenDay}
        nowMs={nowMs}
        testId="usage-sub-claude-live-7d"
      />
      <ClaudeWindow
        label={t("subscription.claudeSevenDayOpus")}
        window={live.sevenDayOpus}
        nowMs={nowMs}
        testId="usage-sub-claude-live-7d-opus"
      />
      <ClaudeWindow
        label={t("subscription.claudeSevenDaySonnet")}
        window={live.sevenDaySonnet}
        nowMs={nowMs}
        testId="usage-sub-claude-live-7d-sonnet"
      />

      {live.modelScoped
        // A model already shown as a named window (7D OPUS / 7D SONNET)
        // would render as a confusing duplicate gauge — skip it here.
        .filter((model) => {
          const name = model.displayName.toLowerCase();
          if (live.sevenDayOpus !== null && name.includes("opus")) return false;
          if (live.sevenDaySonnet !== null && name.includes("sonnet")) return false;
          return true;
        })
        .map((model, i) => (
          <ClaudeWindow
            key={`${model.displayName}-${i}`}
            label={model.displayName.toUpperCase()}
            window={model}
            nowMs={nowMs}
            testId={`usage-sub-claude-live-model-${i}`}
          />
        ))}

      {extra?.isEnabled && (
        // `Mono` takes no arbitrary DOM props, so the testid lives on a
        // wrapper rather than on a hand-rolled copy of its class recipe.
        <div className="mt-[12px]" data-testid="usage-sub-claude-extra">
          <Mono size={11} tone="muted">
            {t("subscription.extraUsage", {
              used: numberOrDash(extra.usedCredits),
              limit: numberOrDash(extra.monthlyLimit),
              percent: numberOrDash(extra.utilizationPercent),
            })}
          </Mono>
        </div>
      )}

      {ageMs !== null && (
        <p
          className="mt-[12px] text-[11px] text-meta"
          data-stale={stale ? "" : undefined}
          data-testid="usage-sub-claude-captured"
        >
          {stale && <StaleMark />}
          {t("subscription.polledClaude", {
            age: formatRelative(nowMs - ageMs, { locale, now: nowMs }),
          })}
          {stale ? ` ${t("subscription.stale")}` : ""}
        </p>
      )}

      {sub.metered && (
        <div className="mt-[14px] border-t-[1.5px] border-border-soft pt-[10px]">
          {/*
            Demoted rendering: the standalone disclaimer sentence is dropped
            because this section label already says exactly what these numbers
            are — and unlike the fallback card, an account-wide truth is
            visible right above it.
          */}
          <span data-testid="usage-sub-claude-metered-sub">
            <FieldKicker size={10.5} stratum="card">
              {t("subscription.meteredSection")}
            </FieldKicker>
          </span>
          <MeteredLine
            label={t("subscription.last5h")}
            usage={sub.metered.last5h}
            testId={`usage-sub-${sub.provider}-5h`}
          />
          <MeteredLine
            label={t("subscription.last7d")}
            usage={sub.metered.last7d}
            testId={`usage-sub-${sub.provider}-7d`}
          />
          {sub.metered.budgetUsdWeek !== null && (
            <GaugeRow
              label={t("subscription.weeklyBudget")}
              readout={`${formatCostUsd(sub.metered.last7d.costUsd) ?? "—"} / ${
                formatCostUsd(sub.metered.budgetUsdWeek) ?? "—"
              }`}
              percent={sub.metered.budgetUsedPercent}
              alarm={
                sub.metered.budgetUsedPercent !== null &&
                sub.metered.budgetUsedPercent > 100
              }
              testId="usage-sub-claude-budget"
            />
          )}
        </div>
      )}
    </>
  );
}

/**
 * One claude rate-limit window. Claude emits `resets_at` as an ISO-8601
 * STRING; codex emits unix SECONDS. The two conversions live at their own
 * call sites on purpose and must never be merged — only the rendered reset
 * sentence (which takes an already-computed duration) is shared.
 */
function ClaudeWindow({
  label,
  window,
  nowMs,
  testId,
}: {
  label: string;
  window: ClaudeQuotaWindow | null;
  nowMs: number;
  testId: string;
}) {
  if (!window) return null;

  const resetsAtMs = parseIsoMs(window.resetsAtIso);
  const remainingMs = resetsAtMs === null ? null : resetsAtMs - nowMs;

  return (
    <>
      <GaugeRow
        label={label}
        readout={`${Math.round(window.utilizationPercent)}%`}
        percent={window.utilizationPercent}
        dimmed={remainingMs !== null && remainingMs <= 0}
        testId={testId}
      />
      <ResetLine remainingMs={remainingMs} testId={testId} />
    </>
  );
}

/* ----- Live: codex ------------------------------------------------------- */

/**
 * Codex's own account quota, as answered by `codex app-server` over
 * `account/rateLimits/read` + `account/usage/read` (metadata reads, never a
 * turn). Window semantics are NOT constant across accounts or time — this
 * account moved from 300/10080 to 10080/null — so every label is derived
 * from the `windowDurationMins` delivered with the bucket, never assumed.
 */
function CodexLiveBody({
  sub,
  live,
  nowMs,
}: {
  sub: SubscriptionStatus;
  live: CodexLiveQuota;
  nowMs: number;
}) {
  const locale = useLocale();
  const t = useTranslations("Usage");
  const capturedMs =
    sub.capturedAt === null ? null : new Date(sub.capturedAt).getTime();
  const ageMs =
    capturedMs === null || Number.isNaN(capturedMs) ? null : nowMs - capturedMs;
  const stale = ageMs !== null && ageMs > 24 * 3600_000;
  const credits = live.credits;

  return (
    <>
      {live.buckets.map((bucket) => (
        <CodexBucketRow key={bucket.limitId} bucket={bucket} nowMs={nowMs} />
      ))}

      {credits && (credits.hasCredits || credits.unlimited) && (
        <div className="mt-[12px]" data-testid="usage-sub-codex-credits">
          <Mono size={11} tone="muted">
            {credits.unlimited
              ? t("subscription.creditsUnlimited")
              : t("subscription.credits", { balance: credits.balance ?? "—" })}
          </Mono>
        </div>
      )}

      {ageMs !== null && (
        <p
          className="mt-[12px] text-[11px] text-meta"
          data-stale={stale ? "" : undefined}
          data-testid="usage-sub-codex-captured"
        >
          {stale && <StaleMark />}
          {t("subscription.polledCodex", {
            age: formatRelative(nowMs - ageMs, { locale, now: nowMs }),
          })}
          {stale ? ` ${t("subscription.stale")}` : ""}
        </p>
      )}

      <CodexHistoryStrip live={live} />
    </>
  );
}

/**
 * One `rateLimitsByLimitId` bucket. `limitName` is the provider's own label
 * ("GPT-5.3-Codex-Spark") and falls back to the raw `limitId` rather than to
 * an invented display name.
 */
function CodexBucketRow({
  bucket,
  nowMs,
}: {
  bucket: CodexQuotaBucket;
  nowMs: number;
}) {
  const copy = useWindowCopy();
  const name = (bucket.limitName ?? bucket.limitId).toUpperCase();
  const testId = `usage-sub-codex-bucket-${bucket.limitId}`;

  // Codex emits unix SECONDS — the claude path parses ISO strings instead.
  const remainingMs =
    bucket.resetsAtUnix === null ? null : bucket.resetsAtUnix * 1000 - nowMs;
  const secondary = bucket.secondary;
  const secondaryRemainingMs =
    secondary === null || secondary.resetsAtUnix === null
      ? null
      : secondary.resetsAtUnix * 1000 - nowMs;

  return (
    <>
      <GaugeRow
        label={`${name} · ${windowLabel(bucket.windowDurationMins, copy)}`}
        readout={`${Math.round(bucket.usedPercent)}%`}
        percent={bucket.usedPercent}
        dimmed={remainingMs !== null && remainingMs <= 0}
        testId={testId}
      />
      <ResetLine remainingMs={remainingMs} testId={testId} />

      {secondary && (
        <>
          <GaugeRow
            label={`${name} · ${windowLabel(secondary.windowDurationMins, copy)}`}
            readout={`${Math.round(secondary.usedPercent)}%`}
            percent={secondary.usedPercent}
            dimmed={secondaryRemainingMs !== null && secondaryRemainingMs <= 0}
            testId={`${testId}-secondary`}
          />
          <ResetLine
            remainingMs={secondaryRemainingMs}
            testId={`${testId}-secondary`}
          />
        </>
      )}
    </>
  );
}

/**
 * Codex's SERVER-SIDE daily token history: every device on the account, not
 * just this one. Kept inside the codex card behind its own divider and label
 * so it can never be read as the page-level Arij "LAST 30 DAYS" strip.
 *
 * Buckets arrive sparse (days with no usage are simply absent) and are
 * rendered as delivered — no zero-filling, because these are the provider's
 * calendar dates, not Arij's local ones.
 */
function CodexHistoryStrip({ live }: { live: CodexLiveQuota }) {
  const locale = useLocale();
  const t = useTranslations("Usage");
  const days = live.dailyUsage.slice(-30);
  if (days.length === 0 && live.lifetimeTokens === null) return null;

  const maxTokens = days.reduce((max, d) => Math.max(max, d.tokens), 0);

  return (
    <div className="mt-[14px] border-t-[1.5px] border-border-soft pt-[10px]">
      <span data-testid="usage-sub-codex-history-label">
        <FieldKicker size={10.5} stratum="card">
          {t("subscription.allDevices")}
        </FieldKicker>
      </span>

      {days.length > 0 && (
        <>
          <div
            className="mt-[8px] flex h-[40px] items-end gap-[2px]"
            data-testid="usage-sub-codex-history"
          >
            {days.map((day) => (
              <div
                key={day.date}
                data-testid={`usage-sub-codex-history-${day.date}`}
                className="flex-1 rounded-[2px]"
                style={{
                  height: `${maxTokens > 0 ? (day.tokens / maxTokens) * 100 : 0}%`,
                  minHeight: 2,
                  background: "var(--agent)",
                  opacity: day.tokens > 0 ? 0.75 : 0.25,
                }}
                title={t("subscription.historyDay", {
                  date: day.date,
                  tokens: formatTokens(day.tokens) ?? "—",
                })}
              />
            ))}
          </div>
          {/* Mixed-case month labels, so they sit at the 11px floor rather
              than at the tracked-mono 9.5/10.5 allowance. */}
          <div className="mt-[6px] flex justify-between">
            <Mono size={11} tone="muted">
              {formatDayLabel(days[0].date, locale)}
            </Mono>
            <Mono size={11} tone="muted">
              {formatDayLabel(days[days.length - 1].date, locale)}
            </Mono>
          </div>
        </>
      )}

      {live.lifetimeTokens !== null && (
        <div className="mt-[6px]" data-testid="usage-sub-codex-lifetime">
          <Mono size={11} tone="muted">
            {t("subscription.lifetime", { tokens: formatTokens(live.lifetimeTokens) ?? "—" })}
          </Mono>
        </div>
      )}
    </div>
  );
}

/**
 * The reset sentence for one gauge. Purely presentational: it receives an
 * already-computed remaining duration so the claude (ISO) and codex (unix
 * seconds) conversions stay in separate code paths. A window whose reset is
 * already behind us is called stale rather than silently rolled forward.
 */
function ResetLine({
  remainingMs,
  testId,
}: {
  remainingMs: number | null;
  testId: string;
}) {
  const t = useTranslations("Usage");
  return (
    <div className="mt-[5px]" data-testid={`${testId}-reset`}>
      <Mono size={11} tone="muted">
        {remainingMs === null
          ? t("subscription.resetUnknown")
          : remainingMs <= 0
            ? t("subscription.windowExpired")
            : t("subscription.resetsIn", { countdown: formatCountdown(remainingMs) })}
      </Mono>
    </div>
  );
}

/** Codex: replayed rate-limit snapshot, or an honest "nothing recorded yet". */
function ProviderReportedBody({
  sub,
  nowMs,
}: {
  sub: SubscriptionStatus;
  nowMs: number;
}) {
  const locale = useLocale();
  const t = useTranslations("Usage");
  const copy = useWindowCopy();
  if (sub.capturedAt === null) {
    return (
      <p
        className="mt-[10px] text-[12.5px] text-muted-foreground"
        data-testid="usage-sub-codex-empty"
      >
        {t("subscription.codexEmpty")}
      </p>
    );
  }

  const ageMs = nowMs - new Date(sub.capturedAt).getTime();
  const stale = ageMs > 24 * 3600_000;

  return (
    <>
      {/*
        Reached only when the live poll produced nothing (missing CLI, timeout,
        malformed frames). The snapshot below is still real provider data, just
        older — say which one is on screen instead of letting them look alike.
      */}
      <p
        className="mt-[10px] text-[11px] text-meta"
        data-testid="usage-sub-codex-live-fallback"
      >
        {t("subscription.liveUnavailableSnapshot")}
      </p>
      <SnapshotWindow
        label={windowLabel(sub.primary?.windowMinutes ?? null, copy)}
        snapshot={sub.primary}
        nowMs={nowMs}
        testId="usage-sub-codex-primary"
      />
      <SnapshotWindow
        label={windowLabel(sub.secondary?.windowMinutes ?? null, copy)}
        snapshot={sub.secondary}
        nowMs={nowMs}
        testId="usage-sub-codex-secondary"
      />
      <p
        className="mt-[12px] text-[11px] text-meta"
        data-stale={stale ? "" : undefined}
        data-testid="usage-sub-codex-captured"
      >
        {stale && <StaleMark />}
        {t("subscription.captured", {
          age: formatRelative(nowMs - ageMs, { locale, now: nowMs }),
        })}
        {stale ? ` ${t("subscription.stale")}` : ""}
      </p>
    </>
  );
}

/**
 * One provider-reported window: the gauge plus its reset line. A reset time
 * already in the past is shown dimmed and called stale rather than silently
 * extrapolated forward — used_percent is never advanced past what codex said.
 */
function SnapshotWindow({
  label,
  snapshot,
  nowMs,
  testId,
}: {
  label: string;
  snapshot: SubscriptionWindowStatus | null;
  nowMs: number;
  testId: string;
}) {
  if (!snapshot) return null;

  // Snapshot resets are unix SECONDS, like the live codex path and unlike the
  // ISO strings claude emits.
  const resetsAtMs = snapshot.resetsAt === null ? null : snapshot.resetsAt * 1000;
  const remainingMs = resetsAtMs === null ? null : resetsAtMs - nowMs;

  return (
    <>
      <GaugeRow
        label={label}
        readout={
          snapshot.usedPercent === null
            ? "—"
            : `${Math.round(snapshot.usedPercent)}%`
        }
        percent={snapshot.usedPercent}
        dimmed={remainingMs !== null && remainingMs <= 0}
        testId={testId}
      />
      <ResetLine remainingMs={remainingMs} testId={testId} />
    </>
  );
}

/**
 * Claude: sums over Arij's own sessions, never presented as account quota.
 * This is the fallback body — it renders when no live CLI answer was
 * available, so it leads by saying so and keeps its full disclaimer.
 */
function MeteredBody({
  sub,
  metered,
}: {
  sub: SubscriptionStatus;
  metered: NonNullable<SubscriptionStatus["metered"]>;
}) {
  const t = useTranslations("Usage");
  const budget = metered.budgetUsdWeek;
  const percent = metered.budgetUsedPercent;
  const over = percent !== null && percent > 100;

  return (
    <>
      <p
        className="mt-[10px] text-[11px] text-meta"
        data-testid="usage-sub-claude-live-fallback"
      >
        {t("subscription.liveUnavailableMetered")}
      </p>
      <MeteredLine
        label={t("subscription.last5h")}
        usage={metered.last5h}
        testId={`usage-sub-${sub.provider}-5h`}
      />
      <MeteredLine
        label={t("subscription.last7d")}
        usage={metered.last7d}
        testId={`usage-sub-${sub.provider}-7d`}
      />

      {budget !== null && (
        <GaugeRow
          label={t("subscription.weeklyBudget")}
          readout={`${formatCostUsd(metered.last7d.costUsd) ?? "—"} / ${
            formatCostUsd(budget) ?? "—"
          }`}
          percent={percent}
          alarm={over}
          testId="usage-sub-claude-budget"
        />
      )}

      <p
        className="mt-[12px] text-[11px] text-meta"
        data-testid="usage-sub-claude-disclaimer"
      >
        {t("subscription.meteredDisclaimer")}
      </p>
    </>
  );
}

function MeteredLine({
  label,
  usage,
  testId,
}: {
  label: string;
  usage: WindowUsage;
  testId: string;
}) {
  const t = useTranslations("Usage");
  const tokens =
    usage.inputTokens !== null && usage.outputTokens !== null
      ? formatTokens(usage.inputTokens + usage.outputTokens)
      : null;

  return (
    <div className="mt-[10px]">
      <FieldKicker size={10.5} stratum="card">
        {label}
      </FieldKicker>
      <div className="mt-[3px]" data-testid={testId}>
        <Mono size={12.5}>
          {t("subscription.meteredLine", {
            sessions: usage.sessions,
            tokens: tokens ?? "—",
            cost: formatCostUsd(usage.costUsd) ?? "—",
          })}
        </Mono>
      </div>
    </div>
  );
}

/**
 * Determinate gauge, drawn by the `ProgressTrack` primitive in its determinate
 * mode (its defaults — `--strata-live-fill` on `--strata-live-track` — are the
 * exact pair the old hand-rolled bar named through the `--agent` aliases).
 *
 * Fill width is clamped to [0,100] by the primitive; the readout is not, so a
 * blown budget reads honestly.
 *
 * An expired window is DIMMED, not recoloured: opacity says "this reading is
 * no longer current" without spending one of the screen's two loud colours,
 * and the `ResetLine` right underneath says it in words as well. `data-dimmed`
 * on the row is what the suite asserts, so the signal survives a restyling.
 */
function GaugeRow({
  label,
  readout,
  percent,
  dimmed = false,
  alarm = false,
  testId,
}: {
  label: string;
  readout: string;
  percent: number | null;
  dimmed?: boolean;
  /** Over the stated budget — the one place this gauge's readout is coloured. */
  alarm?: boolean;
  testId: string;
}) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));

  return (
    <div
      className="mt-[12px]"
      data-testid={testId}
      data-dimmed={dimmed ? "" : undefined}
    >
      <div className="flex items-baseline justify-between gap-[10px]">
        <FieldKicker size={10.5} stratum="card">
          {label}
        </FieldKicker>
        <span data-testid={`${testId}-readout`}>
          {/*
            Over budget is one of the design's two sanctioned alarms, and
            `--destructive` is the same value as `--strata-you-deep`, so "text
            is never coloured except stratum deeps" still holds. Identical
            reasoning to `MonthlyCapTile`.
          */}
          <Mono size={11} tone={alarm ? "danger" : "ink"}>
            {readout}
          </Mono>
        </span>
      </div>
      <ProgressTrack
        height={3}
        percent={width}
        fillTestId={`${testId}-fill`}
        className={cn("mt-[6px]", dimmed && "opacity-[0.35]")}
      />
    </div>
  );
}
