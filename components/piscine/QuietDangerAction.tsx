"use client";

/**
 * QuietDangerAction — the chromeless destructive affordance.
 *
 * 6a "Delete ticket", 7a "Delete agent", 8b "jeter".
 *
 * No background, no border, no underline — destructive weight comes from the
 * coral `--destructive` label alone, so a delete never competes with the row's
 * one filled action. The icon inherits the colour.
 *
 * The CONFIRMATION FLOW IS THE CALLER'S RESPONSIBILITY: reuse
 * components/shared/PermanentDeleteDialog.tsx. Do not invent a new one.
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface QuietDangerActionProps {
  /** Usually lucide `trash-2`. Drawn at 12×12 in the label colour. */
  icon?: LucideIcon;
  onClick: () => void;
  size?: 11.5 | 12;
  className?: string;
  children: React.ReactNode;
}

export function QuietDangerAction({
  icon: Icon,
  onClick,
  size = 12,
  className,
  children,
}: QuietDangerActionProps) {
  return (
    <button
      type="button"
      data-slot="quiet-danger-action"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 border-0 bg-transparent p-0",
        "font-sans font-normal leading-none text-destructive",
        "cursor-pointer no-underline shadow-none outline-none",
        "hover:brightness-[0.92] dark:hover:brightness-[1.12]",
        "transition-[filter,opacity] duration-150 motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        size === 12 ? "text-[12px]" : "text-[11.5px]",
        className,
      )}
    >
      {Icon ? <Icon size={12} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
