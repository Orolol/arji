"use client";

import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { EpicCard, type EpicCardView } from "./EpicCard";
import { cn } from "@/lib/utils";
import {
  COLUMN_LABELS,
  type KanbanStatus,
  type KanbanEpic,
} from "@/lib/types/kanban";

/**
 * A derived, non-draggable grouping inside one column.
 *
 * Sections do NOT own their cards: `Column.epics` is still the single ordered
 * list (drag indices are computed against it), and every section is a
 * contiguous slice of it. Membership comes from a predicate the board
 * evaluated — dropping a card "into" a section therefore changes its
 * position, never its section.
 */
export interface ColumnSection {
  key: string;
  label: string;
  epics: KanbanEpic[];
  /** Draw the header in the primary colour (the "Ready to merge" slice). */
  accent?: boolean;
  /** Shown in place of the cards while the section is empty. */
  emptyHint?: string;
}

interface ColumnProps {
  status: KanbanStatus;
  epics: KanbanEpic[];
  /**
   * Split the column into labelled slices. Their concatenation must equal
   * `epics`, in the same order — see ColumnSection.
   */
  sections?: ColumnSection[];
  onEpicClick: (epicId: string) => void;
  /** Per-epic state and callbacks, keyed by epic id and built by the Board */
  epicViews?: Record<string, EpicCardView>;
  /** Disable drag-and-drop (set by the Board while filters are active) */
  dragDisabled?: boolean;
  /**
   * Filters are hiding cards right now. An empty column then means "nothing
   * matches", not "nothing here" — inviting a capture would be a lie.
   */
  filtersActive?: boolean;
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

/**
 * Section header inside a column: quieter than the column header (no rule,
 * smaller type) so the column still reads as one unit, with the accent
 * reserved for the slice that can act — "Ready to merge".
 */
function SectionHeader({
  id,
  label,
  count,
  accent = false,
  testId,
}: {
  id?: string;
  label: string;
  count: number;
  accent?: boolean;
  testId: string;
}) {
  return (
    <div className="flex items-baseline justify-between" data-testid={testId}>
      <span
        id={id}
        className={cn(
          "text-[10.5px] uppercase tracking-[.08em]",
          accent ? "text-primary" : "text-meta"
        )}
      >
        {label}
      </span>
      <span className="font-mono text-[10.5px] text-meta">{count}</span>
    </div>
  );
}

export function Column({
  status,
  epics,
  sections,
  onEpicClick,
  epicViews,
  dragDisabled = false,
  filtersActive = false,
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    disabled: dragDisabled,
  });

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

  const renderCard = (epic: KanbanEpic) => (
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
        dragDisabled={dragDisabled}
      />
    </div>
  );

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
                around the whole column. For sectioned columns, dropping onto
                the column body appends to the end, so the placeholder renders
                at the bottom of the last section. */}
            {isOver && !sections && (
              <div
                className="h-[64px] shrink-0 rounded-[11px] border border-dashed border-primary bg-primary/5"
                aria-hidden="true"
              />
            )}
            {epics.length === 0 && !isOver ? (
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
            ) : sections ? (
              // Sections are drawn over the SAME ordered list the
              // SortableContext above indexes, so the split is purely visual.
              sections.map((section, idx) => {
                const headerId = `column-section-heading-${status}-${section.key}`;
                const isLastSection = idx === sections.length - 1;
                return (
                  <div
                    key={section.key}
                    role="group"
                    aria-labelledby={headerId}
                    className="flex flex-col gap-[10px]"
                    data-testid={`column-section-${status}-${section.key}`}
                  >
                    <SectionHeader
                      id={headerId}
                      label={section.label}
                      count={section.epics.length}
                      accent={section.accent}
                      testId={`column-section-header-${status}-${section.key}`}
                    />
                    {section.epics.length === 0 ? (
                      section.emptyHint ? (
                        <p className="text-[12px] text-meta">
                          {section.emptyHint}
                        </p>
                      ) : null
                    ) : (
                      section.epics.map(renderCard)
                    )}
                    {isOver && isLastSection && (
                      <div
                        className="h-[64px] shrink-0 rounded-[11px] border border-dashed border-primary bg-primary/5"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                );
              })
            ) : (
              epics.map(renderCard)
            )}
          </div>
        </SortableContext>
      </div>
    </div>
  );
}
