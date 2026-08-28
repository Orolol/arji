import { cn } from "@/lib/utils";
import type { ProjectTone } from "@/lib/piscine/tokens";

/**
 * Liveness indicator — and, with `animate={false}`, the static readiness dot
 * (7a CLI inventory rows, 7a CLI field).
 *
 * The reduced-motion guard lives in `app/globals.css` on `.piscine-breathe`;
 * this component only opts into the class.
 *
 * NEVER ship `#4ed49b`. That green is the design canvas's `.dot` default which
 * every frame overrides inline — if it ever appears in a screen, a canvas
 * helper class was copied verbatim.
 */
export interface BreathingDotProps {
  /** px, square. Used at 6, 7, 8 and 20 across the frames. */
  size?: number;
  tone?: "live" | "project" | "idle";
  /** Which project colour when `tone="project"`. */
  projectTone?: ProjectTone;
  /** `idle` is never animated regardless of this flag. */
  animate?: boolean;
  className?: string;
}

/** Explicit maps — Tailwind only emits classes it can see written out in full. */
const PROJECT_FILL: Record<ProjectTone, string> = {
  1: "bg-project-1-deep",
  2: "bg-project-2-deep",
  3: "bg-project-3-deep",
  4: "bg-project-4-deep",
};

export function BreathingDot({
  size = 6,
  tone = "live",
  projectTone = 1,
  animate = true,
  className,
}: BreathingDotProps) {
  const fill =
    tone === "project"
      ? PROJECT_FILL[projectTone]
      : tone === "idle"
        ? "bg-border-strong"
        : "bg-strata-live-fill";

  // An idle dot means "present but not running" — motion would contradict it.
  const moving = animate && tone !== "idle";

  return (
    <span
      data-slot="breathing-dot"
      data-tone={tone}
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-full",
        fill,
        moving && "piscine-breathe",
        className,
      )}
      // Open number, so it stays inline; everything enumerable is a class.
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}
