import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { BreathingDot } from "./BreathingDot";

/**
 * One mono log/timeline line, shared by 6a WHAT THE AGENT IS DOING and 8a LIVE
 * LOG. Encodes the design's four-glyph line grammar:
 *
 *   ✓  a completed step        (turquoise mid)
 *   $  a shell command          (dim)
 *   ·  a summary / test result  (ink — it is the line you actually read)
 *   ●  the running line         (breathing dot + turquoise deep, no glyph)
 *
 * `error` is the documented fifth kind: not drawn in any frame, coloured to
 * match the −N deletion colour so a failure line and a deletion count read as
 * the same family.
 *
 * Inline +N/−N spans inside `children` come from `<DiffDelta>`.
 */
export type TimelineKind = "done" | "command" | "summary" | "live" | "error";

const GLYPH: Record<TimelineKind, string> = {
  done: "✓ ", // U+2713 CHECK MARK
  command: "$ ",
  summary: "· ", // U+00B7 MIDDLE DOT
  live: "",
  error: "",
};

const KIND_CLASS: Record<TimelineKind, string> = {
  done: "text-strata-live-mid",
  command: "text-muted-foreground",
  summary: "text-foreground",
  live: "text-strata-live-deep",
  error: "text-strata-you-deep",
};

const SIZE_CLASS: Record<string, string> = {
  "11": "text-[11px]",
  "11.5": "text-[11.5px]",
};

export interface TimelineLineProps {
  kind: TimelineKind;
  /** Rendered as an "mm:ss " prefix, before the glyph. */
  timestamp?: string;
  /** px. 11 in the 6a overlay, 11.5 in the 8a live log. */
  size?: 11 | 11.5;
  className?: string;
  children: ReactNode;
}

export function TimelineLine({
  kind,
  timestamp,
  size = 11,
  className,
  children,
}: TimelineLineProps) {
  const base = cn(
    "font-mono leading-[1.5] tabular-nums",
    SIZE_CLASS[String(size)],
    KIND_CLASS[kind],
  );

  if (kind === "live") {
    return (
      <span
        data-slot="timeline-line"
        data-kind={kind}
        className={cn(base, "flex items-center gap-[7px]", className)}
      >
        <BreathingDot size={6} tone="live" />
        {timestamp ? `${timestamp} ` : null}
        {children}
      </span>
    );
  }

  return (
    <span
      data-slot="timeline-line"
      data-kind={kind}
      className={cn(base, className)}
    >
      {timestamp ? `${timestamp} ` : null}
      {GLYPH[kind]}
      {children}
    </span>
  );
}
