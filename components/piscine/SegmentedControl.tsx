"use client";

/**
 * SegmentedControl — the one tab/toggle rail in the Piscine system.
 *
 * Replaces the three competing bespoke tab looks in the codebase today.
 * Instances: 7a RETRY ESCALATION / EFFORT / PERMISSION MODE, 8b Écrire |
 * Prévisualiser, 8d 7 j | 30 j | Tout.
 *
 * Chrome is a prop rather than a fixed look because the frames are deliberate
 * about it: on a white card the track needs a 1.5px `--border` hairline and a
 * transparent fill; on a coloured ground the white `--card` fill IS the edge
 * and there is no border. 8d wants the filled rail AND a hairline because it
 * sits on paper — that caller passes `border-[1.5px] border-border` in
 * `className`.
 *
 * INACTIVE LABEL COLOUR: `--muted-foreground` by default (correct on white).
 * On a coloured ground the frames use the host stratum's deep/mid tone; set
 * `--segment-inactive` on the control or any ancestor to override, e.g.
 * `className="[--segment-inactive:var(--strata-feed-deep)]"` (8b) or
 * `[--segment-inactive:var(--strata-next-mid)]` (7a on pool). Same custom-property
 * idiom as the `--dot-color` / `--track-color` scopes in app/globals.css.
 *
 * No dividers between segments — the filled active segment does the work.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  /** Content-proportional width (7a retry 1/1.4/1.2). Omit for equal segments. */
  flex?: number;
  /** e.g. an effort level the selected CLI does not support. */
  disabled?: boolean;
  /** Native tooltip explaining a disabled segment. */
  hint?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** `bordered` on a white card, `filled` on a coloured ground. */
  chrome?: "bordered" | "filled";
  /** `md` = h34 / r10 (7a fields). `sm` = h30 / pill (8b, 8d). */
  size?: "sm" | "md";
  /**
   * Below `sm`, let the segments keep their label and flow onto a second row
   * instead of being squeezed until the nowrap labels overlap each other —
   * six EFFORT levels need ~380px and a phone card has ~326. From `sm` up the
   * rail is byte-for-byte the one-line control it has always been: the
   * breakpoint restores `basis-0`, `flex-nowrap` and the fixed height.
   */
  wrap?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  chrome = "bordered",
  size = "md",
  wrap = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      data-slot="segmented-control"
      role="group"
      className={cn(
        "flex overflow-hidden font-sans",
        wrap && "flex-wrap sm:flex-nowrap",
        size === "md"
          ? cn("rounded-[10px]", wrap ? "min-h-[34px] sm:h-[34px]" : "h-[34px]")
          : cn("rounded-full", wrap ? "min-h-[30px] sm:h-[30px]" : "h-[30px]"),
        chrome === "bordered"
          ? "border-[1.5px] border-border bg-transparent"
          : "border-0 bg-card",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            data-slot="segmented-control-segment"
            data-active={active || undefined}
            aria-pressed={active}
            disabled={option.disabled}
            title={option.hint}
            onClick={() => {
              if (!option.disabled && !active) onChange(option.value);
            }}
            style={{
              // A wrapping rail sizes each segment from its label (the
              // `basis-auto` below); the shorthand would reset that basis to
              // 0 and squeeze the row back onto one line.
              ...(wrap
                ? { flexGrow: option.flex ?? 1, flexShrink: 1 }
                : { flex: option.flex ?? 1 }),
              // Inactive colour is overridable per host ground; see the file header.
              color: active ? undefined : "var(--segment-inactive, var(--muted-foreground))",
            }}
            className={cn(
              "flex min-w-0 items-center justify-center whitespace-nowrap px-[13px]",
              wrap
                ? "min-h-[30px] basis-auto py-[5px] sm:h-full sm:min-h-0 sm:basis-0 sm:py-0"
                : "h-full",
              "cursor-pointer text-[12px] leading-none outline-none",
              "transition-[background-color,color,opacity] duration-150 motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
              "disabled:pointer-events-none disabled:opacity-45",
              active
                ? "bg-action font-semibold text-action-foreground"
                : "bg-transparent font-normal",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
