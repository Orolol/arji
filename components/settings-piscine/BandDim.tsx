import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * BandDim — the master-toggle behaviour of frame 11c: "master toggles disable
 * their band's controls (band drops to 60% opacity, label stays)".
 *
 * Wrap the band's BODY only; the `BandHeader` (label + master toggle) stays
 * outside at full opacity, which is what "label stays" means.
 *
 * `pointer-events-none` does not stop Tab, so every control inside must ALSO
 * receive `disabled` — callers pass the same boolean down. `aria-disabled`
 * states the fact for assistive tech.
 *
 * A control that must stay editable while the master is off opts back in with
 * `pointer-events-auto`, `aria-disabled={false}` and no `disabled` prop (Full
 * Auto's two workspace-default agent pills are the one instance — see
 * FullAutoBand). Dim is the state; `disabled` is the stronger claim that
 * editing it would change nothing, so a band whose master does not actually
 * suspend a control should reach for this opt-out rather than dress a live
 * setting as inert.
 */
export interface BandDimProps {
  dimmed: boolean;
  /** Vertical gap between the body's children, in px. Defaults to 10. */
  gap?: number;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}

export function BandDim({
  dimmed,
  gap = 10,
  testId,
  className,
  children,
}: BandDimProps) {
  return (
    <div
      data-slot="band-dim"
      data-testid={testId}
      aria-disabled={dimmed || undefined}
      className={cn(
        "flex flex-col",
        "transition-opacity duration-200 motion-reduce:transition-none",
        dimmed && "pointer-events-none opacity-60",
        className,
      )}
      style={{ gap: `${gap}px` }}
    >
      {children}
    </div>
  );
}
