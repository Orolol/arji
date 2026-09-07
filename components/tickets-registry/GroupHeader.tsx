"use client";

import { useTranslations } from "next-intl";

import { Mono } from "@/components/piscine";
import { GROUP_LABEL } from "@/lib/tickets-registry/aggregate";
import type { RegistryGroup } from "@/lib/tickets-registry/types";
import { cn } from "@/lib/utils";

/**
 * One group's label line inside the registry table.
 *
 * The whole line is the collapse toggle — a mono kicker plus a hairline that
 * eats the rest of the row. There is NO count badge and no chevron: the count
 * rides in the label (`ACTIVE · 4`), which is how every Piscine band header
 * carries its own tally.
 *
 * `GROUP_LABEL` is a module-scope copy table holding catalogue KEY
 * REFERENCES, so it resolves here with the namespace-less translator.
 *
 * `total` is the TRUE group total, not the loaded row count, so a windowed
 * `RELEASED · 20` says twenty even while the table holds two.
 */

/**
 * Explicit map — Tailwind only emits a utility it can literally see, so
 * `text-strata-${group}-deep` would compile and render transparent
 * (the idiom at `components/desk/UpNextBand.tsx:49-54`).
 *
 * WAITING and RELEASED are deliberately dim: the screen's two loud colours are
 * turquoise (ACTIVE) and coral (YOUR TURN), and DONE's sun-deep is the third
 * only because it is a stratum identity, never a state signal.
 */
const GROUP_TONE: Record<RegistryGroup, string> = {
  active: "text-strata-live-deep",
  your_turn: "text-strata-you-deep",
  waiting: "text-muted-foreground",
  done: "text-strata-land-deep",
  released: "text-muted-foreground",
};

export interface GroupHeaderProps {
  group: RegistryGroup;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
  /** The frame draws the FIRST header in the body 2px tighter. */
  first?: boolean;
  className?: string;
}

export function GroupHeader({
  group,
  total,
  collapsed,
  onToggle,
  first = false,
  className,
}: GroupHeaderProps) {
  const t = useTranslations();
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      data-testid="tickets-group-header"
      data-group={group}
      className={cn(
        "flex w-full items-center gap-[10px] px-[18px] pb-[6px] text-left outline-none",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        first ? "pt-[10px]" : "pt-[12px]",
        className,
      )}
    >
      <Mono
        size={10}
        weight={700}
        tracking={0.1}
        uppercase
        className={GROUP_TONE[group]}
      >
        {`${t(GROUP_LABEL[group].labelKey)} · ${total}`}
      </Mono>
      <span aria-hidden className="h-[1.5px] flex-1 bg-muted" />
    </button>
  );
}
