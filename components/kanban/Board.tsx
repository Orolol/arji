"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
  KANBAN_COLUMNS,
  DRAGGABLE_COLUMNS,
  COLUMN_LABELS,
  type KanbanStatus,
  type KanbanEpic,
  type KanbanEpicAgentActivity,
} from "@/lib/types/kanban";
import { useKanban } from "@/hooks/useKanban";
import { useBoardMerge } from "@/hooks/useBoardMerge";
import { isAwaitingReply } from "@/lib/kanban/awaiting-reply";
import { isMergeReadyEpic } from "@/lib/kanban/merge-readiness";
import type { ColumnSection } from "./Column";
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
   * Epics with a queued OR running session. Broader than `runningEpicIds`,
   * which is the agent chip's set — merging out from under a queued build
   * deletes its worktree before it starts, so the Merge button needs the
   * wider signal (and the approve route refuses the same case with a 409).
   */
  busyEpicIds?: Set<string>;
  /**
   * Hide the Released digest while a side panel owns the right edge: the four
   * working columns and the panel share the width instead (see the board
   * page, which flips this from the chat panel's expanded state).
   */
  hideReleased?: boolean;
  /** Reports how many cards survive the active filters (drives the capture bar). */
  onVisibleCountChange?: (count: number) => void;
  /** A Review card merged straight from the board. */
  onMergeSuccess?: (epicId: string) => void;
  /** Resolve Merge dispatched a conflict-resolution agent instead of landing. */
  onMergeAgentDispatched?: (epicId: string, sessionId: string) => void;
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
  busyEpicIds,
  hideReleased = false,
  onVisibleCountChange,
  onMergeSuccess,
  onMergeAgentDispatched,
}: BoardProps) {
  const { board, loading, moveEpic, refresh } = useKanban(projectId, { onMoveError });

  // Merging from a card reuses the ticket detail's approve route, so the
  // board gains no rules of its own — see hooks/useBoardMerge.ts.
  //
  // Both handlers are memoised so the hook's own `useCallback`s stay stable;
  // an inline arrow here would change `merge`/`resolveMerge` on every render
  // and turn the `epicViews` memo below into a no-op.
  //
  // When the parent page supplies `onMergeSuccess` / `onMergeAgentDispatched`,
  // the page bumps `refreshTrigger`, which drives `refresh()` via the
  // `useEffect([refreshTrigger, refresh])` below. Calling `refresh()` here too
  // would double-fetch `/epics` and `/releases` on every merge. The fallback
  // `refresh()` only fires when no parent callback was passed.
  const handleMerged = useCallback(
    (epicId: string) => {
      if (onMergeSuccess) {
        onMergeSuccess(epicId);
      } else {
        refresh();
      }
    },
    [refresh, onMergeSuccess]
  );
  const handleResolveDispatched = useCallback(
    (epicId: string, sessionId: string) => {
      if (onMergeAgentDispatched) {
        onMergeAgentDispatched(epicId, sessionId);
      } else {
        refresh();
      }
    },
    [refresh, onMergeAgentDispatched]
  );
  const {
    stateByEpic: mergeStateByEpic,
    activeEpicId: activeMergeEpicId,
    merge,
    resolveMerge,
    dismissError: dismissMergeError,
  } = useBoardMerge(projectId, {
    onMerged: handleMerged,
    onResolveDispatched: handleResolveDispatched,
  });
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

  // Per-epic view models: the Board owns the assembly so Column and EpicCard
  // stay out of the business of forwarding one prop per card feature.
  const epicViews = useMemo(() => {
    const views: Record<string, EpicCardView> = {};

    for (const status of DRAGGABLE_COLUMNS) {
      for (const epic of board.columns[status]) {
        const failedSession = failedSessions?.[epic.id];
        // Merge affordances belong to the Review column alone: the signal is
        // only meaningful there, and a Merge button on an In Progress card
        // would be an invitation the approve route refuses.
        const inReview = status === "review";
        const isThisPending = activeMergeEpicId === epic.id;
        const isLocked = activeMergeEpicId !== null && !isThisPending;
        const baseMergeState = inReview ? mergeStateByEpic[epic.id] : undefined;
        const mergeState = baseMergeState || isLocked
          ? {
              ...baseMergeState,
              pending: isThisPending,
              locked: isLocked,
            }
          : undefined;
        views[epic.id] = {
          selected:
            selectedEpics?.has(epic.id) || autoIncludedEpics?.has(epic.id),
          autoIncluded: autoIncludedEpics?.has(epic.id),
          isRunning: runningEpicIds?.has(epic.id) || false,
          activity: activeAgentActivities?.[epic.id],
          unreadAi: unreadAiByEpicId[epic.id] || false,
          awaitingReply: isAwaitingReply(epic),
          failedSession,
          mergeReadiness: inReview ? epic.mergeReadiness : undefined,
          mergeState,
          agentBusy: busyEpicIds?.has(epic.id) || false,
          onMerge: inReview ? () => merge(epic.id) : undefined,
          onResolveMerge: inReview ? () => resolveMerge(epic.id) : undefined,
          onDismissMergeError: inReview
            ? () => dismissMergeError(epic.id)
            : undefined,
          onToggleSelect: onToggleSelect
            ? () => onToggleSelect(epic.id)
            : undefined,
          onLinkedAgentHoverChange,
          onRetryBuild:
            onRetryBuild && failedSession
              ? () => onRetryBuild(epic.id)
              : undefined,
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
    busyEpicIds,
    mergeStateByEpic,
    activeMergeEpicId,
    merge,
    resolveMerge,
    dismissMergeError,
    onToggleSelect,
    onLinkedAgentHoverChange,
    onRetryBuild,
  ]);

  // Pure client-side filter layer over the board columns. While any filter is
  // active, drag-and-drop is disabled entirely (see the guards in the drag
  // handlers and the disabled flags threaded to Column/EpicCard): drop indices
  // against a filtered list would not match the underlying board order.
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
   * The Review column's two derived sections, SLICED out of the rendered
   * array rather than rebuilt from it.
   *
   * This is load-bearing. `handleDragEnd` derives the drop index from
   * `board.columns.review`, and `moveEpic` splices into (and
   * `persistedColumnOrder` anchors against) that same array — so the order
   * drawn on screen has to BE that array, not a re-derived permutation of it.
   * `useKanban` keeps the column merge-ready-first on load and after every
   * drag, which makes the two sections a prefix and a suffix.
   *
   * Slicing at the first non-ready card, rather than partitioning, is what
   * enforces the invariant instead of papering over it: if a card ever sits
   * out of order (an optimistic drop whose readiness has not been recomputed
   * yet), it is grouped under "In review" for one refresh — the render order
   * still matches the array exactly, so no drag can be persisted to the wrong
   * rank.
   */
  const reviewSections = useMemo<ColumnSection[]>(() => {
    const visible = visibleColumns.review;
    let boundary = 0;
    while (boundary < visible.length && isMergeReadyEpic(visible[boundary])) {
      boundary += 1;
    }

    return [
      {
        key: "ready",
        label: "Ready to merge",
        epics: visible.slice(0, boundary),
        accent: true,
        emptyHint: "Nothing cleared review yet.",
      },
      { key: "in-review", label: "In review", epics: visible.slice(boundary) },
    ];
  }, [visibleColumns]);

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
    // No drag while filtering: the visible order diverges from board order.
    if (filtersActive) return;
    const found = findEpicById(event.active.id as string);
    if (!found) return;
    // Block dragging from the released column
    if (found.column === "released") return;
    setActiveEpic(found.epic);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveEpic(null);

    // Dropping into a filtered view must be impossible, not just visually odd.
    if (filtersActive) return;

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
      targetIndex = board.columns[targetColumn].findIndex((e) => e.id === overId);
    }

    if (activeResult.column === targetColumn) {
      // Same column reorder
      const currentIndex = board.columns[targetColumn].findIndex(
        (e) => e.id === activeId
      );
      if (currentIndex === targetIndex) return;
    }

    moveEpic(activeId, activeResult.column, targetColumn, targetIndex);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
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
                sections={status === "review" ? reviewSections : undefined}
                onEpicClick={handleEpicClick}
                epicViews={epicViews}
                dragDisabled={filtersActive}
                filtersActive={filtersActive}
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
