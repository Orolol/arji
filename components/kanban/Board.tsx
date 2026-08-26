"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Column } from "./Column";
import { ReleasedColumn } from "./ReleasedColumn";
import { EpicCard, type EpicCardView } from "./EpicCard";
import {
  FilterBar,
  EMPTY_FILTERS,
  countActiveFilters,
  epicMatchesFilters,
  parseStoredFilters,
  type KanbanFilters,
} from "./FilterBar";
import {
  buildDependencyAdjacency,
  buildDependencyFocus,
  computeBlockedBy,
  computeQueueRanks,
  computeReadiness,
  dependencyFocusRole,
  type DependencyFocusRole,
} from "@/lib/kanban/queue";
import {
  KANBAN_COLUMNS,
  DRAGGABLE_COLUMNS,
  COLUMN_LABELS,
  type KanbanStatus,
  type KanbanEpic,
  type KanbanEpicAgentActivity,
} from "@/lib/types/kanban";
import { useKanban } from "@/hooks/useKanban";
import { isAwaitingReply } from "@/lib/kanban/awaiting-reply";
import { hasUnreadAiComment, isAiCommentAuthor } from "@/lib/kanban/unread-ai";
import { BoardSkeleton } from "./BoardSkeleton";
import type { FailedSessionInfo } from "@/lib/agent-sessions/latest-failure";

interface BoardProps {
  projectId: string;
  onEpicClick: (epicId: string) => void;
  selectedEpics?: Set<string>;
  autoIncludedEpics?: Set<string>;
  onToggleSelect?: (epicId: string) => void;
  refreshTrigger?: number;
  runningEpicIds?: Set<string>;
  activeAgentActivities?: Record<string, KanbanEpicAgentActivity>;
  onLinkedAgentHoverChange?: (activityId: string | null) => void;
  onMoveError?: (error: string) => void;
  failedSessions?: Record<string, FailedSessionInfo>;
  onRetryBuild?: (epicId: string) => void;
  /**
   * Hide the Released digest while a side panel owns the right edge: the four
   * working columns and the panel share the width instead (see the board
   * page, which flips this from the chat panel's expanded state).
   */
  hideReleased?: boolean;
  /** Reports how many cards survive the active filters (drives the capture bar). */
  onVisibleCountChange?: (count: number) => void;
  /** Non-blocking warning for risky moves (e.g. awaiting-reply epic to To Do). */
  onMoveWarning?: (message: string) => void;
}

/**
 * Focus-mode placeholder: a terminal column folded into a 34px slice, its
 * label turned on its side. Still readable, no longer competing for space.
 */
function CollapsedColumn({
  label,
  count,
  testId,
}: {
  label: string;
  count: number;
  testId: string;
}) {
  return (
    <div
      className="flex w-[34px] shrink-0 items-center justify-center border-l border-border"
      data-testid={testId}
    >
      <span className="[writing-mode:vertical-rl] text-[11.5px] uppercase tracking-[.09em] text-meta">
        {label} {count}
      </span>
    </div>
  );
}

