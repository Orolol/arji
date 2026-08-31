"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useTicketOverlay } from "@/components/ticket/TicketOverlayProvider";
import type { DeskProject } from "@/lib/control-desk/types";
import { REGISTRY_GROUP_ORDER } from "@/lib/tickets-registry/aggregate";
import {
  REGISTRY_WINDOW_MAX,
  type RegistryGroup,
  type RegistryRow,
} from "@/lib/tickets-registry/types";

import { RegistryFilters, type RegistryStateFilter, type RegistrySort } from "./RegistryFilters";
import { RegistryTable } from "./RegistryTable";
import { downloadCsv } from "./csv";
import { useTicketsRegistry } from "./useTicketsRegistry";

/**
 * `/tickets` — the exhaustive registry (frame 12a).
 *
 * The only table view in Arij, and the only surface that shows EVERY ticket,
 * `released` ones included. Its whole design tension is that it must show far
 * more rows than the desk in far less vertical space per row, without ever
 * disagreeing with the desk about what state a ticket is in — which is why
 * every group predicate is a call into a helper the desk already calls (see
 * `lib/tickets-registry/aggregate.ts`).
 *
 * READ-ONLY. Every write on this screen happens inside the 6a overlay, which
 * owns it. There is no drag-and-drop and no reorder affordance: `epics.position`
 * is Full Auto's execution-order contract, and a display order written back
 * into it would silently re-order the supervisor's queue.
 */

const EMPTY_ROWS: Record<RegistryGroup, RegistryRow[]> = {
  active: [],
  your_turn: [],
  waiting: [],
  done: [],
  released: [],
};

/** Which groups a state pill reveals. */
const STATE_GROUPS: Record<RegistryStateFilter, readonly RegistryGroup[]> = {
  all: REGISTRY_GROUP_ORDER,
  open: ["active", "your_turn", "waiting"],
  active: ["active"],
  your_turn: ["your_turn"],
  done: ["done"],
  released: ["released"],
};

function matchesQuery(row: RegistryRow, needle: string): boolean {
  if (needle.length === 0) return true;
  return (
    row.title.toLowerCase().includes(needle) ||
    (row.readableId ?? "").toLowerCase().includes(needle)
  );
}

/**
 * Re-order WITHIN a group, never across one.
 *
 * `activité` keeps the server's order, which is the exact one: the open set
 * arrives in `epics.position` (execution order) and the two terminal windows in
 * `updated_at DESC`. The other three sorts are approximate for the WINDOWED
 * groups — a `coût` or `priorité` sort orders only the rows the window shipped
 * — which is precisely why the server window is ordered by recency, so the
 * DEFAULT sort is the one that is always exact.
 */
function sortRows(rows: RegistryRow[], sort: RegistrySort): RegistryRow[] {
  if (sort === "activite") return rows;
  const sorted = [...rows];
  if (sort === "priorite") {
    sorted.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
    return sorted;
  }
  if (sort === "cout") {
    sorted.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));
    return sorted;
  }
  sorted.sort((a, b) =>
    (a.readableId ?? a.epicId).localeCompare(b.readableId ?? b.epicId),
  );
  return sorted;
}

export interface TicketsRegistryViewProps {
  projectId?: string;
}

