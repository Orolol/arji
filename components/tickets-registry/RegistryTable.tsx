"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { Mono, QuietLink, StrataBand } from "@/components/piscine";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import type { DeskProject } from "@/lib/control-desk/types";
import { GROUP_PREVIEW, REGISTRY_GROUP_ORDER } from "@/lib/tickets-registry/aggregate";
import type { RegistryGroup, RegistryRow as Row } from "@/lib/tickets-registry/types";
import type { RegistrySort, RegistrySortDirection } from "@/lib/tickets-registry/sort";
import { cn } from "@/lib/utils";

import { GroupHeader } from "./GroupHeader";
import { REGISTRY_GRID, RegistryRow } from "./RegistryRow";

/**
 * The registry's single band: the white card holding the pinned column header,
 * the scrolling body and the pinned footer.
 *
 * WHAT SCROLLS is only the body. The column header row and the footer bar are
 * inside the card and never move, so a 900-row inventory keeps its legend and
 * its totals on screen.
 *
 * AN EMPTY GROUP RENDERS NOTHING — no header, no placeholder. That is the
 * system's "an empty stratum collapses to its label line" applied one level
 * down: the stratum is this card, and its label line is the column header row,
 * which always renders. There is deliberately no empty-state string: the frame
 * has none, and inventing one would be fabricating.
 */

/**
 * The column header row, in order. Source copy is sentence case; CSS
 * uppercases it, so screen readers and the copy files keep the readable form
 * (the `BandHeader` convention) — and this being a module-scope table, it
 * holds catalogue KEY REFERENCES resolved at render (`lib/i18n/catalogue.ts`,
 * pattern 3). The same nine `Registry.columns.*` keys write the CSV header.
 */
const COLUMNS: readonly { labelKey: TranslationKey; sort: RegistrySort }[] = [
  { labelKey: "Registry.columns.ticket", sort: "ticket" },
  { labelKey: "Registry.columns.title", sort: "titre" },
  { labelKey: "Registry.columns.state", sort: "etat" },
  { labelKey: "Registry.columns.stories", sort: "stories" },
  { labelKey: "Registry.columns.priority", sort: "priorite" },
  { labelKey: "Registry.columns.activity", sort: "activite" },
  { labelKey: "Registry.columns.cost", sort: "cout" },
];

/**
 * The truncation line, with its noun when it can be stated truthfully.
 *
 * An explicit key, never a template built from the group: the key-coverage
 * script and the typed `t` both have to see a string literal.
 */
function truncationKey(group: RegistryGroup, hiddenRows: readonly Row[]): TranslationKey {
  if (group === "done") return "Registry.table.moreDone";
  if (group === "released") return "Registry.table.moreReleased";
  // The frame writes "+ 6 autres en backlog", which is true of ITS data.
  // Asserting it unconditionally would be a lie, so it is only said when every
  // hidden row really is a backlog draft.
  if (
    group === "waiting" &&
    hiddenRows.length > 0 &&
    hiddenRows.every((row) => row.status === "backlog")
  ) {
    return "Registry.table.moreBacklog";
  }
  return "Registry.table.more";
}

export interface RegistryTableProps {
  sort: RegistrySort;
  direction: RegistrySortDirection;
  onSortChange: (sort: RegistrySort) => void;
  rowsByGroup: Record<RegistryGroup, Row[]>;
  /** True totals per group — windowed groups report more than they ship. */
  groupTotals: Record<RegistryGroup, number>;
  projectsById: ReadonlyMap<string, DeskProject>;
  collapsedGroups: ReadonlySet<RegistryGroup>;
  expandedGroups: ReadonlySet<RegistryGroup>;
  onToggleGroup: (group: RegistryGroup) => void;
  onShowAll: (group: RegistryGroup, total: number) => void;
  onOpenTicket: (row: Row) => void;
  /** Left slot of the footer. The screen's one status line. */
  footerStatus: string;
  cost30dUsd: number | null;
  exportCount: number;
  onExportCsv: () => void;
  className?: string;
}

