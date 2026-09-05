import * as React from "react";

import { FieldKicker } from "@/components/piscine";
import type { SurfaceStratum } from "@/lib/piscine/tokens";
import { cn } from "@/lib/utils";

/**
 * SettingField — a {@link FieldKicker} over a control, frame 11c's
 * `flex-direction:column; gap:5px` field stack.
 *
 * `htmlFor` turns the kicker into a real `<label>`, which is how
 * "Attempts per stage" and "Review → fix cycles" keep an accessible name (the
 * kicker is uppercased in CSS, so the readable text stays in the DOM).
 */
export interface SettingFieldProps {
  kicker: React.ReactNode;
  /** Ground the kicker is printed on — decides its ink. Defaults to `card`. */
  stratum?: SurfaceStratum;
  /** Bind the kicker to a control as its `<label>`. */
  htmlFor?: string;
  /** Content-proportional width, as the frame draws it. */
  flex?: number;
  /** A fixed px width, as the frame draws it. */
  width?: number;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}

export function SettingField({
  kicker,
  stratum = "card",
  htmlFor,
  flex,
  width,
  testId,
  className,
  children,
}: SettingFieldProps) {
  const label = (
    <FieldKicker stratum={stratum} size={10}>
      {kicker}
    </FieldKicker>
  );

  return (
    <div
      data-slot="setting-field"
      data-testid={testId}
      className={cn("flex min-w-0 flex-col gap-[5px]", className)}
      style={{
        flex: flex !== undefined ? flex : undefined,
        width: width !== undefined ? `${width}px` : undefined,
        flexShrink: width !== undefined ? 0 : undefined,
      }}
    >
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
      {children}
    </div>
  );
}

/**
 * The h34 / r10 field chrome, in the frame's two variants:
 * - `paper` — on a white card: `1.5px --input` hairline over `--field`.
 * - `ground` — on a coloured band: no border, the white `--card` fill IS the
 *   edge. That is the frame's rule, applied per field.
 */
export interface SettingInputProps
  extends Omit<React.ComponentPropsWithoutRef<"input">, "className"> {
  chrome?: "paper" | "ground";
  className?: string;
}

export const SETTING_INPUT_BASE =
  "h-[34px] w-full min-w-0 rounded-[10px] px-[12px] font-mono text-[12px] tabular-nums text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

const CHROME: Record<"paper" | "ground", string> = {
  paper: "border-[1.5px] border-input bg-field",
  ground: "border-0 bg-card",
};

export function SettingInput({
  chrome = "paper",
  className,
  ...props
}: SettingInputProps) {
  return (
    <input
      data-slot="setting-input"
      {...props}
      className={cn(SETTING_INPUT_BASE, CHROME[chrome], className)}
    />
  );
}

/** The same chrome, as a multi-line field (verify commands, global prompt). */
export interface SettingTextareaProps
  extends Omit<React.ComponentPropsWithoutRef<"textarea">, "className"> {
  chrome?: "paper" | "ground";
  className?: string;
}

export function SettingTextarea({
  chrome = "paper",
  className,
  ...props
}: SettingTextareaProps) {
  return (
    <textarea
      data-slot="setting-textarea"
      {...props}
      className={cn(
        "w-full min-w-0 resize-y rounded-[10px] px-[12px] py-[9px]",
        "font-mono text-[11.5px] leading-[1.55] text-foreground outline-none",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "disabled:opacity-50",
        CHROME[chrome],
        className,
      )}
    />
  );
}
