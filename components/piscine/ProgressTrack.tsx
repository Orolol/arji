import { cn } from "@/lib/utils";

/**
 * The indeterminate crawl bar under every live surface (5a session cards,
 * 6a AGENT ACTIVITY, 8a LIVE LOG) and the determinate variant for the 8d
 * PLAFOND MENSUEL cap.
 *
 * Motion is the state signal here, not colour — the reduced-motion guard on
 * `.piscine-crawl` in `app/globals.css` freezes the fill at FULL WIDTH so the
 * bar still reads as "a live surface" without animating. That is why the 28%
 * crawl width is a `w-[28%]` utility and not an inline style: Tailwind
 * utilities are layered, `.piscine-crawl` is not, so the unlayered
 * reduced-motion `width: 100%` out-ranks it. An inline width would win over
 * both and silently defeat the guard.
 *
 * NAMING: the colour props are `fillColor` / `trackColor` because they take a
 * raw `var(--token)` STRING. Across the Piscine primitives a bare `fill` is
 * always an enum naming a surface (`GhostInputPill`, `SelectPill`) and a bare
 * `track` is always an enum too (`RatioBar`); anything ending in `Color` is a
 * raw string. One rule, no guessing.
 *
 * NOTE the legacy `.progress-track` class is a different thing: 2px on
 * `--agent-track`, still serving two legacy call sites. Do not reuse it and do
 * not change it.
 */
export interface ProgressTrackProps {
  /** px. 4 everywhere live; 8 for the 8d monthly cap. */
  height?: number;
  /** Omit for the indeterminate crawl; pass 0-100 for a determinate fill. */
  percent?: number;
  /** Fill colour, as a `var(--token)` string. */
  fillColor?: string;
  /** Track colour, as a `var(--token)` string. */
  trackColor?: string;
  className?: string;
}

export function ProgressTrack({
  height = 4,
  percent,
  fillColor = "var(--strata-live-fill)",
  trackColor = "var(--strata-live-track)",
  className,
}: ProgressTrackProps) {
  const indeterminate = percent === undefined;

  return (
    <div
      data-slot="progress-track"
      data-indeterminate={indeterminate || undefined}
      className={cn("relative overflow-hidden rounded-full", className)}
      style={{ height: `${height}px`, background: trackColor }}
    >
      {indeterminate ? (
        <span
          className="piscine-crawl absolute inset-y-0 left-0 w-[28%]"
          style={{ background: fillColor }}
        />
      ) : (
        <span
          className="block h-full"
          style={{
            width: `${Math.max(0, Math.min(100, percent))}%`,
            background: fillColor,
          }}
        />
      )}
    </div>
  );
}
