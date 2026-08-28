"use client";

/**
 * GhostInputPill — the pill-shaped single-line field.
 *
 * Two instances: 5a YOUR TURN inline reply (fixed 300px, `--field` fill) and
 * 6a CONVERSATION reply (flex:1, `--card` fill — the documented exception: it
 * reads as a white card on the coral ground).
 *
 * The border is `--input` (#e4d5ba), deliberately distinct from `--border`.
 * Enter fires `onSubmit`. `autoFocusKey` focuses the field whenever its identity
 * changes — 5a uses it so ⏎ on a focused AttentionRow jumps into the reply.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export interface GhostInputPillProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "onChange" | "onSubmit" | "placeholder" | "disabled" | "width" | "className"
  > {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  /** `field` = --field fill (5a, the default rule). `card` = --card (6a). */
  fill?: "field" | "card";
  /** A number is a fixed px width that never shrinks; "flex" fills the row. */
  width?: number | "flex";
  disabled?: boolean;
  /** Focus the input whenever this value changes identity. */
  autoFocusKey?: unknown;
  className?: string;
}

export function GhostInputPill({
  value,
  onChange,
  onSubmit,
  placeholder,
  fill = "field",
  width,
  disabled = false,
  autoFocusKey,
  className,
  ...props
}: GhostInputPillProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const composingRef = React.useRef(false);

  React.useEffect(() => {
    if (autoFocusKey === undefined) return;
    inputRef.current?.focus();
  }, [autoFocusKey]);

  return (
    <input
      ref={inputRef}
      type="text"
      data-slot="ghost-input-pill"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        // Never swallow Enter while an IME candidate window is open.
        if (composingRef.current || e.nativeEvent.isComposing) return;
        if (!onSubmit) return;
        e.preventDefault();
        onSubmit();
      }}
      style={typeof width === "number" ? { width } : undefined}
      className={cn(
        "flex items-center rounded-full border-[1.5px] border-input",
        "font-sans text-[12.5px] leading-none text-foreground placeholder:text-muted-foreground",
        "shadow-none outline-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        fill === "card" ? "h-[32px] bg-card px-[13px]" : "h-[31px] bg-field px-3",
        typeof width === "number" && "shrink-0",
        width === "flex" && "min-w-0 flex-1",
        className,
      )}
      {...props}
    />
  );
}
