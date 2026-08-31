"use client";

/**
 * PillButton — the ONLY button in the Piscine system.
 *
 * Collapses the eight separately-named things the frame readers found
 * (PillButton, FilledPillButton, OutlinePillButton, IconPill, OutlinePill,
 * FilledPill, OutlineButtonPill, IconRoundButton) into one primitive.
 *
 * House rules this component enforces:
 * - FILLED is always `--action` (deep water-green). NEVER black. At most one
 *   filled button per row — that is the caller's discipline, not enforceable here.
 * - Borders are 1.5px. 2px is reserved for selection, which a button never is.
 * - No shadow, ever. Hover darkens 8% (filled + action outline) or raises the
 *   border to `--border-strong` (neutral outline).
 * - Colour never encodes state: `pending` swaps the WORD, it does not recolour.
 *
 * Sizes are normalised. The frames draw h27/28/29/30/31/32; the architect's
 * resolution collapses those to three, accepting ±1-2px:
 *   sm  h28 / padding 0 13 / 12px   / icon 12  (band footers, Land rows, h27 instances)
 *   md  h30 / padding 0 13 / 12.5px / icon 13  (every header, 5a YOUR TURN h31 rows)
 *   lg  h32 / padding 0 16 / 12.5px / icon 13  (7a Save/Discard, 6a Send, 8c Create release)
 * Gaps follow the dominant instance of each size (sm 6, md 8, lg 7); a screen
 * that needs the other value passes `gap-*` in `className` — twMerge wins.
 */

import * as React from "react";
import { cva } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const pillButtonVariants = cva(
  [
    // Shared skeleton
    "relative inline-flex shrink-0 items-center justify-center",
    "whitespace-nowrap rounded-full font-sans font-semibold leading-none",
    "shadow-none outline-none",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "transition-[background-color,border-color,filter,opacity] duration-150 motion-reduce:transition-none",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Deep water-green. The only filled colour in the system.
        filled:
          "border-0 bg-action text-action-foreground hover:brightness-[0.92] dark:hover:brightness-[1.12]",
        outline: "border-[1.5px] bg-transparent text-foreground",
      },
      /** Only meaningful on `outline`; the filled variant has no border at all. */
      outlineTone: {
        action: "",
        neutral: "",
      },
      size: {
        sm: "h-[28px] gap-1.5 px-[13px] text-[12px]",
        md: "h-[30px] gap-2 px-[13px] text-[12.5px]",
        lg: "h-[32px] gap-[7px] px-4 text-[12.5px]",
      },
      iconOnly: {
        true: "h-[30px] w-[30px] gap-0 p-0",
        false: "",
      },
    },
    compoundVariants: [
      // Hover behaviour differs per outline tone: the neutral hairline raises to
      // --border-strong, the action outline darkens with its label.
      {
        variant: "outline",
        outlineTone: "neutral",
        className: "border-border hover:border-border-strong",
      },
      {
        variant: "outline",
        outlineTone: "action",
        className:
          "border-action-outline hover:brightness-[0.92] dark:hover:brightness-[1.12]",
      },
    ],
    defaultVariants: {
      variant: "filled",
      outlineTone: "action",
      size: "md",
      iconOnly: false,
    },
  },
);

export type PillButtonSize = "sm" | "md" | "lg";

/** Icon px per size. iconOnly always draws at 14. */
const ICON_PX: Record<PillButtonSize, number> = {
  sm: 12,
  md: 13,
  lg: 13,
};

export interface PillButtonProps
  extends Omit<
    React.ComponentPropsWithoutRef<"button">,
    "className" | "children" | "disabled" | "onClick"
  > {
  variant?: "filled" | "outline";
  /** Only meaningful on `outline`. `action` is the default outline border. */
  outlineTone?: "action" | "neutral";
  size?: PillButtonSize;
  /** Leading lucide glyph. Sized by `size` (or 14 when `iconOnly`). */
  icon?: LucideIcon;
  /** 30×30 circle with a centred 14px glyph and no label. */
  iconOnly?: boolean;
  /** Absolute count badge, top-right. Omit or pass 0-less values to hide. */
  badge?: number;
  /**
   * `danger` paints the LABEL (and its icon) coral — 7a's "Frictions · 20 open".
   * The border stays neutral: it is not tinted coral.
   */
  labelTone?: "ink" | "danger";
  /** Mutation in flight: disables and swaps the label. No spinner, ever. */
  pending?: boolean;
  pendingLabel?: string;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  children?: React.ReactNode;
}

export function PillButton({
  variant = "filled",
  outlineTone = "action",
  size = "md",
  icon: Icon,
  iconOnly = false,
  badge,
  labelTone = "ink",
  pending = false,
  pendingLabel,
  disabled = false,
  onClick,
  className,
  children,
  ...props
}: PillButtonProps) {
  const isDisabled = disabled || pending;
  const label = pending && pendingLabel !== undefined ? pendingLabel : children;
  const iconPx = iconOnly ? 14 : ICON_PX[size];
  const showBadge = typeof badge === "number" && badge > 0;

  return (
    <button
      type="button"
      data-slot="pill-button"
      data-variant={variant}
      data-size={size}
      onClick={onClick}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      className={cn(
        pillButtonVariants({ variant, outlineTone, size, iconOnly }),
        // Label tone lands after the variant so twMerge keeps it.
        labelTone === "danger" && "text-destructive",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon size={iconPx} aria-hidden="true" /> : null}
      {iconOnly ? (
        // Callers may still pass children as the accessible name.
        label ? <span className="sr-only">{label}</span> : null
      ) : (
        label
      )}
      {showBadge ? (
        <span
          className={cn(
            "absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center",
            "rounded-full bg-destructive px-1",
            "font-mono text-[9.5px] font-bold tabular-nums text-action-foreground",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export { pillButtonVariants };
