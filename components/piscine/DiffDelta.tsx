import { cn } from "@/lib/utils";

import { Mono } from "./Mono";

/**
 * Inline added/removed line counts inside log lines, file rows, band metas and
 * git diffstats (5a, 6a, 8a, 8b).
 *
 * The removed count uses U+2212 MINUS SIGN, not an ASCII hyphen: the hyphen is
 * not a tabular glyph in Space Mono and breaks column alignment down a file
 * list.
 *
 * `null`/`undefined` renders nothing — never "+0". Pass an explicit `0` where a
 * frame deliberately shows a zero side (8a file row 2 shows "−0").
 *
 * LAYOUT: the two counts are emitted as SIBLINGS of whatever surrounds them —
 * the wrapper is `display:contents` — because every frame spaces them with the
 * parent row's own `gap` (10px in 8a file rows) or with plain inline text flow
 * (the log lines). So `className` here is a styling hook, not a layout box:
 * position the counts from the parent.
 */
export interface DiffDeltaProps {
  added?: number | null;
  removed?: number | null;
  /** px. 11.5 in logs, 11 in file rows, 10.5 in band metas. */
  size?: number;
  className?: string;
}

export function DiffDelta({
  added,
  removed,
  size = 11,
  className,
}: DiffDeltaProps) {
  const hasAdded = added !== null && added !== undefined;
  const hasRemoved = removed !== null && removed !== undefined;

  if (!hasAdded && !hasRemoved) return null;

  return (
    <span className={cn("contents", className)} data-slot="diff-delta">
      {hasAdded ? (
        <Mono size={size} tone="live-deep">
          {`+${added}`}
        </Mono>
      ) : null}
      {hasRemoved ? (
        <Mono size={size} tone="danger">
          {`−${removed}`}
        </Mono>
      ) : null}
    </span>
  );
}
