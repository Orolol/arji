"use client";

/**
 * CheckMark — the 18px completion toggle, in both of its shapes.
 *
 * Absorbs the frame readers' StoryCheckDisc (6a user-story done discs, round,
 * turquoise) and CheckSquare (8c release-inclusion, r6, action green).
 *
 * `onToggle` makes it a real button; omit it for read-only display, in which
 * case the mark renders as a decorative span and the row's own text carries the
 * meaning for assistive tech.
 *
 * GLYPH COLOUR — resolved conflict: the primitive spec says the check is
 * `--card`, which is correct in day (card #fffef8 on the turquoise/green fill)
 * but inverts in night, where `--card` is the LIGHTER dark ink #3a382f and the
 * glyph would vanish. Frame 8c already specifies `--action-foreground` for the
 * square. We ship `--action-foreground` for both shapes: it is the documented
 * partner of the filled grounds, it is within 3 units of `--card` in day, and it
 * stays legible in night.
 */

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export interface CheckMarkProps {
  checked: boolean;
  /** `disc` = 6a user stories. `square` = 8c release inclusion. */
  shape?: "disc" | "square";
  /** Checked fill: `live` = --strata-live-fill (6a), `action` = --action (8c). */
  tone?: "live" | "action";
  onToggle?: () => void;
  disabled?: boolean;
  className?: string;
}

export function CheckMark({
  checked,
  shape = "disc",
  tone = "live",
  onToggle,
  disabled = false,
  className,
}: CheckMarkProps) {
  const classes = cn(
    "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center",
    "shadow-none outline-none",
    "transition-[background-color,border-color,opacity] duration-150 motion-reduce:transition-none",
    shape === "disc" ? "rounded-full" : "rounded-[6px]",
    checked
      ? cn(
          "border-0 text-action-foreground",
          tone === "live" ? "bg-strata-live-fill" : "bg-action",
        )
      : "border-[1.5px] border-border-strong bg-transparent",
    onToggle &&
      "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
    className,
  );

  const glyph = checked ? <Check size={11} aria-hidden="true" /> : null;

  if (!onToggle) {
    return (
      <span data-slot="check-mark" data-checked={checked || undefined} aria-hidden="true" className={classes}>
        {glyph}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-slot="check-mark"
      data-checked={checked || undefined}
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={classes}
    >
      {glyph}
    </button>
  );
}
