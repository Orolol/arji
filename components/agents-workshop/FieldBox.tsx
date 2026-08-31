"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The 34px bordered value box of the identity card (NAME / CLI / MODEL) and of
 * the numeric / text CLI options.
 *
 * NO FILL. Unlike the 5a reply pill this box does not paint `--field`: the
 * white card shows through and a 1.5px `--border` hairline is the whole
 * chrome. Radius 10, matching the field radius of the house rules.
 */

const BOX =
  "flex h-[34px] items-center rounded-[10px] border-[1.5px] border-border bg-transparent px-3";

export interface FieldBoxProps extends React.ComponentPropsWithoutRef<"div"> {
  /** Space Mono instead of Instrument Sans — model names, ids. */
  mono?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/** The static / trigger-wrapping variant. */
export function FieldBox({ mono, className, children, ...props }: FieldBoxProps) {
  return (
    <div
      data-slot="field-box"
      className={cn(
        BOX,
        mono ? "font-mono text-[12px] tabular-nums" : "font-sans text-[13px]",
        "text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface FieldBoxInputProps
  extends Omit<React.ComponentPropsWithoutRef<"input">, "className"> {
  mono?: boolean;
  className?: string;
}

/** The `<input>` variant — same geometry, no inner element. */
export function FieldBoxInput({
  mono,
  className,
  ...props
}: FieldBoxInputProps) {
  return (
    <input
      data-slot="field-box-input"
      className={cn(
        BOX,
        "w-full min-w-0 outline-none placeholder:text-muted-foreground",
        "focus-visible:border-border-strong",
        "disabled:opacity-50",
        mono
          ? "font-mono text-[12px] font-normal tabular-nums"
          : "font-sans text-[13.5px] font-semibold",
        "text-foreground",
        className,
      )}
      {...props}
    />
  );
}
