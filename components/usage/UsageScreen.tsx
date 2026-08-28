"use client";

import { BandHeader, PillButton, StrataBand } from "@/components/piscine";
import { useUsage } from "@/hooks/useUsage";
import { formatCostUsd } from "@/lib/utils/format-usage";
import type { UsageRange, UsageReport } from "@/lib/types/usage";

import { ByDayCard } from "@/components/usage/ByDayCard";
import { MonthlyCapTile } from "@/components/usage/MonthlyCapTile";
import { StatTile } from "@/components/usage/StatTile";
import { SubscriptionCard } from "@/components/usage/SubscriptionCard";
import { UsageBarBand } from "@/components/usage/UsageBarBand";
import { AgentBarRow, ProjectBarRow } from "@/components/usage/UsageBarRow";
import { UsageHeader } from "@/components/usage/UsageHeader";

/**
 * Usage observatory — frame 8d.
 *
 * Four regions on shell paper: the KPI + PLAFOND MENSUEL tile row, the
 * turquoise BY AGENT / pool BY PROJECT bands, the white BY DAY card, and the
 * provider subscription cards.
 *
 * Three kinds of number live in that fourth region and they are never blended:
 *  - live provider quota: what the provider's own CLI answered just now;
 *  - provider-reported snapshot: rate-limit percentages codex itself emitted
 *    into ~/.codex/sessions, replayed verbatim with their capture time;
 *  - metered via Arij: sums over the sessions Arij launched — a floor on real
 *    spend on THIS machine, never the account's remaining quota.
 *
 * The frame does not draw those cards. They are kept because they are the only
 * answer in the app to "what does the provider itself say about my quota".
 *
 * Absent data renders as an em-dash or a band collapsed to its label line —
 * never a fabricated zero, never an invented bar.
 */

/**
 * The KPI caption follows the range control, exactly as the frame labels it.
 * Keyed off `dashboard.range` — what the payload ON SCREEN actually covers —
 * not off the pending selection, so a slow refetch never mislabels stale
 * figures.
 */
const RANGE_CAPTION: Record<UsageRange, string> = {
  "7d": "7 DERNIERS JOURS",
  "30d": "30 DERNIERS JOURS",
  all: "DEPUIS LE DÉBUT",
};

export function UsageScreen() {
  const { report, loading, error, range, setRange, refresh } = useUsage();

  // State precedence is the contract: skeleton only before the FIRST report,
  // error screen only when there is nothing to show, and a stale report always
  // beats a blank page (the header carries the warning instead).
  if (loading && !report) {
    return (
      <div
        className="flex h-full min-h-0 flex-col gap-[12px] p-[14px]"
        data-testid="usage-loading"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[120px] animate-pulse rounded-[14px] bg-card motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }

  if (error && !report) {
    return (
      <div
        className="flex h-full min-h-0 flex-col items-center justify-center gap-[12px] p-[22px]"
        data-testid="usage-error"
      >
        <p className="text-[13px] text-muted-foreground">{error}</p>
        {/* Retry deliberately does NOT force a fresh live-quota poll. */}
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="md"
          onClick={() => void refresh()}
        >
          Retry
        </PillButton>
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <UsageHeader
        range={range}
        onRangeChange={setRange}
        generatedAt={report.generatedAt}
        error={error}
        loading={loading}
        onRefresh={() => void refresh({ fresh: true })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <UsageBody report={report} onCapSaved={() => void refresh()} />
      </div>
    </div>
  );
}

function UsageBody({
  report,
  onCapSaved,
}: {
  report: UsageReport;
  onCapSaved: () => void;
}) {
  const dashboard = report.dashboard;
  const { totals } = dashboard;
  // Same check the page has always made, now against the range-scoped block.
  const empty = totals.sessions === 0;

  const nightTail = formatCostUsd(dashboard.nightYesterdayUsd);
  const projectFootnote = nightTail
    ? `night runs inclus — le lot d'hier : ${nightTail}`
    : "night runs inclus";

  return (
    // No TOP padding: row 1 butts against the header. The 24px header gutter
    // versus the 14px body gutter is intentional asymmetry.
    <div className="flex min-h-full flex-col gap-[12px] px-[14px] pb-[14px]">
      <div className="flex shrink-0 flex-wrap gap-[12px]" data-testid="usage-band">
        <StatTile
          testId="usage-stat-cost"
          value={formatCostUsd(totals.costUsd)}
          caption={RANGE_CAPTION[dashboard.range]}
        />
        {/* A run counter's 0 is a fact, not a claim — the one tile that keeps it. */}
        <StatTile
          testId="usage-stat-sessions"
          value={String(totals.sessions)}
          caption="SESSIONS"
        />
        <StatTile
          testId="usage-stat-clean"
          value={
            totals.cleanPercent === null
              ? null
              : `${Math.round(totals.cleanPercent)}%`
          }
          caption="CLEAN"
          tone="live"
        />
        <StatTile
          testId="usage-stat-per-ticket"
          value={formatCostUsd(totals.costPerTicketUsd)}
          caption="PAR TICKET LIVRÉ"
        />
        <MonthlyCapTile cap={dashboard.cap} onSaved={onCapSaved} />
      </div>

      {empty && (
        <div
          className="text-center text-[13px] text-muted-foreground"
          data-testid="usage-empty"
        >
          No agent sessions recorded yet.
        </div>
      )}

      <div className="grid grid-cols-1 gap-[12px] min-[1100px]:min-h-[260px] min-[1100px]:flex-1 min-[1100px]:grid-cols-2">
        <UsageBarBand
          label="By agent"
          stratum="live"
          listTestId="usage-agent-table"
          rowCount={dashboard.byAgent.length}
          footnote="le coût suit le modèle, pas le CLI — détail par session dans Sessions"
        >
          {dashboard.byAgent.map((bar, i) => (
            <AgentBarRow
              key={bar.key}
              bar={bar}
              index={i}
              dimmed={dashboard.byAgent.length >= 4 && i === dashboard.byAgent.length - 1}
            />
          ))}
        </UsageBarBand>

        <UsageBarBand
          label="By project"
          stratum="next"
          listTestId="usage-project-list"
          rowCount={dashboard.byProject.length}
          footnote={projectFootnote}
        >
          {dashboard.byProject.map((bar) => (
            <ProjectBarRow key={bar.key} bar={bar} />
          ))}
        </UsageBarBand>
      </div>

      <ByDayCard days={empty ? [] : dashboard.byDay} />

      {/*
        Region 4: the provider subscription cards. Undrawn by the frame,
        preserved verbatim — `nowMs` is the report's own generation time, not a
        render-time clock read, so the card stays a pure snapshot as-of the
        fetch and the next Refresh moves the anchor forward.
      */}
      <StrataBand stratum="card" gap={10} className="px-[18px] py-[15px]">
        <BandHeader label="Provider quota" stratum="neutral" labelSize={12} standalone />
        <div className="flex flex-wrap gap-[14px]" data-testid="usage-subscriptions">
          {report.subscriptions.map((sub) => (
            <SubscriptionCard
              key={sub.provider}
              sub={sub}
              nowMs={new Date(report.generatedAt).getTime()}
            />
          ))}
        </div>
      </StrataBand>
    </div>
  );
}
