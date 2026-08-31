"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/utils/format-elapsed";

/**
 * The ticking elapsed-time numeral (5a session cards 21px, 6a overlay header
 * 19px, 8a session header 20px).
 *
 * Owns its own 1s interval, cleared on unmount. Do NOT format elapsed time
 * inline during a parent's render the way `components/dashboard/ProjectGrid.tsx`
 * does — such a chrono only advances on the parent's 10s poll.
 */

/**
 * The elapsed maths lives in `lib/utils/format-elapsed.ts` and stays there; this
 * only reshapes its output to the compact form every frame draws.
 *
 * SPEC CONFLICT, resolved: the primitive spec says "format via the EXISTING
 * formatElapsed" and then quotes "4m12" / "1m03" / "47s" / "22m08" — but
 * `formatElapsed` returns "4m 12s" / "1m 3s" / "47s" / "22m 8s". Those two
 * cannot both be true. The frames (5a, 6a, 6c, 7a, 8a all render "4m12") win on
 * the string, and the un-padded "1m 3s" → "1m 12s" transition changes the glyph
 * COUNT, so it jitters even with tabular figures — exactly the defect the spec
 * calls out. So: keep one source for the arithmetic, normalise the presentation
 * here. Anything that does not match a known shape passes through untouched.
 */
function compact(elapsed: string): string {
  const match = /^(\d+)([mh])\s(\d+)[ms]$/.exec(elapsed);
  if (!match) return elapsed; // "47s", and any future shape
  return `${match[1]}${match[2]}${match[3].padStart(2, "0")}`;
}

export interface ChronoProps {
  /** ISO timestamp the session started at. */
  startedAt: string;
  /** px. 21 on 5a cards, 20 on the 8a header, 19 on the 6a overlay header. */
  size?: number;
  tone?: "live" | "ink";
  className?: string;
}

export function Chrono({
  startedAt,
  size = 21,
  tone = "live",
  className,
}: ChronoProps) {
  const [label, setLabel] = useState(() => compact(formatElapsed(startedAt)));

  useEffect(() => {
    function tick() {
      setLabel(compact(formatElapsed(startedAt)));
    }

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    // The server and the first client paint can straddle a second boundary.
    <span
      data-slot="chrono"
      className={cn(
        // tabular-nums ALWAYS, even where a frame omits it — that is a canvas
        // oversight, and a per-second ticker without tabular figures jitters.
        "shrink-0 font-mono font-bold tabular-nums",
        tone === "ink" ? "text-foreground" : "text-strata-live-deep",
        className,
      )}
      // Open number, so it stays inline; everything enumerable is a class.
      style={{ fontSize: `${size}px` }}
      suppressHydrationWarning
    >
      {label}
    </span>
  );
}
