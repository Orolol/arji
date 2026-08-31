import * as React from "react";

import { cn } from "@/lib/utils";
import type { SurfaceStratum } from "@/lib/piscine/tokens";

/**
 * FieldKicker — the uppercase mono micro-label above a control or inside a
 * tile: NAME / CLI / MODEL / RETRY ESCALATION / EFFORT / PERMISSION MODE and
 * the five assignment-tile task names (7a), QUEUED · N and TODAY (5a),
 * CLIS ON THIS MACHINE (7a), CHANGELOG (8c), the stat-tile captions (8c/8d).
 *
 * 9.5px is the floor the design allows, and only for exactly this kind of
 * uppercase tracked mono label; everything else in the system is >= 11px.
 * Tracking loosens to .08em at 10/10.5px and tightens to .06em at 9.5px.
 *
 * Colour comes from the GROUND the kicker sits on, so the pairing stays AA:
 * card/paper → `--muted-foreground`, and each strata ground → its own mid tone.
 * The prop is `stratum` and its values are the shared {@link SurfaceStratum}
 * vocabulary — the same word, the same union, as `StrataBand` and `BandHeader`.
 */

/** 10 is the common size; 10.5 for band-adjacent metas, 9.5 for numeral captions. */
export type KickerSize = 9.5 | 10 | 10.5;

export interface FieldKickerProps {
  /** Which ground this kicker is printed on. Defaults to `card`. */
  stratum?: SurfaceStratum;
  /** Defaults to 10. */
  size?: KickerSize;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The stratum's MID tone. `feed` deliberately has no `-mid` token — frames 7a
 * and 8b use the deep linden for helper text on that ground. Identical mapping
 * to `BandHeader`'s meta tone, on purpose.
 */
const STRATUM_TONE: Record<SurfaceStratum, string> = {
  card: "text-muted-foreground",
  paper: "text-muted-foreground",
  live: "text-strata-live-mid",
  you: "text-strata-you-mid",
  land: "text-strata-land-mid",
  next: "text-strata-next-mid",
  feed: "text-strata-feed-deep",
};

const SIZE: Record<string, string> = {
  "9.5": "text-[9.5px] tracking-[.06em]",
  "10": "text-[10px] tracking-[.08em]",
  "10.5": "text-[10.5px] tracking-[.08em]",
};

export function FieldKicker({
  stratum = "card",
  size = 10,
  className,
  children,
}: FieldKickerProps) {
  return (
    <span
      data-slot="field-kicker"
      data-stratum={stratum}
      className={cn(
        "font-mono font-bold uppercase tabular-nums",
        SIZE[String(size)],
        STRATUM_TONE[stratum],
        className,
      )}
    >
      {children}
    </span>
  );
}
