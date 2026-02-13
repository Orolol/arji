"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  type KanbanEpic,
} from "@/lib/types/kanban";
import { Square, CheckSquare, Loader2 } from "lucide-react";

interface EpicCardProps {
  epic: KanbanEpic;
  isOverlay?: boolean;
  isRunning?: boolean;
  onClick?: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}

export function EpicCard({
  epic,
  isOverlay,
  isRunning = false,
  onClick,
  selected,
  onToggleSelect,
}: EpicCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: epic.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    rotate: isOverlay ? "2deg" : undefined,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`p-2 gap-0 rounded-md shadow-none cursor-pointer hover:bg-accent/50 transition-colors ${
        isOverlay ? "shadow-lg" : ""
      } ${isDragging ? "shadow-md" : ""} ${
        selected ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          {onToggleSelect && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect();
              }}
              className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
            >
              {selected ? (
                <CheckSquare className="h-4 w-4 text-primary" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
          )}
          <h4 className="text-sm font-medium leading-tight truncate">{epic.title}</h4>
        </div>
        <Badge
          className={`text-xs shrink-0 ${PRIORITY_COLORS[epic.priority] || PRIORITY_COLORS[0]}`}
        >
          {PRIORITY_LABELS[epic.priority] || "Low"}
        </Badge>
      </div>
      <div className="flex items-center gap-3 mt-1">
        <span className="text-xs text-muted-foreground">
          {epic.usDone}/{epic.usCount} US
        </span>
        {isRunning && (
          <span
            className="inline-flex items-center gap-1 text-xs text-yellow-600"
            data-testid={`epic-running-${epic.id}`}
            aria-label="Epic has active agent work"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Running
          </span>
        )}
      </div>
    </Card>
  );
}