export function TicketsRegistryView({ projectId }: TicketsRegistryViewProps) {
  const [state, setState] = useState<RegistryStateFilter>("all");
  const [bug, setBug] = useState(false);
  const [highPlus, setHighPlus] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RegistrySort>("activite");
  // `undefined` until the first ⌘F: `GhostInputPill` focuses whenever
  // `autoFocusKey` changes identity and returns early only while it is
  // undefined, so seeding it with a number would steal focus on page load.
  const [focusKey, setFocusKey] = useState<number | undefined>(undefined);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<RegistryGroup>>(
    () => new Set(),
  );
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<RegistryGroup>>(
    () => new Set(),
  );

  const { data, error, setWindow } = useTicketsRegistry(projectId ?? null, query);
  const { openTicket } = useTicketOverlay();

  /**
   * ⌘F / Ctrl-F focuses the filter field. Same shape as the desk's ⌘K handler,
   * mounted only while this view is on screen.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setFocusKey((key) => (key ?? 0) + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const projectsById = useMemo(
    () =>
      new Map<string, DeskProject>((data?.projects ?? []).map((p) => [p.id, p])),
    [data],
  );

  const needle = query.trim().toLowerCase();
  const filtersActive = needle.length > 0 || bug || highPlus;

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const groups = new Set(STATE_GROUPS[state]);
    return rows.filter(
      (row) =>
        groups.has(row.group) &&
        (!bug || row.type === "bug") &&
        (!highPlus || (row.priority ?? -1) >= 2) &&
        matchesQuery(row, needle),
    );
  }, [data, state, bug, highPlus, needle]);

  const rowsByGroup = useMemo(() => {
    const grouped: Record<RegistryGroup, RegistryRow[]> = {
      active: [],
      your_turn: [],
      waiting: [],
      done: [],
      released: [],
    };
    for (const row of filteredRows) grouped[row.group].push(row);
    for (const group of REGISTRY_GROUP_ORDER) {
      grouped[group] = sortRows(grouped[group], sort);
    }
    return grouped;
  }, [filteredRows, sort]);

  /**
   * The header's tally.
   *
   * With no client filter this is the server's TRUE total, remainder included,
   * so a windowed `RELEASED · 20` still says twenty. The moment a filter is on,
   * the server's total describes a different set than the rows on screen, so
   * the honest number is the filtered count.
   */
  const groupTotals = useMemo(() => {
    const totals: Record<RegistryGroup, number> = {
      active: 0,
      your_turn: 0,
      waiting: 0,
      done: 0,
      released: 0,
    };
    for (const group of REGISTRY_GROUP_ORDER) {
      totals[group] = filtersActive
        ? rowsByGroup[group].length
        : (data?.groupTotals[group] ?? rowsByGroup[group].length);
    }
    return totals;
  }, [data, filtersActive, rowsByGroup]);

  const onToggleGroup = useCallback((group: RegistryGroup) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const onShowAll = useCallback(
    (group: RegistryGroup, total: number) => {
      setExpandedGroups((current) => new Set(current).add(group));
      // Raising the window is only meaningful for the two terminal groups; the
      // open working set is already loaded whole.
      setWindow(group, Math.min(total, REGISTRY_WINDOW_MAX));
    },
    [setWindow],
  );

  const onOpenTicket = useCallback(
    (row: RegistryRow) => {
      openTicket(row.epicId, { projectId: row.projectId });
    },
    [openTicket],
  );

  const onExportCsv = useCallback(() => {
    // Every filtered row across every group — group truncation is a display
    // device, not a scope.
    downloadCsv(filteredRows);
  }, [filteredRows]);

  const ticketCount = filtersActive ? filteredRows.length : (data?.totals.tickets ?? 0);
  const projectCount = data?.totals.projects ?? 0;
  const footerStatus =
    error ??
    `${ticketCount} ticket${ticketCount === 1 ? "" : "s"} · ${projectCount} projet${
      projectCount === 1 ? "" : "s"
    }`;

  const counts = data?.counts ?? {
    all: null,
    open: null,
    active: null,
    yourTurn: null,
    done: null,
    released: null,
  };

  return (
    <div
      data-testid="tickets-registry"
      className="flex h-full min-h-0 w-full flex-col bg-background font-sans text-foreground"
    >
      <RegistryFilters
        counts={counts}
        state={state}
        onStateChange={setState}
        bug={bug}
        onBugChange={setBug}
        highPlus={highPlus}
        onHighPlusChange={setHighPlus}
        query={query}
        onQueryChange={setQuery}
        focusKey={focusKey}
        sort={sort}
        onSortChange={setSort}
      />

      <div className="flex min-h-0 flex-1 flex-col px-[14px] pb-[14px]">
        <RegistryTable
          rowsByGroup={data ? rowsByGroup : EMPTY_ROWS}
          groupTotals={groupTotals}
          projectsById={projectsById}
          collapsedGroups={collapsedGroups}
          expandedGroups={expandedGroups}
          onToggleGroup={onToggleGroup}
          onShowAll={onShowAll}
          onOpenTicket={onOpenTicket}
          footerStatus={footerStatus}
          cost30dUsd={data?.totals.cost30dUsd ?? null}
          exportCount={filteredRows.length}
          onExportCsv={onExportCsv}
        />
      </div>
    </div>
  );
}