export function Board({
  projectId,
  onEpicClick,
  selectedEpics,
  autoIncludedEpics,
  onToggleSelect,
  refreshTrigger,
  runningEpicIds,
  activeAgentActivities,
  onLinkedAgentHoverChange,
  onMoveError,
  failedSessions,
  onRetryBuild,
  hideReleased = false,
  onVisibleCountChange,
  onMoveWarning,
}: BoardProps) {
  const { board, loading, moveEpic, refresh, dependencies } = useKanban(
    projectId,
    { onMoveError }
  );
  // Optimistic overlay on the server-side read cursors: opening a ticket
  // clears its unread dot immediately, before the /api/inbox/read POST from
  // EpicDetail lands and the next board refresh returns the moved cursor.
  // Keyed by comment id so a NEWER agent comment re-raises the dot.
  const [locallySeenCommentIdByEpic, setLocallySeenCommentIdByEpic] = useState<
    Record<string, string>
  >({});

  // Client-side filters + focus mode, persisted per project in localStorage
  // (house pattern: the arij.unified-chat-panel.* keys).
  const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);
  const [focusMode, setFocusMode] = useState(false);
  const filtersStorageKey = useMemo(
    () => `arij.kanban-board.filters.${projectId}`,
    [projectId]
  );
  const focusStorageKey = useMemo(
    () => `arij.kanban-board.focus.${projectId}`,
    [projectId]
  );

  // Read persisted filters/focus on mount (before the write effects below run
  // with fresh state, so the stored value is captured first).
  useEffect(() => {
    try {
      setFilters(parseStoredFilters(window.localStorage.getItem(filtersStorageKey)));
      setFocusMode(window.localStorage.getItem(focusStorageKey) === "true");
    } catch {
      setFilters(EMPTY_FILTERS);
      setFocusMode(false);
    }
  }, [filtersStorageKey, focusStorageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(filtersStorageKey, JSON.stringify(filters));
    } catch {
      // ignore storage write failures
    }
  }, [filters, filtersStorageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(focusStorageKey, focusMode ? "true" : "false");
    } catch {
      // ignore storage write failures
    }
  }, [focusMode, focusStorageKey]);

  useEffect(() => {
    if (refreshTrigger) refresh();
  }, [refreshTrigger, refresh]);
  const [activeEpic, setActiveEpic] = useState<KanbanEpic | null>(null);
  /**
   * The column the dragged card was picked up from. Not `activeEpic.status`:
   * `useKanban` buckets an unrecognised status into Backlog without rewriting
   * the field, so the status and the column it renders in can disagree.
   */
  const [activeColumn, setActiveColumn] = useState<KanbanStatus | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const findEpicById = useCallback(
    (id: string): { epic: KanbanEpic; column: KanbanStatus } | null => {
      for (const col of KANBAN_COLUMNS) {
        const epic = board.columns[col].find((e) => e.id === id);
        if (epic) return { epic, column: col };
      }
      return null;
    },
    [board]
  );

  // Server-driven unread signal (latest agent comment vs. the epic's read
  // cursor from ticket_read_cursors), overlaid with the local click state so
  // the dot clears without waiting for a board refresh.
  const unreadAiByEpicId = useMemo(() => {
    const unread: Record<string, boolean> = {};

    for (const status of KANBAN_COLUMNS) {
      for (const epic of board.columns[status]) {
        unread[epic.id] =
          hasUnreadAiComment(epic) &&
          locallySeenCommentIdByEpic[epic.id] !== epic.latestCommentId;
      }
    }

    return unread;
  }, [board, locallySeenCommentIdByEpic]);

  const markEpicAiCommentSeen = useCallback(
    (epicId: string) => {
      const found = findEpicById(epicId);
      if (!found) return;

      const latestCommentId = found.epic.latestCommentId;
      const latestCommentAuthor = found.epic.latestCommentAuthor;
      if (!latestCommentId || !isAiCommentAuthor(latestCommentAuthor)) return;

      // Local overlay only. The durable cursor move (POST /api/inbox/read)
      // is owned by EpicDetail on mount, so any path that opens a ticket —
      // board click, inbox deep link, direct URL — marks it read.
      setLocallySeenCommentIdByEpic((prev) => {
        if (prev[epicId] === latestCommentId) return prev;
        return { ...prev, [epicId]: latestCommentId };
      });
    },
    [findEpicById]
  );

  const handleEpicClick = useCallback(
    (epicId: string) => {
      markEpicAiCommentSeen(epicId);
      onEpicClick(epicId);
    },
    [markEpicAiCommentSeen, onEpicClick]
  );

  // Dependency hover focus: 150 ms of intent on a card lights up its
  // predecessors and successors and dims every other card. A commit timer
  // keeps a card fly-by from flickering the board, and the focus is cleared
  // on leave or the moment a drag starts, so it never competes with a drag.
  const [hoverFocusEpicId, setHoverFocusEpicId] = useState<string | null>(null);
  const hoverFocusTimer = useRef<{
    epicId: string;
    handle: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Read by handleDependencyHoverChange so it can bail during a drag without
  // taking `activeEpic` as a dependency — that would change the callback's
  // identity on every drag boundary and invalidate the whole epicViews map.
  const activeEpicRef = useRef<KanbanEpic | null>(null);

  const clearHoverFocus = useCallback(() => {
    if (hoverFocusTimer.current !== null) {
      clearTimeout(hoverFocusTimer.current.handle);
      hoverFocusTimer.current = null;
    }
    setHoverFocusEpicId(null);
  }, []);

  /**
   * A card reports that it gained (`active`) or lost the pointer/focus. Cards
   * pass their OWN id in both directions, so a leave — including the synthetic
   * one a card fires as it unmounts — can only retract the focus it armed
   * itself. That is what handles a hovered ticket being re-parented by an SSE
   * move (an agent picking it up is exactly what the user was hovering to
   * decide): React fires no mouseleave on unmount, and without the id check an
   * unrelated card leaving would drop somebody else's focus.
   */
  const handleDependencyHoverChange = useCallback(
    (epicId: string, active: boolean) => {
      if (!active) {
        if (hoverFocusTimer.current?.epicId === epicId) {
          clearTimeout(hoverFocusTimer.current.handle);
          hoverFocusTimer.current = null;
        }
        setHoverFocusEpicId((prev) => (prev === epicId ? null : prev));
        return;
      }
      if (hoverFocusTimer.current !== null) {
        clearTimeout(hoverFocusTimer.current.handle);
        hoverFocusTimer.current = null;
      }
      // A drag owns the board's visuals. mouseenter still fires on every card
      // the pointer crosses (the DragOverlay is pointer-events:none), so
      // without this each one would arm a timer that re-renders the Board to
      // draw nothing.
      if (activeEpicRef.current !== null) return;
      hoverFocusTimer.current = {
        epicId,
        handle: setTimeout(() => {
          hoverFocusTimer.current = null;
          setHoverFocusEpicId(epicId);
        }, 150),
      };
    },
    []
  );

  useEffect(
    () => () => {
      if (hoverFocusTimer.current !== null) {
        clearTimeout(hoverFocusTimer.current.handle);
      }
    },
    []
  );

  // Epic-level dependency visibility: which tickets are blocked, the
  // predecessor/successor adjacency for hover highlighting, and the
  // effective To Do queue.
  const epicsById = useMemo(() => {
    const m = new Map<string, KanbanEpic>();
    for (const status of KANBAN_COLUMNS) {
      for (const epic of board.columns[status]) m.set(epic.id, epic);
    }
    return m;
  }, [board]);

  const blockedBy = useMemo(() => {
    const statusById = new Map<string, string>();
    for (const epic of epicsById.values()) {
      statusById.set(epic.id, epic.status);
    }
    return computeBlockedBy(dependencies, statusById);
  }, [dependencies, epicsById]);

  // Effective execution order: position order minus the tickets the board
  // knows Full Auto would skip today (blocked or awaiting the user's reply).
  const queueRanks = useMemo(
    () =>
      computeQueueRanks(board.columns.todo, (epic) => {
        return blockedBy.has(epic.id) || isAwaitingReply(epic);
      }),
    [board, blockedBy]
  );

  const dependencyAdjacency = useMemo(
    () => buildDependencyAdjacency(dependencies),
    [dependencies]
  );

  // Per-epic view models: the Board owns the assembly so Column and EpicCard
  // stay out of the business of forwarding one prop per card feature.
  const epicViews = useMemo(() => {
    const views: Record<string, EpicCardView> = {};

    for (const status of DRAGGABLE_COLUMNS) {
      for (const epic of board.columns[status]) {
        const failedSession = failedSessions?.[epic.id];

        // A dependency target can sit in any column, so its label comes
        // from the full-board index.
        const blockedOn = (blockedBy.get(epic.id) ?? []).map((targetId) => {
          const target = epicsById.get(targetId);
          return target?.readableId || target?.title || targetId;
        });
        views[epic.id] = {
          selected:
            selectedEpics?.has(epic.id) || autoIncludedEpics?.has(epic.id),
          autoIncluded: autoIncludedEpics?.has(epic.id),
          isRunning: runningEpicIds?.has(epic.id) || false,
          activity: activeAgentActivities?.[epic.id],
          unreadAi: unreadAiByEpicId[epic.id] || false,
          awaitingReply: isAwaitingReply(epic),
          failedSession,
          onToggleSelect: onToggleSelect
            ? () => onToggleSelect(epic.id)
            : undefined,
          onLinkedAgentHoverChange,
          onRetryBuild:
            onRetryBuild && failedSession
              ? () => onRetryBuild(epic.id)
              : undefined,
          queueRank:
            epic.status === "todo" ? queueRanks.get(epic.id) : undefined,
          isNextEpic:
            epic.status === "todo"
              ? queueRanks.get(epic.id) === 1
              : undefined,
          blockedOn,
          readiness:
            epic.status === "backlog" ? computeReadiness(epic) : undefined,
          onDependencyHoverChange: handleDependencyHoverChange,
        };
      }
    }

    return views;
  }, [
    board,
    selectedEpics,
    autoIncludedEpics,
    runningEpicIds,
    activeAgentActivities,
    unreadAiByEpicId,
    failedSessions,
    onToggleSelect,
    onLinkedAgentHoverChange,
    onRetryBuild,
    blockedBy,
    epicsById,
    queueRanks,
    handleDependencyHoverChange,
  ]);

  // Pure client-side filter layer over the board columns. Filtering hides
  // cards but never disables the board: cross-column drags stay live and
  // land at the END of the target column, because a drop index read off a
  // filtered list would not match the underlying board order.
  const activeFilterCount = countActiveFilters(filters);
  const filtersActive = activeFilterCount > 0;

  const visibleColumns = useMemo(() => {
    if (!filtersActive) return board.columns;

    const next = { ...board.columns };
    for (const status of DRAGGABLE_COLUMNS) {
      next[status] = board.columns[status].filter((epic) =>
        epicMatchesFilters(epic, filters, {
          isRunning: runningEpicIds?.has(epic.id) || false,
          unreadAi: unreadAiByEpicId[epic.id] || false,
          hasFailedSession: !!failedSessions?.[epic.id],
        })
      );
    }
    return next;
  }, [
    board,
    filters,
    filtersActive,
    runningEpicIds,
    unreadAiByEpicId,
    failedSessions,
  ]);

  /**
   * Epics with a card on screen right now. The dependency focus is judged
   * against this, not the raw board: a neighbour in the Released column (which
   * renders no focus), in a Done column collapsed by focus mode, or hidden
   * behind a filter cannot be highlighted, so a focus naming only those would
   * dim everything and point at nothing.
   */
  const renderedEpicIds = useMemo(() => {
    const ids = new Set<string>();
    for (const status of DRAGGABLE_COLUMNS) {
      if (focusMode && status === "done") continue;
      for (const epic of visibleColumns[status]) ids.add(epic.id);
    }
    return ids;
  }, [visibleColumns, focusMode]);

  const hoverFocus = useMemo(() => {
    if (!hoverFocusEpicId) return null;
    return buildDependencyFocus(
      hoverFocusEpicId,
      dependencyAdjacency,
      renderedEpicIds
    );
  }, [hoverFocusEpicId, dependencyAdjacency, renderedEpicIds]);

  // Focus roles are kept out of `epicViews` on purpose: they change on every
  // pointer move, and folding them into that map would hand every card a new
  // view object — selection, agent activity, unread cursors and all — on each
  // hover. A live drag owns the board's visuals, so focus yields to it.
  const focusRoles = useMemo(() => {
    const roles: Record<string, DependencyFocusRole> = {};
    if (!hoverFocus || activeEpic !== null) return roles;
    for (const epicId of renderedEpicIds) {
      const role = dependencyFocusRole(epicId, hoverFocus);
      if (role && role !== "focused") roles[epicId] = role;
    }
    return roles;
  }, [renderedEpicIds, hoverFocus, activeEpic]);

  // How many cards the board is actually showing right now — the capture bar
  // reports it, so it has to follow the filters, not the raw board.
  const visibleCount = useMemo(
    () =>
      DRAGGABLE_COLUMNS.reduce(
        (total, status) => total + visibleColumns[status].length,
        0
      ),
    [visibleColumns]
  );

  useEffect(() => {
    onVisibleCountChange?.(visibleCount);
  }, [visibleCount, onVisibleCountChange]);

  // The drag overlay is a preview: it deliberately shows only the live agent
  // signals, never selection rings or failed-session affordances.
  const overlayView = useMemo<EpicCardView | undefined>(() => {
    if (!activeEpic) return undefined;

    return {
      isRunning: runningEpicIds?.has(activeEpic.id) || false,
      activity: activeAgentActivities?.[activeEpic.id],
      unreadAi: unreadAiByEpicId[activeEpic.id],
      awaitingReply: isAwaitingReply(activeEpic),
      onLinkedAgentHoverChange,
    };
  }, [
    activeEpic,
    runningEpicIds,
    activeAgentActivities,
    unreadAiByEpicId,
    onLinkedAgentHoverChange,
  ]);

  if (loading) return <BoardSkeleton />;

  function handleDragStart(event: DragStartEvent) {
    const found = findEpicById(event.active.id as string);
    if (!found) return;
    // Block dragging from the released column
    if (found.column === "released") return;
    // A live drag owns the board's visual state: clear any dependency
    // hover focus so its dimming never fights the drag overlay.
    clearHoverFocus();
    activeEpicRef.current = found.epic;
    setActiveEpic(found.epic);
    setActiveColumn(found.column);
  }

  /**
   * Release the drag state. dnd-kit dispatches onDragCancel INSTEAD of
   * onDragEnd, so this has to be reachable from both: Escape, a window resize
   * and a tab switch all cancel a drag, and leaving `activeEpicRef` set would
   * make every later hover bail out at the top of
   * `handleDependencyHoverChange` — killing the dependency focus for the rest
   * of the page session with no signal to the user.
   */
  function endDrag() {
    activeEpicRef.current = null;
    setActiveEpic(null);
    setActiveColumn(null);
    clearHoverFocus();
  }

  function handleDragEnd(event: DragEndEvent) {
    endDrag();

    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeResult = findEpicById(activeId);
    if (!activeResult) return;
    // Block drops from/to released column
    if (activeResult.column === "released") return;

    // Determine target column
    let targetColumn: KanbanStatus;
    let targetIndex: number;

    // Check if dropping on a column directly
    if (KANBAN_COLUMNS.includes(overId as KanbanStatus)) {
      targetColumn = overId as KanbanStatus;
      if (targetColumn === "released") return;
      targetIndex = board.columns[targetColumn].length;
    } else {
      // Dropping on another epic
      const overResult = findEpicById(overId);
      if (!overResult) return;
      if (overResult.column === "released") return;
      targetColumn = overResult.column;
      // Under a filter the visible order diverges from board order, so the
      // card lands at the end of the target column — never at an index the
      // filtered view would have implied.
      targetIndex = filtersActive
        ? board.columns[targetColumn].length
        : board.columns[targetColumn].findIndex((e) => e.id === overId);
    }

    if (activeResult.column === targetColumn) {
      // Same-column reorder. Under a filter this stays a no-op: the visible
      // index does not match board order, and "append to end" would silently
      // reorder cards the user cannot see.
      if (filtersActive) return;
      const currentIndex = board.columns[targetColumn].findIndex(
        (e) => e.id === activeId
      );
      if (currentIndex === targetIndex) return;
    }

    // Non-blocking warning: a Backlog epic that still has open agent
    // questions may always be dragged to To Do, it just stays skipped by auto
    // dispatch until answered. It fires from moveEpic's accepted path, never
    // optimistically — a refused transition would otherwise warn about a
    // placement that never happened, right before the error toast about it.
    const warnAwaitingReply =
      activeResult.column === "backlog" &&
      targetColumn === "todo" &&
      isAwaitingReply(activeResult.epic)
        ? () =>
            onMoveWarning?.(
              `"${activeResult.epic.title}" has open agent questions — it will be skipped by auto dispatch until answered.`
            )
        : undefined;

    moveEpic(
      activeId,
      activeResult.column,
      targetColumn,
      targetIndex,
      warnAwaitingReply
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={endDrag}
    >
      <div className="flex flex-col h-full">
        <FilterBar
          filters={filters}
          onFiltersChange={setFilters}
          focusMode={focusMode}
          onFocusModeChange={setFocusMode}
        />
        <div className="flex flex-1 min-h-0 gap-[16px] overflow-x-auto p-[22px] transition-[width,opacity] duration-200 motion-reduce:transition-none">
          {DRAGGABLE_COLUMNS.map((status) =>
            focusMode && status === "done" ? (
              <CollapsedColumn
                key={status}
                label={COLUMN_LABELS[status]}
                count={visibleColumns[status].length}
                testId="collapsed-column-done"
              />
            ) : (
              <Column
                key={status}
                status={status}
                epics={visibleColumns[status]}
                onEpicClick={handleEpicClick}
                epicViews={epicViews}
                dropAtEnd={filtersActive}
                dropDisabled={filtersActive && activeColumn === status}
                filtersActive={filtersActive}
                focusRoles={focusRoles}
              />
            )
          )}
          {focusMode ? (
            <CollapsedColumn
              label={COLUMN_LABELS.released}
              count={board.columns.released.length}
              testId="collapsed-column-released"
            />
          ) : hideReleased ? null : (
            <ReleasedColumn
              releaseGroups={board.releaseGroups || []}
              onEpicClick={handleEpicClick}
            />
          )}
        </div>
      </div>
      <DragOverlay>
        {activeEpic && (
          <div className="w-[240px]">
            <EpicCard epic={activeEpic} isOverlay view={overlayView} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
