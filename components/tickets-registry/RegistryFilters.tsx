"use client";

import type { ReactNode } from "react";
import { Search } from "lucide-react";

import { BreathingDot, GhostInputPill, Mono, PillButton, SelectPill } from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { fmtCount } from "@/lib/tickets-registry/aggregate";
import type { RegistryCounts } from "@/lib/tickets-registry/types";
import { cn } from "@/lib/utils";

/**
 * The registry's SECOND ROW — its per-screen controls.
 *
 * There is no 60px page header on this screen: `components/piscine/TopBar.tsx`
 * is mounted once by `app/layout.tsx` and owns the logo, the project chips, the
 * category bubbles, ⌘K, the inbox, Auto and "New". Everything the frame draws
 * in its own header that is genuinely per-screen — the ⌘F filter field — lives
 * here instead.
 *
 * FILLED CONTROLS ARE `--action`, NEVER BLACK, AT MOST ONE PER ROW. The frame
 * paints the active state pill with an ink fill; that is pre-system canvas
 * styling, and the house rule wins. Exactly one state pill is selected at a
 * time, so this row carries exactly one filled control — which is why the two
 * TYPE toggles are never filled: they are selections, and a selection is 2px
 * border weight, not a third filled button.
 */

export type RegistryStateFilter =
  | "all"
  | "open"
  | "active"
  | "your_turn"
  | "done"
  | "released";

export type RegistrySort = "activite" | "priorite" | "cout" | "ticket";

/** Verbatim and accented, exactly as the frame writes them. */
export const SORT_LABEL: Record<RegistrySort, string> = {
  activite: "activité",
  priorite: "priorité",
  cout: "coût",
  ticket: "ticket",
};

const SORT_ORDER: readonly RegistrySort[] = ["activite", "priorite", "cout", "ticket"];

/** A toggled filter is a SELECTION: 2px, the system's selection weight. */
const TOGGLE_ON = "border-2 border-foreground text-foreground";
const TOGGLE_OFF = "text-muted-foreground";

export interface RegistryFiltersProps {
  counts: RegistryCounts;
  state: RegistryStateFilter;
  onStateChange: (state: RegistryStateFilter) => void;
  bug: boolean;
  onBugChange: (bug: boolean) => void;
  highPlus: boolean;
  onHighPlusChange: (highPlus: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Identity changes focus the field — the ⌘F handler bumps it. `undefined`
   * until the first ⌘F, so the field never grabs focus on page load. */
  focusKey?: number;
  sort: RegistrySort;
  onSortChange: (sort: RegistrySort) => void;
  /**
   * Screen-level actions rendered at the head of the right cluster, before
   * the sort pill. The view's refinement entry point lives here: it is an
   * action on the screen, not a filter on the rows.
   */
  actions?: ReactNode;
  className?: string;
}

function Divider() {
  return <span className="mx-[6px] h-[16px] w-[1.5px] shrink-0 bg-border" aria-hidden />;
}

export function RegistryFilters({
  counts,
  state,
  onStateChange,
  bug,
  onBugChange,
  highPlus,
  onHighPlusChange,
  query,
  onQueryChange,
  focusKey,
  sort,
  onSortChange,
  actions,
  className,
}: RegistryFiltersProps) {
  const statePill = (
    key: RegistryStateFilter,
    label: string,
    count: number | null,
    extra?: { dot?: boolean; danger?: boolean },
  ) => (
    <PillButton
      size="sm"
      variant={state === key ? "filled" : "outline"}
      outlineTone="neutral"
      labelTone={extra?.danger && state !== key ? "danger" : "ink"}
      onClick={() => onStateChange(key)}
      data-testid={`tickets-filter-${key}`}
      data-active={state === key ? "true" : "false"}
    >
      {extra?.dot ? <BreathingDot size={6} tone="live" /> : null}
      {`${label} · ${fmtCount(count)}`}
    </PillButton>
  );

  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-[7px] px-[24px] pb-[12px]",
        className,
      )}
    >
      {/* `GhostInputPill` is a bare <input> and cannot host children, so the
          glyph and the hint are absolutely positioned siblings. */}
      <div className="relative shrink-0">
        <Search
          size={13}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-[11px] -translate-y-1/2 text-muted-foreground"
        />
        <GhostInputPill
          value={query}
          onChange={onQueryChange}
          placeholder="Filter tickets…"
          fill="field"
          width={220}
          autoFocusKey={focusKey}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onQueryChange("");
            event.currentTarget.blur();
          }}
          data-testid="tickets-filter-field"
          aria-label="Filter tickets"
          className="pr-[42px] pl-[30px]"
        />
        <span className="pointer-events-none absolute top-1/2 right-[12px] -translate-y-1/2">
          <Mono size={11} tone="muted">
            ⌘F
          </Mono>
        </span>
      </div>

      <Divider />

      {statePill("all", "All", counts.all)}
      {statePill("open", "Open", counts.open)}
      {statePill("active", "Active", counts.active, { dot: true })}
      {statePill("your_turn", "Your turn", counts.yourTurn, { danger: true })}
      {statePill("done", "Done", counts.done)}
      {statePill("released", "Released", counts.released)}

      <Divider />

      <PillButton
        size="sm"
        variant="outline"
        outlineTone="neutral"
        onClick={() => onBugChange(!bug)}
        data-testid="tickets-filter-bug"
        data-active={bug ? "true" : "false"}
        aria-pressed={bug}
        className={bug ? TOGGLE_ON : TOGGLE_OFF}
      >
        Bug
      </PillButton>
      <PillButton
        size="sm"
        variant="outline"
        outlineTone="neutral"
        onClick={() => onHighPlusChange(!highPlus)}
        data-testid="tickets-filter-high"
        data-active={highPlus ? "true" : "false"}
        aria-pressed={highPlus}
        className={highPlus ? TOGGLE_ON : TOGGLE_OFF}
      >
        High+
      </PillButton>

      <div className="ml-auto flex items-center gap-[7px]">
        {actions}
        {/* `SelectPill`'s mono tone forces font-bold; `font-normal` wins through
            twMerge, and Space Mono ships 400 — a mono element never carries a
            synthesised weight. */}
        <SelectPill
          label={`sort: ${SORT_LABEL[sort]}`}
          tone="mono"
          fill="transparent"
          className="h-[26px] px-0 font-normal text-muted-foreground"
        >
          {SORT_ORDER.map((option) => (
            <DropdownMenuItem
              key={option}
              onSelect={() => onSortChange(option)}
              data-testid={`tickets-sort-${option}`}
            >
              {SORT_LABEL[option]}
            </DropdownMenuItem>
          ))}
        </SelectPill>
      </div>
    </div>
  );
}
