"use client";

import { cn } from "@/lib/utils";
import { formatCostUsd, formatTokens } from "@/lib/utils/format-usage";
import {
  formatCountdown,
  formatDayLabel,
  formatRelativeAge,
  numberOrDash,
  parseIsoMs,
  providerLabel,
  windowLabel,
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
/* Moved VERBATIM out of app/usage/page.tsx (frame 8d re-skin). Exactly one    */
/* line changed: the outer container is now borderless with radius 14, to      */
/* match the Piscine system. Everything else — every testid, class, DOM node,  */
/* inline style and comment — is byte-for-byte what 66 tests across            */
/* __tests__/usage-live-cards.test.tsx and __tests__/usage-page.test.tsx pin.  */
/*                                                                            */
/* The frame does not draw these cards. That is a coverage gap in the design,  */
/* not a deletion order: they are the only place in the app that answers       */
/* "what does the provider itself say about my account quota".                 */
/* -------------------------------------------------------------------------- */

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
  return (
    <div
      className="w-[340px] max-w-full rounded-[14px] bg-card p-[16px]"
      data-testid={`usage-sub-${sub.provider}`}
    >
      <div className="flex items-center justify-between gap-[10px]">
        <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
          {providerLabel(sub.provider)}
        </span>
        <span
          className="rounded-full border border-border-soft px-[7px] py-[2px] text-[10.5px] uppercase tracking-[.08em] text-meta"
          data-testid={`usage-sub-${sub.provider}-source`}
        >
          {sub.source === "provider-reported"
            ? "Provider-reported"
            : "Metered via Arij"}
        </span>
      </div>

      {sub.plan && (
        <p className="mt-[6px] font-mono text-[11px] text-meta">
          plan: {sub.plan}
        </p>
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
    </div>
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
  const capturedMs =
    sub.capturedAt === null ? null : new Date(sub.capturedAt).getTime();
  const ageMs =
    capturedMs === null || Number.isNaN(capturedMs) ? null : nowMs - capturedMs;
  const stale = ageMs !== null && ageMs > 24 * 3600_000;
  const extra = live.extraUsage;

  return (
    <>
      <ClaudeWindow
        label="5H WINDOW"
        window={live.fiveHour}
        nowMs={nowMs}
        testId="usage-sub-claude-live-5h"
      />
      <ClaudeWindow
        label="7D WINDOW"
        window={live.sevenDay}
        nowMs={nowMs}
        testId="usage-sub-claude-live-7d"
      />
      <ClaudeWindow
        label="7D OPUS"
        window={live.sevenDayOpus}
        nowMs={nowMs}
        testId="usage-sub-claude-live-7d-opus"
      />
      <ClaudeWindow
        label="7D SONNET"
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
        <p
          className="mt-[12px] font-mono text-[11px] text-meta"
          data-testid="usage-sub-claude-extra"
        >
          Extra usage: {numberOrDash(extra.usedCredits)} /{" "}
          {numberOrDash(extra.monthlyLimit)} credits ·{" "}
          {numberOrDash(extra.utilizationPercent)}%
        </p>
      )}

      {ageMs !== null && (
        <p
          className={cn(
            "mt-[12px] text-[11px]",
            stale ? "text-priority-yellow" : "text-meta"
          )}
          data-testid="usage-sub-claude-captured"
        >
          Live · polled {formatRelativeAge(ageMs)} ago · claude CLI
        </p>
      )}

      {sub.metered && (
        <div className="mt-[14px] border-t border-border-soft pt-[10px]">
          {/*
            Demoted rendering: the standalone disclaimer sentence is dropped
            because this section label already says exactly what these numbers
            are — and unlike the fallback card, an account-wide truth is
            visible right above it.
          */}
          <span
            className="text-[10.5px] uppercase tracking-[.08em] text-meta"
            data-testid="usage-sub-claude-metered-sub"
          >
            ARIJ-METERED · THIS MACHINE ONLY
          </span>
          <MeteredLine
            label="LAST 5H"
            usage={sub.metered.last5h}
            testId={`usage-sub-${sub.provider}-5h`}
          />
          <MeteredLine
            label="LAST 7 DAYS"
            usage={sub.metered.last7d}
            testId={`usage-sub-${sub.provider}-7d`}
          />
          {sub.metered.budgetUsdWeek !== null && (
            <GaugeRow
              label="WEEKLY BUDGET"
              readout={`${formatCostUsd(sub.metered.last7d.costUsd) ?? "—"} / ${
                formatCostUsd(sub.metered.budgetUsdWeek) ?? "—"
              }`}
              percent={sub.metered.budgetUsedPercent}
              readoutClassName={
                sub.metered.budgetUsedPercent !== null &&
                sub.metered.budgetUsedPercent > 100
                  ? "text-destructive"
                  : undefined
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
        <p
          className="mt-[12px] font-mono text-[11px] text-meta"
          data-testid="usage-sub-codex-credits"
        >
          {credits.unlimited
            ? "Credits: unlimited"
            : `Credits: ${credits.balance ?? "—"}`}
        </p>
      )}

      {ageMs !== null && (
        <p
          className={cn(
            "mt-[12px] text-[11px]",
            stale ? "text-priority-yellow" : "text-meta"
          )}
          data-testid="usage-sub-codex-captured"
        >
          Live · polled {formatRelativeAge(ageMs)} ago · codex app-server
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
        label={`${name} · ${windowLabel(bucket.windowDurationMins)}`}
        readout={`${Math.round(bucket.usedPercent)}%`}
        percent={bucket.usedPercent}
        dimmed={remainingMs !== null && remainingMs <= 0}
        testId={testId}
      />
      <ResetLine remainingMs={remainingMs} testId={testId} />

      {secondary && (
        <>
          <GaugeRow
            label={`${name} · ${windowLabel(secondary.windowDurationMins)}`}
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
  const days = live.dailyUsage.slice(-30);
  if (days.length === 0 && live.lifetimeTokens === null) return null;

  const maxTokens = days.reduce((max, d) => Math.max(max, d.tokens), 0);

  return (
    <div className="mt-[14px] border-t border-border-soft pt-[10px]">
      <span
        className="text-[10.5px] uppercase tracking-[.08em] text-meta"
        data-testid="usage-sub-codex-history-label"
      >
        ALL DEVICES · PROVIDER-REPORTED
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
                title={`${day.date} · ${formatTokens(day.tokens) ?? "—"} tokens`}
              />
            ))}
          </div>
          <div className="mt-[6px] flex justify-between font-mono text-[10.5px] text-meta">
            <span>{formatDayLabel(days[0].date)}</span>
            <span>{formatDayLabel(days[days.length - 1].date)}</span>
          </div>
        </>
      )}

      {live.lifetimeTokens !== null && (
        <p
          className="mt-[6px] font-mono text-[11px] text-meta"
          data-testid="usage-sub-codex-lifetime"
        >
          Lifetime: {formatTokens(live.lifetimeTokens) ?? "—"} tokens
        </p>
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
  return (
    <p
      className="mt-[5px] font-mono text-[11px] text-meta"
      data-testid={`${testId}-reset`}
    >
      {remainingMs === null
        ? "reset time unknown"
        : remainingMs <= 0
          ? "window expired — data stale"
          : `resets in ${formatCountdown(remainingMs)}`}
    </p>
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
  if (sub.capturedAt === null) {
    return (
      <p
        className="mt-[10px] text-[12.5px] text-muted-foreground"
        data-testid="usage-sub-codex-empty"
      >
        No provider snapshot found. Codex records rate-limit data when a
        session runs — none is recorded on this machine yet.
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
        Live quota unavailable — showing last snapshot.
      </p>
      <SnapshotWindow
        label={windowLabel(sub.primary?.windowMinutes ?? null)}
        snapshot={sub.primary}
        nowMs={nowMs}
        testId="usage-sub-codex-primary"
      />
      <SnapshotWindow
        label={windowLabel(sub.secondary?.windowMinutes ?? null)}
        snapshot={sub.secondary}
        nowMs={nowMs}
        testId="usage-sub-codex-secondary"
      />
      <p
        className={cn("mt-[12px] text-[11px]", stale ? "text-priority-yellow" : "text-meta")}
        data-testid="usage-sub-codex-captured"
      >
        Captured {formatRelativeAge(ageMs)} ago · ~/.codex/sessions
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
  const budget = metered.budgetUsdWeek;
  const percent = metered.budgetUsedPercent;
  const over = percent !== null && percent > 100;

  return (
    <>
      <p
        className="mt-[10px] text-[11px] text-meta"
        data-testid="usage-sub-claude-live-fallback"
      >
        Live quota unavailable — showing metered data.
      </p>
      <MeteredLine
        label="LAST 5H"
        usage={metered.last5h}
        testId={`usage-sub-${sub.provider}-5h`}
      />
      <MeteredLine
        label="LAST 7 DAYS"
        usage={metered.last7d}
        testId={`usage-sub-${sub.provider}-7d`}
      />

      {budget !== null && (
        <GaugeRow
          label="WEEKLY BUDGET"
          readout={`${formatCostUsd(metered.last7d.costUsd) ?? "—"} / ${
            formatCostUsd(budget) ?? "—"
          }`}
          percent={percent}
          readoutClassName={over ? "text-destructive" : undefined}
          testId="usage-sub-claude-budget"
        />
      )}

      <p
        className="mt-[12px] text-[11px] text-meta"
        data-testid="usage-sub-claude-disclaimer"
      >
        Sessions recorded by Arij only — not the account&apos;s full quota.
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
  const tokens =
    usage.inputTokens !== null && usage.outputTokens !== null
      ? formatTokens(usage.inputTokens + usage.outputTokens)
      : null;

  return (
    <div className="mt-[10px]">
      <span className="text-[10.5px] uppercase tracking-[.08em] text-meta">
        {label}
      </span>
      <p className="mt-[3px] font-mono text-[12.5px]" data-testid={testId}>
        {usage.sessions} session{usage.sessions === 1 ? "" : "s"} ·{" "}
        {tokens ?? "—"} tokens · {formatCostUsd(usage.costUsd) ?? "—"}
      </p>
    </div>
  );
}

/**
 * Determinate gauge. Deliberately inline-styled rather than `.progress-track`,
 * whose `.crawl-fill` is an indeterminate crawl animation. Fill width is
 * clamped to [0,100]; the readout is not, so a blown budget reads honestly.
 */
function GaugeRow({
  label,
  readout,
  percent,
  dimmed = false,
  readoutClassName,
  testId,
}: {
  label: string;
  readout: string;
  percent: number | null;
  dimmed?: boolean;
  readoutClassName?: string;
  testId: string;
}) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));

  return (
    <div className="mt-[12px]" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-[10px]">
        <span className="text-[10.5px] uppercase tracking-[.08em] text-meta">
          {label}
        </span>
        <span
          className={cn("font-mono text-[11px]", readoutClassName)}
          data-testid={`${testId}-readout`}
        >
          {readout}
        </span>
      </div>
      <div
        className="mt-[6px] h-[3px] w-full overflow-hidden rounded-full"
        style={{ background: "var(--agent-track)" }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${width}%`,
            background: "var(--agent)",
            opacity: dimmed ? 0.35 : 1,
          }}
          data-testid={`${testId}-fill`}
        />
      </div>
    </div>
  );
}
