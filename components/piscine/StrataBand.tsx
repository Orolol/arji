import * as React from "react";

import { cn } from "@/lib/utils";
import type { SurfaceStratum } from "@/lib/piscine/tokens";

/**
 * StrataBand — the one coloured-ground container of the Piscine design.
 *
 * Every band on every screen is this component: 5a WORKING / YOUR TURN /
 * READY TO LAND / UP NEXT, 6a USER STORIES / AGENT ACTIVITY / CONVERSATION /
 * GIT / DEPENDENCIES / AGENTS, 7a THE NUMBERS / PERSONA / CLI OPTIONS /
 * WHERE HE WORKS, 8a LIVE LOG / WORKTREE / PROMPT COMPOSÉ, 8b SPEC / MEMORY /
 * SUGGESTION / ANATOMIE, 8c NEXT RELEASE, 8d BY AGENT / BY PROJECT — plus the
 * white-card variant (`stratum="card"`) used by 8a SESSION / FILES TOUCHED /
 * ENSUITE, 8b DOCS, 8c HISTORY and the 8d tiles.
 *
 * House rules it enforces:
 * - radius 14 (= `var(--radius)`), flex column, NO border, NO shadow.
 * - colour is the STRATUM, never a state.
 * - an EMPTY band renders its header row and nothing else: there is no
 *   min-height, no padding floor and no filler element anywhere in here, so a
 *   band whose only child is its `<BandHeader/>` collapses to the label line.
 *   `gap` is a flex gap, which only materialises *between* children — passing
 *   a single child costs zero extra height.
 *
 * The band also carries the matching `.stratum-*` scope class from
 * `app/globals.css`, so every `.breathing-dot` / `.progress-track` /
 * `.crawl-fill` rendered inside it picks up this stratum's figure colours in
 * both themes without the caller wiring anything.
 */

/**
 * Grounds a band can sit on: the five strata, plus the two neutral variants.
 *
 * Alias of the shared {@link SurfaceStratum} vocabulary in
 * `lib/piscine/tokens.ts` — the SAME union `BandHeader`, `FieldKicker` and
 * `StatNumeral` take. One word, one meaning, across every primitive.
 */
export type BandStratum = SurfaceStratum;

/**
 * Padding presets measured off the frames:
 * - `full` — 14px 18px (5a full-width bands, 7a, 8a LIVE LOG, 8b ANATOMIE)
 * - `half` — 13px 18px (5a READY TO LAND / UP NEXT)
 * - `rail` — 13px 16px (6a overlay bands, 8a right rail, 8b right column)
 *
 * The 8d tiles use 15px 18px and the 8b SPEC band 16px 20px: those are
 * one-offs, pass them through `className` (`py-[15px] px-[18px]`).
 */
export type BandDensity = "full" | "half" | "rail";

export interface StrataBandProps {
  /** Which ground this band paints. Colour = stratum, never state. */
  stratum: BandStratum;
  /** Padding preset. Defaults to `full` (14px 18px). */
  density?: BandDensity;
  /** Vertical gap between the band's children, in px. Defaults to 10. */
  gap?: number;
  /**
   * `flex: 1; min-height: 0` — the band absorbs the leftover column height.
   * EXACTLY ONE band per screen may set this (5a WORKING, 6a AGENT ACTIVITY,
   * 7a WHERE HE WORKS, 8a LIVE LOG, 8b MEMORY). Every other band is
   * `flex: 0 0 auto` and sizes to its own content.
   */
  grow?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const GROUND: Record<BandStratum, string> = {
  live: "bg-strata-live stratum-live",
  you: "bg-strata-you stratum-you",
  land: "bg-strata-land stratum-land",
  next: "bg-strata-next stratum-next",
  feed: "bg-strata-feed stratum-feed",
  card: "bg-card",
  paper: "bg-transparent",
};

const DENSITY: Record<BandDensity, string> = {
  full: "py-[14px] px-[18px]",
  half: "py-[13px] px-[18px]",
  rail: "py-[13px] px-[16px]",
};

export function StrataBand({
  stratum,
  density = "full",
  gap = 10,
  grow = false,
  className,
  children,
}: StrataBandProps) {
  return (
    <div
      data-slot="strata-band"
      data-stratum={stratum}
      className={cn(
        // `piscine-band` animates height changes over 200ms and is already
        // neutralised under prefers-reduced-motion in app/globals.css.
        "piscine-band flex flex-col rounded-lg",
        grow ? "min-h-0 flex-1" : "shrink-0",
        GROUND[stratum],
        DENSITY[density],
        className,
      )}
      style={{ gap: `${gap}px` }}
    >
      {children}
    </div>
  );
}
