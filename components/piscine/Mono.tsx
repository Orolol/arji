import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Every mono run of text in the Piscine design.
 *
 * This component exists to close the biggest fidelity trap in the handoff: the
 * design canvas's `.mono` helper resolves to "Geist Mono" and omits
 * `tabular-nums` on inline-styled elements. Routing all mono text through one
 * component makes Space Mono + tabular figures impossible to forget.
 *
 * CHARACTER FIDELITY IS LOAD-BEARING. Callers pass the real Unicode codepoints,
 * never ASCII lookalikes:
 *   U+2212 MINUS SIGN (−) for deletion counts — an ASCII hyphen breaks Space
 *   Mono's tabular alignment — plus U+2713 (✓), U+00B7 (·), U+2192 (→),
 *   U+203A (›), U+2014 (—) and U+2026 (…).
 *
 * IDIOM: colour, weight and case are Tailwind utilities (so `className` can
 * override them through `cn`/twMerge). `size` and `tracking` stay inline
 * because they are open numbers, not an enumerable variant.
 */
export type MonoTone =
  | "ink"
  | "muted"
  | "live-deep"
  | "live-mid"
  | "you-deep"
  | "you-mid"
  | "land-mid"
  | "land-deep"
  | "next-deep"
  | "next-mid"
  | "feed-deep"
  | "danger";

/**
 * Mono tone → palette token, as `var(--token)` STRINGS.
 *
 * Exported for the cases a class name cannot reach: an SVG `fill`, a canvas
 * context, a chart library that wants a colour string. Inside a DOM tree,
 * prefer {@link MONO_TONE_CLASS} / the component itself.
 */
export const MONO_TONE: Record<MonoTone, string> = {
  ink: "var(--foreground)",
  muted: "var(--muted-foreground)",
  "live-deep": "var(--strata-live-deep)",
  "live-mid": "var(--strata-live-mid)",
  "you-deep": "var(--strata-you-deep)",
  "you-mid": "var(--strata-you-mid)",
  "land-mid": "var(--strata-land-mid)",
  "land-deep": "var(--strata-land-deep)",
  "next-deep": "var(--strata-next-deep)",
  "next-mid": "var(--strata-next-mid)",
  "feed-deep": "var(--strata-feed-deep)",
  danger: "var(--destructive)",
};

/** The same map as Tailwind text utilities — what the component actually emits. */
export const MONO_TONE_CLASS: Record<MonoTone, string> = {
  ink: "text-foreground",
  muted: "text-muted-foreground",
  "live-deep": "text-strata-live-deep",
  "live-mid": "text-strata-live-mid",
  "you-deep": "text-strata-you-deep",
  "you-mid": "text-strata-you-mid",
  "land-mid": "text-strata-land-mid",
  "land-deep": "text-strata-land-deep",
  "next-deep": "text-strata-next-deep",
  "next-mid": "text-strata-next-mid",
  "feed-deep": "text-strata-feed-deep",
  danger: "text-destructive",
};

export interface MonoProps {
  /** px. Frames use 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 21 / 22 / 26. */
  size?: number;
  weight?: 400 | 700;
  tone?: MonoTone;
  uppercase?: boolean;
  /** Letter-spacing in em. Kicker labels use .06 (at 9.5px) or .08. */
  tracking?: number;
  /** `1` applies a single-line clamp. */
  clamp?: 1;
  as?: "span" | "div";
  className?: string;
  children: ReactNode;
}

export function Mono({
  size = 11,
  weight = 400,
  tone = "ink",
  uppercase = false,
  tracking,
  clamp,
  as = "span",
  className,
  children,
}: MonoProps) {
  const Tag = as;

  // Open numbers only: everything enumerable is a utility class below.
  const style: CSSProperties = { fontSize: `${size}px` };
  if (tracking !== undefined) style.letterSpacing = `${tracking}em`;

  return (
    <Tag
      data-slot="mono"
      className={cn(
        // tabular-nums ALWAYS. A mono run without tabular figures jitters the
        // moment a digit changes, and half the mono in this design is a counter.
        "font-mono tabular-nums",
        weight === 700 ? "font-bold" : "font-normal",
        uppercase && "uppercase",
        clamp === 1 && "line-clamp-1",
        MONO_TONE_CLASS[tone],
        className,
      )}
      style={style}
    >
      {children}
    </Tag>
  );
}
