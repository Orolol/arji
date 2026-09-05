/**
 * SelectPill — every dropdown trigger in the Piscine system.
 *
 * Instances: 5a composer project + named-agent pills, 6a AGENTS agent pill,
 * 7a CLI field and assignment tiles, 8c version pill.
 *
 * CARET DECISION (architect): the frames render a literal "▾" (U+25BE) as text.
 * We ship a lucide `chevron-down` at 12px in `--muted-foreground` instead — the
 * README's icon list includes chevron-down and the system's glyph language is
 * lucide throughout.
 *
 * The menu is `components/ui/dropdown-menu` (radix): portal, focus trap and
 * keyboard nav for free. `children` are the menu's contents — pass
 * `DropdownMenuItem` / `DropdownMenuRadioGroup` etc. The content surface is
 * restyled to the Piscine card: radius 12, `--card`, 1.5px `--border`, NO shadow.
 */

import * as React from "react";
import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectTone } from "@/lib/piscine/tokens";
import { cn } from "@/lib/utils";

/** Explicit map — Tailwind cannot see `text-project-${n}-deep`. */
const PROJECT_TEXT: Record<ProjectTone, string> = {
  1: "text-project-1-deep",
  2: "text-project-2-deep",
  3: "text-project-3-deep",
  4: "text-project-4-deep",
};

export interface SelectPillProps {
  /** The current selection, rendered in the trigger. */
  label: string;
  /**
   * `ink` — Instrument Sans 12/600 (agent pills).
   * `mono` — Space Mono 11/700 tabular (version, id-shaped values).
   * `project` — mono in the project's deep identity colour.
   */
  tone?: "ink" | "mono" | "project";
  projectTone?: ProjectTone;
  /**
   * What the pill paints ITSELF: `card` = the white pill, `transparent` = the
   * 7a FieldBox variant. Named `fill` to match `GhostInputPill` — across the
   * Piscine primitives `fill` is always "my own background" and `stratum` is
   * always "the ground I sit on".
   */
  fill?: "card" | "transparent";
  disabled?: boolean;
  className?: string;
  /** Menu contents. */
  children: React.ReactNode;
}

export function SelectPill({
  label,
  tone = "ink",
  projectTone = 1,
  fill = "card",
  disabled = false,
  className,
  children,
}: SelectPillProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="select-pill"
          data-tone={tone}
          disabled={disabled}
          className={cn(
            "flex h-[30px] shrink-0 items-center gap-[7px] rounded-full border-0 px-3",
            "cursor-pointer leading-none shadow-none outline-none",
            "transition-[background-color,opacity] duration-150 motion-reduce:transition-none",
            "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:pointer-events-none disabled:opacity-50",
            fill === "card" ? "bg-card" : "bg-transparent",
            tone === "ink"
              ? "font-sans text-[12px] font-semibold text-foreground"
              : "font-mono text-[11px] font-bold tabular-nums",
            tone === "mono" && "text-foreground",
            tone === "project" && PROJECT_TEXT[projectTone],
            className,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown
            size={12}
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-[12px] border-[1.5px] border-border bg-card shadow-none"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
