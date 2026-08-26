"use client";

import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { EpicCard, type EpicCardView } from "./EpicCard";
import { cn } from "@/lib/utils";
import type { DependencyFocusRole } from "@/lib/kanban/queue";
import {
  COLUMN_LABELS,
  type KanbanStatus,
  type KanbanEpic,
} from "@/lib/types/kanban";

interface ColumnProps {
  status: KanbanStatus;
  epics: KanbanEpic[];
  onEpicClick: (epicId: string) => void;
  /** Per-epic state and callbacks, keyed by epic id and built by the Board */
  epicViews?: Record<string, EpicCardView>;
  /**
   * Filters are hiding cards right now. An empty column then means "nothing
   * matches", not "nothing here" — inviting a capture would be a lie.
   */
  filtersActive?: boolean;
  /**
   * A filter is active, so any drop lands at the END of the target column —
   * the drop indicator moves to the bottom of the column while a card is
   * dragged over it.
   */
  dropAtEnd?: boolean;
  /**
   * This column would refuse the drop currently in flight, so it must not
   * advertise a slot. Today that is the dragged card's own column under an
   * active filter: `handleDragEnd` returns early there because a visible index
   * does not match board order. Promising a slot and then doing nothing reads
   * as a broken drag.
   */
  dropDisabled?: boolean;
  /**
   * Each card's role in the board's active dependency hover focus, keyed by
   * epic id. Separate from `epicViews` on purpose — see EpicCardProps.focus.
   */
  focusRoles?: Record<string, DependencyFocusRole>;
}

/**
 * Per-column flex basis, from the mockup's ~1500px reference widths
 * (Backlog 196 / To Do 226 / In Progress 246 / Review 226). In Progress is
 * deliberately the widest — it carries the agent state lines. `done` is not
 * in the mockup; it follows Review. Grow/shrink stay uniform, so the board
 * still fills any viewport, just from differentiated starting points.
 */
const COLUMN_FLEX: Record<Exclude<KanbanStatus, "released">, string> = {
  backlog: "flex-[1_1_196px]",
  todo: "flex-[1_1_226px]",
  in_progress: "flex-[1_1_246px]",
  review: "flex-[1_1_226px]",
  done: "flex-[1_1_226px]",
};

/** Send the caret to the quick-capture field so "Capture" is one click, not two. */
function focusQuickCapture() {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="quick-capture-input"]'
  );
  input?.focus();
}

/**
 * Column header: an uppercase label with a mono count over a hairline. The
 * in-progress column carries the agent colour — it is the only column whose
 * contents are moving on their own.
 */
function ColumnHeader({
  label,
  count,
  accent = false,
  highlight = false,
}: {
  label: string;
  count: number;
  accent?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between border-b pb-[9px] transition-colors duration-300 motion-reduce:transition-none",
        accent ? "border-agent-border" : "border-border",
        highlight && "border-primary/50"
      )}
    >
      <span
        className={cn(
          "text-[11.5px] uppercase tracking-[.09em]",
          accent ? "text-agent" : "text-muted-foreground",
          highlight && "text-primary"
        )}
      >
        {label}
      </span>
      <span className="font-mono text-[11.5px] text-meta">{count}</span>
    </div>
  );
}

export function Column({
  status,
  epics,
  onEpicClick,
  epicViews,
  dropAtEnd = false,
  dropDisabled = false,
  filtersActive = false,
  focusRoles,
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  // `isOver` says the pointer is here; it does not say the drop is allowed.
  const showDropSlot = isOver && !dropDisabled;

  // Track newly arrived epics for highlight animation
  const prevEpicIdsRef = useRef<Set<string>>(new Set());
  const [highlightedEpicIds, setHighlightedEpicIds] = useState<Set<string>>(new Set());
  const [headerHighlight, setHeaderHighlight] = useState(false);

  useEffect(() => {
    const currentIds = new Set(epics.map((e) => e.id));
    const prevIds = prevEpicIdsRef.current;

    // Find newly arrived epics (in current but not in previous)
    const newIds = new Set<string>();
    for (const id of currentIds) {
      if (!prevIds.has(id)) {
        newIds.add(id);
      }
    }

    if (newIds.size > 0 && prevIds.size > 0) {
      // Only highlight if we had items before (skip initial load)
      setHighlightedEpicIds(newIds);
      setHeaderHighlight(true);

      const timer = setTimeout(() => {
        setHighlightedEpicIds(new Set());
        setHeaderHighlight(false);
      }, 1500);

      prevEpicIdsRef.current = currentIds;
      return () => clearTimeout(timer);
    }

    prevEpicIdsRef.current = currentIds;
  }, [epics]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-w-[196px] max-w-[280px] flex-col gap-[12px]",
        COLUMN_FLEX[status as Exclude<KanbanStatus, "released">] ??
          "flex-[1_1_196px]"
      )}
    >
      <ColumnHeader
        label={COLUMN_LABELS[status]}
        count={epics.length}
        accent={status === "in_progress"}
        highlight={headerHighlight}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SortableContext
          items={epics.map((e) => e.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex min-h-[50px] flex-col gap-[12px]">
            {/* Drop target: the slot the card would land in, not a ring
                around the whole column. Under an active filter the drop
                always lands at the end, so the slot moves to the bottom. */}
            {!dropAtEnd && showDropSlot && (
              <div
                className="h-[64px] shrink-0 rounded-[11px] border border-dashed border-primary bg-primary/5"
                aria-hidden="true"
              />
            )}
            {/* `showDropSlot`, not raw `isOver`: an empty, hovered,
                drop-refusing column would otherwise render neither the
                placeholder nor a slot. Unreachable while `dropDisabled` only
                means "the dragged card's own column", but keeping the
                invariant local stops that from depending on the caller's
                current formula. */}
            {epics.length === 0 && !showDropSlot ? (
              <div
                className="rounded-[10px] border border-dashed border-border p-[15px] text-[13px] text-muted-foreground"
                data-testid={`column-empty-${status}`}
              >
                {filtersActive ? (
                  "Nothing matches the filters."
                ) : (
                  <>
                    Nothing waiting.{" "}
                    <button
                      type="button"
                      onClick={focusQuickCapture}
                      className="text-primary transition-colors hover:underline motion-reduce:transition-none"
                    >
                      Capture
                    </button>
                  </>
                )}
              </div>
            ) : (
              epics.map((epic) => (
                <div
                  key={epic.id}
                  className={
                    highlightedEpicIds.has(epic.id)
                      ? "animate-in fade-in slide-in-from-left-4 zoom-in-95 duration-500 motion-reduce:animate-none"
                      : ""
                  }
                >
                  <EpicCard
                    epic={epic}
                    onClick={() => onEpicClick(epic.id)}
                    highlight={highlightedEpicIds.has(epic.id)}
                    view={epicViews?.[epic.id]}
                    focus={focusRoles?.[epic.id]}
                  />
                </div>
              ))
            )}
            {/* `isOver`, not a board-scoped "a drag is happening" flag: the
                indicator marks the column the pointer is actually over, the
                same as the in-list slot above. */}
            {dropAtEnd && showDropSlot && (
              <div
                className="h-[64px] shrink-0 rounded-[11px] border border-dashed border-primary bg-primary/5"
                aria-hidden="true"
                data-testid={`column-drop-end-${status}`}
              />
            )}
          </div>
        </SortableContext>
      </div>
    </div>
  );
}
