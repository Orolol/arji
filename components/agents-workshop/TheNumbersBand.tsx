"use client";

import {
  BandHeader,
  CappedBarChart,
  Mono,
  QuietLink,
  StatNumeral,
  StrataBand,
} from "@/components/piscine";
import type { NamedAgentStats } from "@/hooks/useAgentConfig";
import {
  DISPATCH_ROLE_LABELS,
  formatReliabilityDuration,
  formatReliabilityPercent,
  type DispatchRole,
} from "@/lib/agent-config/dispatch-reliability-constants";
import { formatCostUsd } from "@/lib/utils/format-usage";

/**
 * THE NUMBERS — the sun band: five numerals, a 14-day sparkline and the task
 * split, for the selected agent.
 *
 * EM-DASH DISCIPLINE. Every numeral is wired to a NULLABLE value and
 * `StatNumeral` renders `—` for null. A clean rate of "0%" when nothing has
 * finished, or "$0" when no CLI reported a cost, would be a lie the rest of
 * the app does not tell.
 *
 * ESCALATIONS is coral only when it is greater than zero. A coral `0` would
 * spend one of the screen's two loud colours on the ABSENCE of a problem;
 * coral is reserved for something that blocks.
 */

/**
 * "6m 40s" → "6m40" for the 22px numeral, per the frame. The `s` is only
 * dropped when a larger unit is already present, so "38s" keeps its unit
 * instead of degrading into a bare number.
 */
function compactDuration(label: string): string {
  const compact = label.replace(/\s+/g, "");
  return /[mh]/.test(compact) && compact.endsWith("s")
    ? compact.slice(0, -1)
    : compact;
}

export interface TheNumbersBandProps {
  stats: NamedAgentStats | null;
}

export function TheNumbersBand({ stats }: TheNumbersBandProps) {
  const runCount = stats?.runCount ?? null;
  const cleanRate = stats?.cleanRate ?? null;
  const medianMs = stats?.medianDurationMs ?? null;
  const cost = stats?.totalCostUsd ?? null;
  const escalations = stats?.escalationCount ?? null;

  const medianLabel = formatReliabilityDuration(medianMs);
  const hasRuns = (runCount ?? 0) > 0;

  const terminal = (stats?.completedCount ?? 0) + (stats?.failedCount ?? 0);
  const sampleTitle = stats
    ? `${stats.completedCount}/${terminal} terminal runs in ${stats.windowDays} days`
    : undefined;

  const meta = stats
    ? hasRuns
      ? "14 derniers jours, tous projets"
      : "14 derniers jours, tous projets — aucun run sur la période"
    : "14 derniers jours, tous projets";

  const topRoles = (stats?.byRole ?? [])
    .slice()
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 4);

  return (
    <StrataBand stratum="land" density="full" gap={11} className="pb-4">
      <BandHeader
        stratum="land"
        labelSize={12}
        align="baseline"
        label="The numbers"
        meta={meta}
        right={
          <QuietLink href="/usage" tone="next" size={12}>
            open usage →
          </QuietLink>
        }
      />

      <div className="flex flex-wrap items-stretch gap-5">
        <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-3 lg:shrink-0 lg:flex-nowrap">
          <StatNumeral
            size={22}
            captionStratum="land"
            caption="RUNS"
            value={runCount}
          />
          {/* The sample size rides in the title rather than gating the
              figure: the picker badge withholds a rate below five runs so a
              "100%" is not read as a recommendation, but THE NUMBERS is
              descriptive and must show what actually happened. */}
          <span title={sampleTitle}>
            <StatNumeral
              size={22}
              captionStratum="land"
              caption="CLEAN"
              tone={cleanRate === null ? "ink" : "live"}
              value={
                cleanRate === null ? null : formatReliabilityPercent(cleanRate)
              }
            />
          </span>
          <span title={medianMs === null ? undefined : medianLabel}>
            <StatNumeral
              size={22}
              captionStratum="land"
              caption="MEDIAN"
              value={medianMs === null ? null : compactDuration(medianLabel)}
            />
          </span>
          <StatNumeral
            size={22}
            captionStratum="land"
            caption="COST"
            value={formatCostUsd(cost)}
          />
          <StatNumeral
            size={22}
            captionStratum="land"
            caption="ESCALATIONS"
            tone={escalations !== null && escalations > 0 ? "danger" : "ink"}
            value={escalations}
          />
        </div>

        {/* With no run in the window the series would be fourteen 2px stubs,
            which reads as a bug rather than as an absence: the sparkline and
            BOTH of its rules disappear instead. */}
        {hasRuns && stats ? (
          <>
            <span
              aria-hidden="true"
              className="w-[1.5px] shrink-0 self-stretch bg-strata-land-rule"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <CappedBarChart
                height={46}
                capPx={6}
                gap={4}
                bars={stats.days.map((day) => ({
                  value: day.runs,
                  failed: day.failed > 0,
                }))}
              />
              <Mono size={9.5} tone="land-mid">
                {"runs / day · "}
                <span className="text-destructive">rouge = failed</span>
              </Mono>
            </div>
            <span
              aria-hidden="true"
              className="w-[1.5px] shrink-0 self-stretch bg-strata-land-rule"
            />
          </>
        ) : null}

        {topRoles.length > 0 ? (
          <div className="flex shrink-0 flex-col justify-center gap-1">
            {topRoles.map((row) => (
              <Mono key={row.role} size={10.5} tone="land-mid">
                {DISPATCH_ROLE_LABELS[
                  row.role as DispatchRole
                ]?.toUpperCase() ?? row.role.toUpperCase()}{" "}
                <Mono size={10.5} weight={700} tone="ink">
                  {row.runs}
                </Mono>
              </Mono>
            ))}
          </div>
        ) : null}
      </div>
    </StrataBand>
  );
}