export function RegistryTable({
  sort,
  direction,
  onSortChange,
  rowsByGroup,
  groupTotals,
  projectsById,
  collapsedGroups,
  expandedGroups,
  onToggleGroup,
  onShowAll,
  onOpenTicket,
  footerStatus,
  cost30dUsd,
  exportCount,
  onExportCsv,
  className,
}: RegistryTableProps) {
  // Namespace-less: `COLUMNS` and the truncation map hold full dotted keys.
  const t = useTranslations();
  const visibleGroups = REGISTRY_GROUP_ORDER.filter(
    (group) => rowsByGroup[group].length > 0,
  );

  // `p-0` beats the band's own `py-[14px] px-[18px]` through twMerge, and
  // `gap={0}` neutralises the inline flex gap: the header's border-bottom and
  // the zebra stripes have to span the card edge to edge.
  return (
    <StrataBand
      stratum="card"
      gap={0}
      className={cn("min-h-0 flex-1 overflow-hidden p-0", className)}
    >
      {/*
        The legend stands down below `lg`, with the table it labels.

        Seven sort kickers over the stacked row's two tracks would wrap into
        four lines of chrome above every group, and they would be labelling a
        layout that no longer has columns. Sorting itself is NOT lost: the
        filter row's `sort:` pill offers the same seven sorts and the same
        direction toggle at touch size (`components/tickets-registry/RegistryFilters.tsx`).
      */}
      <div
        role="row"
        className={cn(
          REGISTRY_GRID,
          "hidden shrink-0 border-b-[1.5px] border-border px-[18px] py-[9px] lg:grid",
        )}
      >
        {COLUMNS.map(({ labelKey, sort: key }, index) => {
          const Icon = sort !== key ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
          return (
            <div key={key} role="columnheader" aria-sort={sort === key ? direction === "asc" ? "ascending" : "descending" : "none"}
              className={cn("min-w-0", index === COLUMNS.length - 1 && "justify-self-end text-right")}>
              <button type="button" onClick={() => onSortChange(key)}
                title={t("Registry.table.sortHint")}
                className="flex items-center gap-1 cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                <Mono size={9.5} weight={700} tracking={0.08} uppercase tone={sort === key ? "ink" : "muted"}>{t(labelKey)}</Mono>
                <Icon size={11} aria-hidden className="shrink-0 text-muted-foreground" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="tickets-body">
        {visibleGroups.length === 0 ? <div data-testid="tickets-empty" /> : null}

        {visibleGroups.map((group, groupIndex) => {
          const rows = rowsByGroup[group];
          const collapsed = collapsedGroups.has(group);
          const expanded = expandedGroups.has(group);
          const total = Math.max(groupTotals[group], rows.length);
          const shown = collapsed
            ? 0
            : expanded
              ? rows.length
              : Math.min(rows.length, GROUP_PREVIEW[group]);
          const visible = rows.slice(0, shown);
          const hiddenRows = rows.slice(shown);
          const hidden = total - shown;
          const isLastGroup = groupIndex === visibleGroups.length - 1;

          return (
            <div key={group}>
              <GroupHeader
                group={group}
                total={total}
                collapsed={collapsed}
                onToggle={() => onToggleGroup(group)}
                first={groupIndex === 0}
              />

              {visible.map((row, index) => (
                <RegistryRow
                  key={row.epicId}
                  row={row}
                  project={projectsById.get(row.projectId)}
                  // The frame restarts the zebra at every group: the first row
                  // of each one is unstriped.
                  striped={index % 2 === 1}
                  onOpen={() => onOpenTicket(row)}
                />
              ))}

              {!collapsed && hidden > 0 ? (
                <div
                  className={cn(
                    "flex items-center gap-2 px-[18px] pt-[6px]",
                    isLastGroup ? "pb-[12px]" : "pb-[2px]",
                  )}
                >
                  <Mono size={10.5} tone="muted">
                    {t(truncationKey(group, hiddenRows), { count: hidden })}
                  </Mono>
                  <QuietLink
                    tone="next"
                    size={11.5}
                    onClick={() => onShowAll(group, total)}
                    testId="tickets-show-all"
                    className="font-semibold"
                  >
                    {t("Registry.table.showAll")}
                  </QuietLink>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Wraps on a phone: the status line, the 30-day total and Export CSV
          are ~370px of content before padding, and a nowrap row would squeeze
          the export link out of reach rather than moving it down a line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-[14px] gap-y-[4px] border-t-[1.5px] border-border px-[18px] py-[9px] lg:flex-nowrap">
        {/* `Mono` is frozen and takes no arbitrary DOM props, so the test id
            rides on a wrapper rather than forking the primitive. */}
        <span data-testid="tickets-footer-status">
          <Mono size={10.5} tone="muted">
            {footerStatus}
          </Mono>
        </span>
        <Mono size={10.5} tone="muted">
          {`${t("Registry.footer.cost30d")} `}
          <Mono size={10.5} weight={700} tone="ink">
            {cost30dUsd === null ? "—" : `$${cost30dUsd.toFixed(2)}`}
          </Mono>
        </Mono>
        <span
          className="ml-auto"
          title={t("Registry.footer.exportHint", { count: exportCount })}
        >
          <QuietLink
            tone="next"
            size={12}
            onClick={onExportCsv}
            testId="tickets-export-csv"
          >
            <ArrowDown size={12} aria-hidden />
            {t("Registry.footer.exportCsv")}
          </QuietLink>
        </span>
      </div>
    </StrataBand>
  );
}
