"use client";

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { BreathingDot, GhostInputPill, Mono, PillButton, SelectPill } from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { fmtCount } from "@/lib/tickets-registry/aggregate";
import type { DeskProject } from "@/lib/control-desk/types";
import { COLUMN_LABEL_KEYS, KANBAN_COLUMNS, type KanbanStatus } from "@/lib/types/kanban";
import { REGISTRY_SORTS, type RegistrySort, type RegistrySortDirection } from "@/lib/tickets-registry/sort";
export type { RegistrySort } from "@/lib/tickets-registry/sort";
// The pills are the UI of a URL parameter now — the vocabulary is the
// query string's, and lives beside its parser.
import type { RegistryStateFilter } from "@/lib/tickets-registry/url-state";
export type { RegistryStateFilter } from "@/lib/tickets-registry/url-state";
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

/**
 * The seven sorts, as the `sort:` pill and its menu write them — lowercase,
 * unlike the table's sentence-case column headers.
 *
 * A module-scope copy table, so it holds catalogue KEY REFERENCES and this
 * row resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
export const SORT_LABEL: Record<RegistrySort, { labelKey: TranslationKey }> = {
  activite: { labelKey: "Registry.sortOptions.activity" },
  priorite: { labelKey: "Registry.sortOptions.priority" },
  cout: { labelKey: "Registry.sortOptions.cost" },
  ticket: { labelKey: "Registry.sortOptions.ticket" },
  titre: { labelKey: "Registry.sortOptions.title" },
  etat: { labelKey: "Registry.sortOptions.state" },
  stories: { labelKey: "Registry.sortOptions.stories" },
};

const SORT_ORDER = REGISTRY_SORTS;

/** A toggled filter is a SELECTION: 2px, the system's selection weight. */
const TOGGLE_ON = "border-2 border-foreground text-foreground";
const TOGGLE_OFF = "text-muted-foreground";

export interface RegistryFiltersProps {
  counts: RegistryCounts;
  projects: DeskProject[];
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
  status: KanbanStatus | "all";
  onStatusChange: (status: KanbanStatus | "all") => void;
  direction: RegistrySortDirection;
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
  projects,
  projectId,
  onProjectChange,
  status,
  onStatusChange,
  direction,
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
  // Namespace-less: `SORT_LABEL` holds full dotted catalogue keys.
  const t = useTranslations();
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
          placeholder={t("Registry.filters.searchPlaceholder")}
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
          aria-label={t("Registry.filters.searchLabel")}
          className="pr-[42px] pl-[30px]"
        />
        <span className="pointer-events-none absolute top-1/2 right-[12px] -translate-y-1/2">
          <Mono size={11} tone="muted">
            ⌘F
          </Mono>
        </span>
      </div>

      <SelectPill
        className="max-w-[240px]"
        label={t("Registry.filters.project", {
          name: projectId
            ? projects.find((p) => p.id === projectId)?.name ?? projectId
            : t("Registry.filters.projectAll"),
        })}
      >
        <DropdownMenuItem onSelect={() => onProjectChange(null)}>
          {t("Registry.filters.projectAll")}
        </DropdownMenuItem>
        {projects.map((project) => (
          <DropdownMenuItem key={project.id} onSelect={() => onProjectChange(project.id)}>{project.name}</DropdownMenuItem>
        ))}
      </SelectPill>
      <SelectPill
        label={t("Registry.filters.status", {
          name: status === "all" ? t("Registry.filters.statusAll") : t(COLUMN_LABEL_KEYS[status]),
        })}
      >
        <DropdownMenuItem onSelect={() => onStatusChange("all")}>
          {t("Registry.filters.statusAll")}
        </DropdownMenuItem>
        {KANBAN_COLUMNS.map((value) => (
          <DropdownMenuItem key={value} onSelect={() => onStatusChange(value)}>{t(COLUMN_LABEL_KEYS[value])}</DropdownMenuItem>
        ))}
      </SelectPill>

      <Divider />

      {statePill("all", t("Registry.filters.stateAll"), counts.all)}
      {statePill("open", t("Registry.filters.stateOpen"), counts.open)}
      {statePill("active", t("Registry.filters.stateActive"), counts.active, { dot: true })}
      {statePill("your_turn", t("Registry.filters.stateYourTurn"), counts.yourTurn, {
        danger: true,
      })}
      {statePill("done", t("Registry.filters.stateDone"), counts.done)}
      {statePill("released", t("Registry.filters.stateReleased"), counts.released)}

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
        {t("Registry.filters.bug")}
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
        {t("Registry.filters.highPlus")}
      </PillButton>

      <div className="ml-auto flex items-center gap-[7px]">
        {actions}
        {/* `SelectPill`'s mono tone forces font-bold; `font-normal` wins through
            twMerge, and Space Mono ships 400 — a mono element never carries a
            synthesised weight. */}
        <SelectPill
          label={t("Registry.filters.sort", {
            label: t(SORT_LABEL[sort].labelKey),
            direction: direction === "asc" ? "↑" : "↓",
          })}
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
              {t(SORT_LABEL[option].labelKey)}
            </DropdownMenuItem>
          ))}
        </SelectPill>
      </div>
    </div>
  );
}
