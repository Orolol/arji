import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * Horizontal proportion bar: 8d BY AGENT / BY PROJECT rows (16px on a card
 * track), 8d PLAFOND MENSUEL (8px), 8a FILES TOUCHED per-file mini-bars (6px,
 * two segments, no track).
 *
 * Callers pass token colour STRINGS: `var(--strata-live-bar)` for agent/added,
 * `var(--chart-fail)` for removed/failed, `var(--project-N-mid)` for the 8d
 * project rows, `var(--strata-feed-deep)` for the cap bar.
 */
export interface RatioSegment {
  /** 0-100. */
  percent: number;
  /** A `var(--token)` string — never a literal hex. */
  color: string;
  /** Per-segment corner rounding for the untracked multi-segment case. */
  radius?: "left" | "right" | "both" | "none";
}

const SEGMENT_RADIUS: Record<
  NonNullable<RatioSegment["radius"]>,
  string
> = {
  left: "3px 0 0 3px",
  right: "0 3px 3px 0",
  both: "3px",
  none: "0",
};

export interface RatioBarProps {
  segments: RatioSegment[];
  /** px. 16 for 8d rows, 8 for the cap bar, 6 for the 8a mini-bars. */
  height?: number;
  /** `card` paints the unfilled remainder; `none` leaves it transparent. */
  track?: "card" | "none";
  /** A fixed px width, or `"flex"` to absorb the row's slack. */
  width?: number | "flex";
  className?: string;
}

export function RatioBar({
  segments,
  height = 16,
  track = "card",
  width = "flex",
  className,
}: RatioBarProps) {
  const style: CSSProperties = {
    display: "flex",
    // A lone segment sits flush; a pair is split by a 1px hairline so the two
    // counts stay legible where they meet.
    gap: segments.length > 1 ? "1px" : "0",
    height: `${height}px`,
    // The wrapper rounds like a pill once it is tall enough to read as one.
    borderRadius: height >= 8 ? "9999px" : "3px",
    overflow: "hidden",
  };

  if (width === "flex") {
    style.flex = 1;
    style.minWidth = 0;
  } else {
    style.width = `${width}px`;
    style.flexShrink = 0;
  }

  return (
    <span
      data-slot="ratio-bar"
      className={cn(track === "card" && "bg-card", className)}
      style={style}
    >
      {segments.map((segment, i) => (
        <span
          key={i}
          style={{
            display: "block",
            // `flex-shrink:1` keeps a pair that sums to 100% from overflowing
            // by the 1px gap; a lone segment never competes, so it keeps its
            // exact percentage.
            flex: `0 1 ${Math.max(0, Math.min(100, segment.percent))}%`,
            height: "100%",
            background: segment.color,
            borderRadius: segment.radius
              ? SEGMENT_RADIUS[segment.radius]
              : undefined,
          }}
        />
      ))}
    </span>
  );
}
