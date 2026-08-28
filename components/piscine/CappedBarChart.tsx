import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * The vertical day-series bar chart with red failure caps. 7a's 14-day agent
 * sparkline and 8d's 30-day BY DAY chart are the same chart at two lengths.
 *
 * A failure day is NOT a differently-coloured bar: it is the same green bar
 * wearing a fixed-height red cap, so the day's volume stays readable and the
 * failure reads as an event on top of it.
 */
export interface CappedBar {
  value: number;
  failed?: boolean;
}

export interface CappedBarChartProps {
  bars: CappedBar[];
  /** px. 46 for the 7a sparkline. Omit for 8d, which grows into its band. */
  height?: number;
  /** px height of the red cap on a failed day. 6 for 7a, 8 for 8d. */
  capPx?: number;
  /** px between bars. 4 for 7a, 5 for 8d. */
  gap?: number;
  className?: string;
}

export function CappedBarChart({
  bars,
  height,
  capPx = 6,
  gap = 4,
  className,
}: CappedBarChartProps) {
  // An empty series renders nothing; the caller collapses the band around it.
  if (bars.length === 0) return null;

  const max = Math.max(...bars.map((b) => b.value), 0);

  // Open numbers stay inline; the layout itself is utilities.
  const row: CSSProperties =
    height === undefined ? { gap: `${gap}px` } : { gap: `${gap}px`, height: `${height}px` };

  return (
    <div
      data-slot="capped-bar-chart"
      className={cn(
        "flex items-end",
        // 8d: grow into the band. min-h-0 is what lets a flex child actually
        // shrink below its content height.
        height === undefined && "min-h-0 flex-1",
        className,
      )}
      style={row}
    >
      {bars.map((bar, i) => {
        // A zero day still draws a 2px stub so the axis reads continuously and
        // the series does not appear to have holes in it.
        const pct = max > 0 ? (bar.value / max) * 100 : 0;
        const barHeight = bar.value > 0 && pct > 0 ? `${pct}%` : "2px";

        if (!bar.failed) {
          return (
            <span
              key={i}
              className="min-w-0 flex-1 rounded-t-[3px] bg-strata-live-bar"
              style={{ height: barHeight }}
            />
          );
        }

        return (
          <span
            key={i}
            data-failed=""
            className="flex min-w-0 flex-1 flex-col justify-end"
          >
            <span
              className="shrink-0 rounded-t-[3px] bg-chart-fail"
              style={{ height: `${capPx}px` }}
            />
            {/* Unrounded: the cap above already carries the bar's top edge. */}
            <span className="bg-strata-live-bar" style={{ height: barHeight }} />
          </span>
        );
      })}
    </div>
  );
}
