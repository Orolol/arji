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
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Column } from "./Column";
import { EpicCard } from "./EpicCard";
import {
  KANBAN_COLUMNS,
  type KanbanStatus,
  type KanbanEpic,
  type KanbanEpicAgentActivity,
} from "@/lib/types/kanban";
import { useKanban } from "@/hooks/useKanban";
import { BoardSkeleton } from "./BoardSkeleton";

interface BoardProps {
  projectId: string;
  onEpicClick: (epicId: string) => void;
  selectedEpics?: Set<string>;
  onToggleSelect?: (epicId: string) => void;
  refreshTrigger?: number;
  runningEpicIds?: Set<string>;
  activeAgentActivities?: Record<string, KanbanEpicAgentActivity>;
  onLinkedAgentHoverChange?: (activityId: string | null) => void;
}

function isAiCommentAuthor(author: string | null | undefined) {
  if (!author) return false;
  return author.toLowerCase() !== "user";
}

export function Board({
  projectId,
  onEpicClick,
  selectedEpics,
  onToggleSelect,
  refreshTrigger,
  runningEpicIds,
  activeAgentActivities,
  onLinkedAgentHoverChange,
}: BoardProps) {
  const { board, loading, moveEpic, refresh } = useKanban(projectId);
  const [seenAiCommentIdsByEpic, setSeenAiCommentIdsByEpic] = useState<
    Record<string, string>
  >({});
  const seenStorageKey = useMemo(
    () => `arij:kanban:seen-ai-comments:${projectId}`,
    [projectId]
  );

  useEffect(() => {
    if (refreshTrigger) refresh();
  }, [refreshTrigger, refresh]);
  const [activeEpic, setActiveEpic] = useState<KanbanEpic | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(seenStorageKey);
      if (!raw) {
        setSeenAiCommentIdsByEpic({});
        return;
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        setSeenAiCommentIdsByEpic(parsed as Record<string, string>);
      } else {
        setSeenAiCommentIdsByEpic({});
      }
    } catch {
      setSeenAiCommentIdsByEpic({});
    }
  }, [seenStorageKey]);

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

  const unreadAiByEpicId = useMemo(() => {
    const unread: Record<string, boolean> = {};

    for (const status of KANBAN_COLUMNS) {
      for (const epic of board.columns[status]) {
        const latestCommentId = epic.latestCommentId;
        const latestCommentAuthor = epic.latestCommentAuthor;

        if (!latestCommentId || !isAiCommentAuthor(latestCommentAuthor)) {
          unread[epic.id] = false;
          continue;
        }

        unread[epic.id] = seenAiCommentIdsByEpic[epic.id] !== latestCommentId;
      }
    }

    return unread;
  }, [board, seenAiCommentIdsByEpic]);

  const markEpicAiCommentSeen = useCallback(
    (epicId: string) => {
      const found = findEpicById(epicId);
      if (!found) return;

      const latestCommentId = found.epic.latestCommentId;
      const latestCommentAuthor = found.epic.latestCommentAuthor;
      if (!latestCommentId || !isAiCommentAuthor(latestCommentAuthor)) return;

      setSeenAiCommentIdsByEpic((prev) => {
        if (prev[epicId] === latestCommentId) return prev;
        const next = { ...prev, [epicId]: latestCommentId };
        try {
          sessionStorage.setItem(seenStorageKey, JSON.stringify(next));
        } catch {
          // ignore storage write failures
        }
        return next;
      });
    },
    [findEpicById, seenStorageKey]
  );

  const handleEpicClick = useCallback(
    (epicId: string) => {
      markEpicAiCommentSeen(epicId);
      onEpicClick(epicId);
    },
    [markEpicAiCommentSeen, onEpicClick]
  );

  if (loading) return <BoardSkeleton />;

  function handleDragStart(event: DragStartEvent) {
    const found = findEpicById(event.active.id as string);
    if (found) setActiveEpic(found.epic);
  }

  function handleDragOver(event: DragOverEvent) {
    // Handled in handleDragEnd for simplicity
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveEpic(null);

    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeResult = findEpicById(activeId);
    if (!activeResult) return;

    // Determine target column
    let targetColumn: KanbanStatus;
    let targetIndex: number;

    // Check if dropping on a column directly
    if (KANBAN_COLUMNS.includes(overId as KanbanStatus)) {
      targetColumn = overId as KanbanStatus;
      targetIndex = board.columns[targetColumn].length;
    } else {
      // Dropping on another epic
      const overResult = findEpicById(overId);
      if (!overResult) return;
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
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 h-full p-4 overflow-x-auto">
        {KANBAN_COLUMNS.map((status) => (
          <Column
            key={status}
            status={status}
            epics={board.columns[status]}
            onEpicClick={handleEpicClick}
            selectedEpics={selectedEpics}
            onToggleSelect={onToggleSelect}
            runningEpicIds={runningEpicIds}
            activeAgentActivities={activeAgentActivities}
            onLinkedAgentHoverChange={onLinkedAgentHoverChange}
            unreadAiByEpicId={unreadAiByEpicId}
          />
        ))}
      </div>
      <DragOverlay>
        {activeEpic && (
          <div className="w-[272px]">
            <EpicCard
              epic={activeEpic}
              isOverlay
              isRunning={runningEpicIds?.has(activeEpic.id) || false}
              activeAgentActivity={activeAgentActivities?.[activeEpic.id]}
              onLinkedAgentHoverChange={onLinkedAgentHoverChange}
              hasUnreadAiUpdate={unreadAiByEpicId[activeEpic.id]}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
