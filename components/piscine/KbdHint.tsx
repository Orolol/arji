/**
 * KbdHint — the small keycap. 6a's "esc" hint and any future keyboard affordance.
 *
 * A RECTANGLE, not a pill: radius 6. This is the one small control in the system
 * that is deliberately not round, so it reads as a key rather than as a chip.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export interface KbdHintProps {
  className?: string;
  children: React.ReactNode;
}

export function KbdHint({ className, children }: KbdHintProps) {
  return (
    <kbd
      data-slot="kbd-hint"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "rounded-[6px] border-[1.5px] border-border bg-transparent",
        "px-2 py-[3px]",
        "font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
