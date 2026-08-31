import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { SurfaceStratum } from "@/lib/piscine/tokens";

import { FieldKicker } from "./FieldKicker";
import { Mono, type MonoTone } from "./Mono";

/**
 * The big-figure-over-caption pair: 7a THE NUMBERS (5 numerals), 8c stat tiles,
 * 8d top tile row, 5a TODAY tile.
 *
 * Colour on the figure is one of exactly two loud accents — turquoise for a
 * healthy count (CLEAN %, ready counts), coral for a failure count
 * (ESCALATIONS, failed) — and nothing else. Everything neutral stays ink.
 */
const FIGURE_TONE: Record<"ink" | "live" | "danger", MonoTone> = {
  ink: "ink",
  live: "live-deep",
  danger: "danger",
};

export interface StatNumeralProps {
  /** `null`/`undefined` renders an em-dash, never a zero. */
  value: ReactNode;
  caption: string;
  tone?: "ink" | "live" | "danger";
  /** px. 22 on 7a THE NUMBERS, 26 on the 8d tiles. */
  size?: 22 | 26;
  /** Which ground the CAPTION is printed on. Shared stratum vocabulary. */
  captionStratum?: SurfaceStratum;
  className?: string;
}

export function StatNumeral({
  value,
  caption,
  tone = "ink",
  size = 22,
  captionStratum = "card",
  className,
}: StatNumeralProps) {
  // A data gap is an em-dash. Rendering it as 0 is a lie the rest of the app
  // does not tell — see the `—` fallbacks in lib/types/usage.ts.
  const figure = value === null || value === undefined ? "—" : value;

  return (
    <div
      data-slot="stat-numeral"
      className={cn("flex flex-col gap-[3px]", className)}
    >
      <Mono size={size} weight={700} tone={FIGURE_TONE[tone]}>
        {figure}
      </Mono>
      <FieldKicker size={size === 26 ? 10 : 9.5} stratum={captionStratum}>
        {caption}
      </FieldKicker>
    </div>
  );
}
