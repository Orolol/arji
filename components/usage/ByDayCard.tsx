import { useTranslations } from "next-intl";

import { BandHeader, CappedBarChart, Mono, StrataBand } from "@/components/piscine";
import { formatCostUsd } from "@/lib/utils/format-usage";
import type { UsageDayBar } from "@/lib/types/usage";

/**
 * BY DAY — the daily cost bars of frame 8d, with an 8px coral cap on any day
 * that had a failed session.
 *
 * SCALE FALLBACK, PRESERVED FROM THE OLD DayStrip: scale to cost when any cost
 * is known, else to session counts. Codex sessions report no cost to Arij at
 * all, so a cost-only scale would flatten a genuinely busy month to nothing.
 *
 * The cap encodes the PRESENCE of failures, not their magnitude — it is 8px
 * whether one session or nine failed. A failed session that never received an
 * `ended_at` is invisible to this strip, exactly as it is invisible to the
 * aggregate that feeds it.
 *
 * No days at all collapses the card to its label line: no legend counting zero
 * days, no strip of fabricated stubs, no 260px of empty white.
 */
export function ByDayCard({ days }: { days: UsageDayBar[] }) {
  const t = useTranslations("Usage");
  const maxCost = days.reduce((max, d) => Math.max(max, d.costUsd ?? 0), 0);
  const useCost = maxCost > 0;

  const bars = days.map((day) => {
    const cost = formatCostUsd(day.costUsd);
    return {
      value: useCost ? (day.costUsd ?? 0) : day.sessions,
      failed: day.failedSessions > 0,
      testId: `usage-day-${day.date}`,
      capTestId: `usage-day-${day.date}-fail`,
      title: [
        day.date,
        t("byDay.sessions", { count: day.sessions }),
        ...(cost ? [cost] : []),
        ...(day.failedSessions ? [t("byDay.failed", { count: day.failedSessions })] : []),
      ].join(" · "),
    };
  });

  if (days.length === 0) {
    return (
      <StrataBand stratum="card" gap={8} className="px-[18px] py-[15px]">
        <BandHeader label={t("byDay.label")} stratum="neutral" labelSize={12} standalone />
      </StrataBand>
    );
  }

  return (
    <StrataBand
      stratum="card"
      grow
      gap={8}
      // 260px floor so a short viewport scrolls instead of crushing the bars.
      className="min-h-[260px] px-[18px] py-[15px]"
    >
      <div className="flex items-baseline gap-[12px]">
        <BandHeader label={t("byDay.label")} stratum="neutral" labelSize={12} standalone />
        <Mono size={10.5} tone="muted">
          {`${t("byDay.days", { count: days.length })} · `}
          {/*
            The only coloured text on this card, and it names an alarm colour:
            `--strata-you-deep` is a stratum deep, so "text is never coloured
            except stratum deeps" holds.
          */}
          <span className="text-strata-you-deep">{t("byDay.legend")}</span>
        </Mono>
      </div>
      <CappedBarChart
        bars={bars}
        gap={5}
        capPx={8}
        testId="usage-day-strip"
        className="pb-[2px]"
      />
    </StrataBand>
  );
}
