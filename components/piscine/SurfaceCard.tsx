import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SurfaceCard — the white (or translucent-white) card that sits on a strata
 * ground: 5a session cards, QUEUED / TODAY tiles, AttentionRows and Land rows;
 * 6a description / story / comment cards; 7a roster and assignment tiles;
 * 8a terminal card; 8b memory and editor cards; 8c ticket rows and changelog.
 *
 * No border and no shadow at rest — the card is told apart from its ground by
 * fill alone (in night the relationship flips: the card is *lighter* than the
 * ground, which `--card` already handles).
 *
 * SELECTION vs HOVER, and why there is a transparent border at rest:
 * the frames draw no border on an unselected card and a 2px ink border on a
 * selected one, which would reflow the card by 2px per side on selection. We
 * reserve the space with a 1.5px transparent border, so:
 * - rest        → 1.5px transparent (invisible, no reflow)
 * - `interactive` hover → 1.5px `--border-strong`  (house rule: borders 1.5px)
 * - `selected`  → 2px `--foreground`               (house rule: 2px = selection only)
 * Switching between them costs 0.5px per side, i.e. nothing you can see, and
 * never the 4px jump a naive implementation would produce.
 *
 * EXTENSION (packet A, frame 5a): the component spreads the remaining
 * `<div>` props onto its root, so a caller can attach `data-testid`, `id`,
 * `role`, `onClick` or `tabIndex` without wrapping the card in an extra
 * element — a wrapper would break the grid/flex layouts the frames rely on
 * (the card IS the grid cell). `className` and `children` stay explicit so
 * `cn()` keeps the last word on styling. Purely additive: no existing call
 * site changes behaviour.
 */

/** Corner radius, in px. 12 default; 10 for tight story rows and the 8a terminal card; 11 for 7a tiles and 8c ticket rows. */
export type SurfaceRadius = 10 | 11 | 12;

export interface SurfaceCardProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "className" | "children"> {
  /** Use `--card-translucent` instead of the solid card fill. */
  translucent?: boolean;
  /** Corner radius in px. Defaults to 12. */
  radius?: SurfaceRadius;
  /** Draw the 2px ink selection border. Reserved at rest — never reflows. */
  selected?: boolean;
  /** Raise the border to `--border-strong` on hover. No shadow, no lift. */
  interactive?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const RADIUS: Record<SurfaceRadius, string> = {
  10: "rounded-[10px]",
  11: "rounded-[11px]",
  12: "rounded-[12px]",
};

export function SurfaceCard({
  translucent = false,
  radius = 12,
  selected = false,
  interactive = false,
  className,
  children,
  ...props
}: SurfaceCardProps) {
  return (
    <div
      data-slot="surface-card"
      data-selected={selected ? "" : undefined}
      {...props}
      className={cn(
        translucent ? "bg-card-translucent" : "bg-card",
        RADIUS[radius],
        // Reserved, invisible at rest. See the note above.
        "border-[1.5px] border-transparent",
        interactive &&
          "cursor-pointer transition-colors hover:border-border-strong motion-reduce:transition-none",
        selected && "border-2 border-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
