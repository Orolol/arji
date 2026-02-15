"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  type KanbanEpic,
  type KanbanAgentActionType,
  type KanbanEpicAgentActivity,
} from "@/lib/types/kanban";
import {
  GitPullRequest,
  Hammer,
  Search,
  GitMerge,
  Bug,
  Bot,
  type LucideIcon,
} from "lucide-react";

interface EpicCardProps {
  epic: KanbanEpic;
  isOverlay?: boolean;
  isRunning?: boolean;
  activeAgentActivity?: KanbanEpicAgentActivity;
  onLinkedAgentHoverChange?: (activityId: string | null) => void;
  hasUnreadAiUpdate?: boolean;
  onClick?: () => void;
  selected?: boolean;
  autoIncluded?: boolean;
  onToggleSelect?: () => void;
}

const ACTIVITY_ICON_BY_TYPE: Record<
  KanbanAgentActionType,
  { Icon: LucideIcon; label: string }
> = {
  build: { Icon: Hammer, label: "Build" },
  review: { Icon: Search, label: "Review" },
  merge: { Icon: GitMerge, label: "Merge" },
};

export function EpicCard({
  epic,
  isOverlay,
  activeAgentActivity,
  onLinkedAgentHoverChange,
  hasUnreadAiUpdate = false,
  onClick,
  selected,
  autoIncluded,
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

  const activityConfig = activeAgentActivity
    ? ACTIVITY_ICON_BY_TYPE[activeAgentActivity.actionType]
    : null;
  const linkedActivityId = activeAgentActivity?.sessionId ?? null;
  const activityTooltip = activityConfig
    ? `${activityConfig.label} active: ${activeAgentActivity!.agentName}`
    : null;

  function handleCardClick(event: MouseEvent) {
    const additiveSelection = event.metaKey || event.ctrlKey || event.shiftKey;

    if (additiveSelection && onToggleSelect) {
      event.preventDefault();
      onToggleSelect();
      return;
    }

    onClick?.();
  }

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleCardClick}
      onMouseEnter={() => {
        if (!linkedActivityId) return;
        onLinkedAgentHoverChange?.(linkedActivityId);
      }}
      onMouseLeave={() => onLinkedAgentHoverChange?.(null)}
      onFocusCapture={() => {
        if (!linkedActivityId) return;
        onLinkedAgentHoverChange?.(linkedActivityId);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        onLinkedAgentHoverChange?.(null);
      }}
      className={`p-2 gap-0 rounded-md shadow-none cursor-pointer hover:bg-accent/50 transition-colors ${
        isOverlay ? "shadow-lg" : ""
      } ${isDragging ? "shadow-md" : ""} ${
        selected ? "ring-2 ring-primary" : autoIncluded ? "ring-2 ring-blue-400/50" : ""
      } ${epic.type === "bug" ? "border-l-2 border-l-red-500" : ""}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            {activityConfig && (
              <span
                className="shrink-0 mt-0.5 inline-flex items-center justify-center rounded-sm bg-yellow-500/10 text-yellow-600 p-0.5"
                title={activityTooltip ?? undefined}
                aria-label={activityTooltip ?? undefined}
                data-testid={`epic-activity-${epic.id}`}
              >
                <activityConfig.Icon className="h-3.5 w-3.5" />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-xs text-muted-foreground font-mono">{epic.id}</span>
              <h4 className="text-sm font-medium leading-tight truncate">{epic.title}</h4>
            </div>
          </div>
          {epic.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{epic.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {hasUnreadAiUpdate && (
            <span
              className="inline-flex items-center justify-center rounded-sm bg-sky-500/15 text-sky-600 p-0.5"
              aria-label="Unread AI update"
              title="Unread AI update"
              data-testid={`epic-unread-ai-${epic.id}`}
            >
              <Bot className="h-3.5 w-3.5" />
            </span>
          )}
          <Badge
            className={`text-xs shrink-0 ${PRIORITY_COLORS[epic.priority] || PRIORITY_COLORS[0]}`}
          >
            {PRIORITY_LABELS[epic.priority] || "Low"}
          </Badge>
          {epic.type === "bug" && (
            <Badge className="text-xs shrink-0 bg-red-500/10 text-red-400">
              <Bug className="h-3 w-3 mr-0.5" />
              Bug
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-xs text-muted-foreground">
          {epic.usDone}/{epic.usCount} US
        </span>
        {epic.prNumber && epic.prUrl && (
          <a
            href={epic.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <GitPullRequest className="h-3 w-3" />
            <span>#{epic.prNumber}</span>
          </a>
        )}
      </div>
    </Card>
  );
}
