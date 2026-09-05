"use client";

import { cn } from "@/lib/utils";

/**
 * All / Blocking / Security, in the FINDINGS À ARBITRER header.
 *
 * WHY NOT `SegmentedControl`. Its active segment is `bg-action` deep green.
 * The frame's active filter is a WHITE `#fffef8` pill, and a second filled
 * green in this band's header — while every finding row already carries the one
 * filled green a row is allowed — breaks "two loud colours max, one filled
 * button per row". So this is a small local control, built to the frame's own
 * geometry, and it spends no colour at all.
 */
export type FindingFilter = "all" | "blocking" | "security";

export interface FindingFilterPillsProps {
  value: FindingFilter;
  onChange: (value: FindingFilter) => void;
  className?: string;
}

const OPTIONS: ReadonlyArray<{ id: FindingFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "blocking", label: "Blocking" },
  { id: "security", label: "Security" },
];

export function FindingFilterPills({
  value,
  onChange,
  className,
}: FindingFilterPillsProps) {
  return (
    <div className={cn("flex gap-[6px]", className)}>
      {OPTIONS.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            data-testid={`qa-filter-${option.id}`}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex h-[24px] cursor-pointer items-center rounded-full px-[11px]",
              "border-0 font-sans text-[11.5px] leading-none outline-none",
              "transition-colors duration-150 motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
              active
                ? "bg-card font-semibold text-foreground"
                : "bg-transparent font-medium text-strata-you-mid",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The client-side selection, over the project-scoped payload rows. */
export function applyFindingFilter<
  T extends { blocking: boolean; reviewerAgentType: string | null },
>(rows: readonly T[], filter: FindingFilter): T[] {
  if (filter === "blocking") return rows.filter((row) => row.blocking);
  if (filter === "security") {
    return rows.filter((row) => row.reviewerAgentType === "review_security");
  }
  return [...rows];
}
