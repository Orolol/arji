"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { EpicCard } from "./EpicCard";
import { COLUMN_LABELS, type KanbanStatus, type KanbanEpic } from "@/lib/types/kanban";

interface ColumnProps {
  status: KanbanStatus;
  epics: KanbanEpic[];
  onEpicClick: (epicId: string) => void;
  selectedEpics?: Set<string>;
  onToggleSelect?: (epicId: string) => void;
  runningEpicIds?: Set<string>;
}

export function Column({
  status,
  epics,
  onEpicClick,
  selectedEpics,
  onToggleSelect,
  runningEpicIds,
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col w-72 shrink-0 rounded-lg bg-muted/30 ${
        isOver ? "ring-2 ring-primary/50" : ""
      }`}
    >
      <div className="px-3 py-2 flex items-center justify-between">
        <h3 className="font-medium text-sm">{COLUMN_LABELS[status]}</h3>
        <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
          {epics.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <SortableContext
          items={epics.map((e) => e.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2 min-h-[50px]">
            {epics.map((epic) => (
              <EpicCard
                key={epic.id}
                epic={epic}
                onClick={() => onEpicClick(epic.id)}
                selected={selectedEpics?.has(epic.id)}
                isRunning={runningEpicIds?.has(epic.id) || false}
                onToggleSelect={
                  onToggleSelect
                    ? () => onToggleSelect(epic.id)
                    : undefined
                }
              />
            ))}
          </div>
        </SortableContext>
      </div>
    </div>
  );
}
