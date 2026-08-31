"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SettingToggle — the on/off pill of frame 11c.
 *
 * The Piscine primitive set is frozen and has no toggle, so this lives here
 * rather than in `components/piscine/`. Anatomy is the frame's, verbatim:
 * 36×20 for the band-header master, 32×18 for a row, knob `--card`, ON
 * `--strata-live-fill`, OFF `--border-strong`.
 *
 * `--strata-live-fill` is the ONE loud accent this screen spends on state; it
 * is the same token the breathing dot uses, which is why "on" reads as alive.
 * The off state is deliberately NOT tinted: `--border-strong` is a neutral,
 * and colour in this system never encodes state on its own — the row's label
 * ink and its mono suffix carry the word.
 */
export interface SettingToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Equal to the visible row label. */
  label: string;
  /** `lg` (36×20) is the band-header master; `md` (32×18) every row. */
  size?: "md" | "lg";
  disabled?: boolean;
  testId?: string;
  className?: string;
}

export function SettingToggle({
  on,
  onChange,
  label,
  size = "md",
  disabled = false,
  testId,
  className,
}: SettingToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-slot="setting-toggle"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative shrink-0 rounded-full border-0 outline-none",
        "transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        size === "lg" ? "h-[20px] w-[36px]" : "h-[18px] w-[32px]",
        on ? "bg-strata-live-fill" : "bg-border-strong",
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-slot="setting-toggle-knob"
        className={cn(
          "absolute rounded-full bg-card",
          "transition-[left,right] duration-150 motion-reduce:transition-none",
          size === "lg"
            ? cn("top-[3px] h-[14px] w-[14px]", on ? "right-[3px]" : "left-[3px]")
            : cn(
                "top-[2.5px] h-[13px] w-[13px]",
                on ? "right-[2.5px]" : "left-[2.5px]",
              ),
        )}
      />
    </button>
  );
}
