"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { RefinementButton } from "@/components/kanban/RefinementButton";
import { Mono, SelectPill } from "@/components/piscine";
import { useTicketOverlay } from "@/components/ticket/TicketOverlayProvider";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { DeskProject } from "@/lib/control-desk/types";
import { defaultSortDirection, sortRegistryRows, type RegistrySortDirection } from "@/lib/tickets-registry/sort";
import type { KanbanStatus } from "@/lib/types/kanban";
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

export interface TicketsRegistryViewProps {
  projectId?: string;
}

export function TicketsRegistryView({ projectId }: TicketsRegistryViewProps) {
  // A route scope change takes precedence over the screen's local selection.
  const [projectSelection, setProjectSelection] = useState<{
    scope?: string;
    value: string | null;
  }>({ scope: projectId, value: projectId ?? null });
  if (projectSelection.scope !== projectId) {
    setProjectSelection({ scope: projectId, value: projectId ?? null });
  }
  const selectedProjectId = projectSelection.scope === projectId
    ? projectSelection.value
    : projectId ?? null;
  const [status, setStatus] = useState<KanbanStatus | "all">("all");
  const [direction, setDirection] = useState<RegistrySortDirection>("desc");
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

  const { data, error, setWindow, refresh } = useTicketsRegistry(selectedProjectId, query, sort, direction, status);
  const { openTicket } = useTicketOverlay();

  /**
   * In an UNscoped registry, which project's board the refinement pass
   * targets. The pass is per-project (`/api/projects/:id/refinement`), and
   * this screen shows tickets from every project at once, so the target is
   * picked explicitly from the projects the registry already lists — never
   * inferred. When a project filter is selected, it supplies the target and this
   * separate refinement selection is unused.
   */
  const [refinementProjectId, setRefinementProjectId] = useState<string | null>(null);
  /**
   * The transient outcome line of a dispatch attempt. This screen has no
   * toast rail, so the filter row is that surface: the text says what
   * happened, the tone says whether to worry, and it clears itself.
   */
  const [refinementNotice, setRefinementNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!refinementNotice) return;
    const timer = setTimeout(() => setRefinementNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [refinementNotice]);

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
        (!selectedProjectId || row.projectId === selectedProjectId) &&
        (status === "all" || row.status === status) &&
        (!bug || row.type === "bug") &&
        (!highPlus || (row.priority ?? -1) >= 2) &&
        matchesQuery(row, needle),
    );
  }, [data, state, bug, highPlus, needle, selectedProjectId, status]);

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
      grouped[group] = sortRegistryRows(grouped[group], sort, direction);
    }
    return grouped;
  }, [filteredRows, sort, direction]);

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
    downloadCsv(REGISTRY_GROUP_ORDER.flatMap((group) => rowsByGroup[group]));
  }, [rowsByGroup]);

  /**
   * The refinement entry point, rendered into the filter row's right cluster.
   *
   * Project-filtered registry: the selected project is the pass's target,
   * exactly like the board's toolbar button — no picker, nothing to choose.
   * Unscoped: the pass still targets ONE project's board, and the projects
   * the registry already lists are the picker's only options. The picker is
   * disabled until the first response (there is nothing to name yet) and for
   * an empty app (there is nothing to refine).
   */
  const projects = data?.projects ?? [];
  const selectedProject = refinementProjectId
    ? projects.find((p) => p.id === refinementProjectId)
    : undefined;
  const refinementTarget = selectedProjectId ?? refinementProjectId;

  const handleRefinementStarted = useCallback(() => {
    setRefinementNotice({
      tone: "success",
      text: "Agent Refinement started — re-passing Backlog and To do",
    });
  }, []);

  const handleRefinementFinished = useCallback(() => {
    setRefinementNotice({
      tone: "success",
      text: "Board refinement finished — see the notification for the summary",
    });
    // The pass reshaped the planning columns: pull the new order and the
    // moved tickets in now rather than waiting for the next poll.
    void refresh();
  }, [refresh]);

  const handleRefinementError = useCallback((message: string) => {
    setRefinementNotice({ tone: "error", text: message });
  }, []);

  const handleRefinementNotice = useCallback((message: string) => {
    setRefinementNotice({ tone: "success", text: message });
  }, []);

  // `key={target}` forces a fresh instance per project: the button's
  // running-edge ref must not remember a pass that belonged to the previous
  // target, or switching targets would announce a finish that never happened.
  const refinementButton = (target: string) => (
    <RefinementButton
      key={target}
      projectId={target}
      onError={handleRefinementError}
      onNotice={handleRefinementNotice}
      onStarted={handleRefinementStarted}
      onFinished={handleRefinementFinished}
    />
  );

  const refinementActions = (
    <div data-testid="refine-actions" className="flex items-center gap-[7px]">
      {refinementNotice ? (
        <span data-testid="refinement-notice">
          <Mono size={11} tone={refinementNotice.tone === "error" ? "danger" : "muted"}>
            {refinementNotice.text}
          </Mono>
        </span>
      ) : null}
      {selectedProjectId ? (
        refinementButton(selectedProjectId)
      ) : (
        <>
          <SelectPill
            label={selectedProject ? `refine: ${selectedProject.shortName}` : "refine: —"}
            tone="mono"
            fill="transparent"
            disabled={projects.length === 0}
            className="h-[26px] px-0 font-normal text-muted-foreground"
          >
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => setRefinementProjectId(project.id)}
                data-testid={`refine-project-${project.id}`}
              >
                {project.name}
              </DropdownMenuItem>
            ))}
          </SelectPill>
          {refinementTarget ? refinementButton(refinementTarget) : null}
        </>
      )}
    </div>
  );

  const onSortChange = (next: RegistrySort) => {
    setDirection(next === sort ? direction === "asc" ? "desc" : "asc" : defaultSortDirection(next));
    setSort(next);
  };
  const ticketCount = filtersActive || filteredRows.length === 0 ? filteredRows.length : state === "all"
    ? (data?.totals.tickets ?? 0)
    : STATE_GROUPS[state].reduce((total, group) => total + (data?.groupTotals[group] ?? 0), 0);
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
        projects={data?.projects ?? []}
        projectId={selectedProjectId}
        onProjectChange={(value) => setProjectSelection({ scope: projectId, value })}
        status={status}
        onStatusChange={(value) => { setStatus(value); setState("all"); }}
        direction={direction}
        state={state}
        onStateChange={(value) => { setState(value); setStatus("all"); }}
        bug={bug}
        onBugChange={setBug}
        highPlus={highPlus}
        onHighPlusChange={setHighPlus}
        query={query}
        onQueryChange={setQuery}
        focusKey={focusKey}
        sort={sort}
        onSortChange={onSortChange}
        actions={refinementActions}
      />

      <div className="flex min-h-0 flex-1 flex-col px-[14px] pb-[14px]">
        <RegistryTable
          sort={sort}
          direction={direction}
          onSortChange={onSortChange}
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
