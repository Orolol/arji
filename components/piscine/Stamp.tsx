import type { ReactNode } from "react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

import { BreathingDot } from "./BreathingDot";

/**
 * Every mono uppercase state stamp: 5a ASKS YOU / FAILED / CONFLICT,
 * 6a + 8a LIVE · BUILD, 8c TAG / GH RELEASE.
 *
 * State is carried by the WORD plus a colour FAMILY (turquoise = alive, coral =
 * blocking), never by an arbitrary per-status colour. There are exactly two loud
 * colours on a screen; a stamp is one of the few places they are allowed.
 *
 * SPEC CONFLICT, resolved: the handoff README says all three coral wordings
 * share one fill/text pair, while frames 5a and 6a and the tokens.css comments
 * give FAILED its own heavier pair (--strata-you-stamp2 / --strata-you-stamp-text).
 * Two frames plus the token comments beat one README sentence — the two-pair
 * version ships.
 */
export type StampTone =
  | "live"
  | "asks"
  | "failed"
  | "conflict"
  | "land"
  | "next";

const stampVariants = cva(
  [
    "inline-flex shrink-0 items-center gap-1.5 rounded-full",
    "font-mono text-[10px] font-bold tabular-nums leading-none",
  ].join(" "),
  {
    variants: {
      tone: {
        live: "bg-strata-live-track px-[9px] py-[3px] text-strata-live-deep",
        asks: "bg-strata-you-stamp px-2 py-[3px] text-strata-you-deep",
        conflict: "bg-strata-you-stamp px-2 py-[3px] text-strata-you-deep",
        failed:
          "bg-strata-you-stamp2 px-2 py-[3px] text-strata-you-stamp-text",
        land: "bg-strata-land px-2 py-[2px] text-strata-land-deep",
        next: "bg-strata-next px-2 py-[2px] text-strata-next-deep",
      },
    },
    defaultVariants: { tone: "live" },
  },
);

export interface StampProps {
  tone: StampTone;
  /** Prepends a 6px breathing dot. Only meaningful on `live`. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

export function Stamp({ tone, dot = false, className, children }: StampProps) {
  return (
    <span
      data-slot="stamp"
      data-tone={tone}
      className={cn(stampVariants({ tone }), className)}
    >
      {dot ? <BreathingDot size={6} tone="live" /> : null}
      {children}
    </span>
  );
}

export { stampVariants };
