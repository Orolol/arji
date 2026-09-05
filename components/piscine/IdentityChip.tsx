"use client";

import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { ProjectTone } from "@/lib/piscine/tokens";

import { BreathingDot } from "./BreathingDot";

/**
 * Project identity and ticket identity in one component — the frame readers
 * named it ProjectChip, TicketChip, IdChip and TicketIdChip, but it is the same
 * primitive at two sizes.
 *
 * Colour is ALWAYS project identity, NEVER state. `tone` comes from
 * `projectTone(project.colorIndex)` in `lib/piscine/tokens.ts`; the fill/deep
 * pair is guaranteed AA in both themes, so never mix a fill from one tone with
 * text from another.
 */

/**
 * Explicit fill/text pairs. Written out in full because Tailwind only emits a
 * utility it can literally see — `bg-project-${tone}` would compile and render
 * transparent.
 */
const CHIP_TONE: Record<ProjectTone, string> = {
  1: "bg-project-1 text-project-1-deep",
  2: "bg-project-2 text-project-2-deep",
  3: "bg-project-3 text-project-3-deep",
  4: "bg-project-4 text-project-4-deep",
};

const identityChipVariants = cva(
  "inline-flex shrink-0 items-center rounded-full leading-none",
  {
    variants: {
      size: {
        /** Ticket ids and project short names: 5a cards, 6a/8a headers, 8c rows. */
        sm: "px-[7px] py-[2px] font-mono text-[10px] font-bold tabular-nums",
        /** The header filter chips: 5a / 8b / 8c. */
        md: "h-[28px] gap-[7px] px-3 font-sans text-[12.5px] font-semibold",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export interface IdentityChipProps {
  label: string;
  tone: ProjectTone;
  /** `sm` (default) = mono id chip. `md` = the header filter chip. */
  size?: "sm" | "md";
  /**
   * What the chip paints itself.
   *
   * `identity` (default) = the project pastel behind the deep text.
   * `none` = transparent, deep text only — frame 13a's INACTIVE top-bar project
   * chips, where the pastel fill is reserved for the active project. The
   * fill/deep pair still comes from one tone, so the text stays AA on paper.
   */
  fill?: "identity" | "none";
  /** Appends a 6px breathing dot in the project deep colour. `md` only. */
  live?: boolean;
  /** Swaps the fill to the card colour, keeping the deep text (6a DependencyRow). */
  onGround?: boolean;
  onClick?: () => void;
  className?: string;
}

export function IdentityChip({
  label,
  tone,
  size = "sm",
  fill = "identity",
  live = false,
  onGround = false,
  onClick,
  className,
}: IdentityChipProps) {
  const classes = cn(
    identityChipVariants({ size }),
    CHIP_TONE[tone],
    // Both land after the tone so twMerge keeps the new fill and the deep text.
    fill === "none" && "bg-transparent",
    onGround && "bg-card",
    className,
  );

  // The dot is only defined for the md chip: at 10px mono there is no room for
  // it beside the label without breaking the 2px vertical padding.
  const dot =
    live && size === "md" ? (
      <BreathingDot size={6} tone="project" projectTone={tone} />
    ) : null;

  if (onClick) {
    return (
      <button
        type="button"
        data-slot="identity-chip"
        data-tone={tone}
        onClick={onClick}
        className={cn(
          classes,
          "cursor-pointer outline-none",
          "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        {label}
        {dot}
      </button>
    );
  }

  return (
    <span data-slot="identity-chip" data-tone={tone} className={classes}>
      {label}
      {dot}
    </span>
  );
}

export { identityChipVariants };
