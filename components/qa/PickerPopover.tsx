"use client";

import { useState, type ReactNode } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The "pick one, then dispatch" popover both QA screens' buttons wear.
 *
 * WHY IT IS SHARED. `RunQaPassButton` and `NewQaCheckButton` had the same
 * popover twice, character for character: the same content class string, the
 * same `max-h-[280px]` scroller, the same row geometry — and, the part that
 * matters, the same hand-copied focus-ring class string, which
 * `__tests__/focus-ring-paints.test.tsx` was enumerating as two separate
 * files. Two copies of a focus ring is two chances to lose one; they diverged
 * before this was written (only one of them had an empty state).
 *
 * WHAT IT DOES NOT OWN: the trigger, and whether there is a popover at all.
 * `NewQaCheckButton` skips it entirely for a single candidate — a one-row menu
 * is a click that asks a question with a single answer — and that decision
 * belongs to the caller, not here.
 */
export interface PickerPopoverProps<T> {
  /** The control that opens the menu. Cloned by Radix via `asChild`. */
  trigger: ReactNode;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The row's contents. The row itself — button, geometry, ring — is ours. */
  children: (item: T) => ReactNode;
  onSelect: (item: T) => void;
  /** Shown instead of the list when there is nothing to pick. */
  emptyLabel: string;
  /** Content width in px. 320 for tickets, 280 for the shorter project rows. */
  width: number;
  testId: string;
  itemTestId: string;
}

export function PickerPopover<T>({
  trigger,
  items,
  keyOf,
  children,
  onSelect,
  emptyLabel,
  width,
  testId,
  itemTestId,
}: PickerPopoverProps<T>) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid={testId}
        style={{ width }}
        className="rounded-[12px] border-[1.5px] border-border bg-card p-2 shadow-none"
      >
        {items.length === 0 ? (
          <span className="block px-2 py-[6px] font-sans text-[12.5px] text-muted-foreground">
            {emptyLabel}
          </span>
        ) : (
          <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto">
            {items.map((item) => (
              <button
                key={keyOf(item)}
                type="button"
                data-testid={itemTestId}
                onClick={() => {
                  setOpen(false);
                  onSelect(item);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-2 py-[6px] text-left",
                  "outline-none hover:bg-muted",
                  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                {children(item)}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
