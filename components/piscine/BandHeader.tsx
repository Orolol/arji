import * as React from "react";

import { cn } from "@/lib/utils";
import type { SurfaceStratum } from "@/lib/piscine/tokens";
import { Mono, type MonoTone } from "@/components/piscine/Mono";

/**
 * BandHeader — the label row of every {@link StrataBand}.
 *
 * An uppercase Bricolage label sitting on its 3px stratum underline, an
 * optional mono counter / helper beside it, and an optional right-aligned slot
 * pushed by `margin-left: auto`.
 *
 * The row is baseline-aligned (not centred): that is what makes the 12px
 * Bricolage label sit level with the 10.5px mono meta. `align="center"` exists
 * for the single frame that needs it (8b SPEC, whose header hosts a 30px
 * segmented control).
 *
 * SPEC CONFLICT, RESOLVED: 5a's four full-width desk bands draw the label at
 * 13px; frames 6a / 7a / 8a / 8b / 8c all draw it at 12px. 12 is therefore the
 * default and the 5a desk is the documented exception that passes
 * `labelSize={13}`.
 */

/**
 * Strata a band label can belong to.
 *
 * The shared {@link SurfaceStratum} vocabulary — the same union `StrataBand`
 * takes — plus `neutral`. `card` and `paper` are ALIASES of `neutral`, so a
 * neutral band pairs without a vocabulary switch:
 *
 *   <StrataBand stratum="card"><BandHeader stratum="card" label="Session" />
 *
 * `neutral` stays for headers with no band around them.
 */
export type BandHeaderStratum = SurfaceStratum | "neutral";

export interface BandHeaderProps {
  /**
   * Label copy, authored in sentence case — CSS uppercases it, so screen
   * readers and copy files keep the readable form.
   */
  label: string;
  /** Which stratum the label belongs to. `neutral` = ink on `--border`. */
  stratum: BandHeaderStratum;
  /** 12 everywhere (default); 13 only on the 5a desk's full-width bands. */
  labelSize?: 12 | 13;
  /** Mono counter / helper rendered beside the label in the stratum's mid tone. */
  meta?: React.ReactNode;
  /** Right-aligned slot (link, pill, toggle, segmented control). */
  right?: React.ReactNode;
  /** `baseline` (default) or `center` — the latter only for 8b SPEC. */
  align?: "baseline" | "center";
  /**
   * `align-self: flex-start`, so the underline hugs the word rather than the
   * band. Use on every narrow rail band where the label stands alone.
   */
  standalone?: boolean;
  className?: string;
}

/** Label colour + 3px underline colour, per stratum. */
const LABEL_TONE: Record<BandHeaderStratum, string> = {
  live: "text-strata-live-deep border-strata-live-under",
  you: "text-strata-you-deep border-strata-you-under",
  land: "text-strata-land-deep border-strata-land-under",
  next: "text-strata-next-deep border-strata-next-under",
  feed: "text-strata-feed-deep border-strata-feed-under",
  neutral: "text-foreground border-border",
  // `card` / `paper` are the neutral ground under another name.
  card: "text-foreground border-border",
  paper: "text-foreground border-border",
};

/**
 * Meta colour: the stratum's MID tone. `feed` deliberately has no `-mid`
 * token — frames 7a and 8b use the deep linden for helper text on that ground.
 */
const META_TONE: Record<BandHeaderStratum, MonoTone> = {
  live: "live-mid",
  you: "you-mid",
  land: "land-mid",
  next: "next-mid",
  feed: "feed-deep",
  neutral: "muted",
  card: "muted",
  paper: "muted",
};

const LABEL_SIZE: Record<12 | 13, string> = {
  12: "text-[12px]",
  13: "text-[13px]",
};

export function BandHeader({
  label,
  stratum,
  labelSize = 12,
  meta,
  right,
  align = "baseline",
  standalone = false,
  className,
}: BandHeaderProps) {
  return (
    <div
      data-slot="band-header"
      data-stratum={stratum}
      className={cn(
        // Wraps so a long `meta` line or the `right` slot drops to a second
        // line on a narrow viewport rather than widening the whole band.
        "flex flex-wrap gap-[12px]",
        align === "center" ? "items-center" : "items-baseline",
        standalone && "self-start",
        className,
      )}
    >
      <span
        data-slot="band-label"
        className={cn(
          "font-display font-bold uppercase tracking-[.1em]",
          "border-b-[3px] pb-[2px]",
          LABEL_SIZE[labelSize],
          LABEL_TONE[stratum],
        )}
      >
        {label}
      </span>
      {meta !== undefined && meta !== null && meta !== false ? (
        <Mono size={10.5} tone={META_TONE[stratum]}>
          {meta}
        </Mono>
      ) : null}
      {right ? (
        <div data-slot="band-header-right" className="ml-auto">
          {right}
        </div>
      ) : null}
    </div>
  );
}
