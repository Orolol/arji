"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  KANBAN_COLUMNS,
  DRAGGABLE_COLUMNS,
  type KanbanStatus,
  type KanbanEpic,
  type BoardState,
  type ReorderItem,
  type ReleaseGroup,
} from "@/lib/types/kanban";
import { sortReviewColumn } from "@/lib/kanban/merge-readiness";
import { persistedColumnOrder } from "@/lib/kanban/reorder";

interface ReleaseRow {
  id: string;
  version: string;
  title: string | null;
  epicIds: string | null;
  createdAt: string;
}

export interface UseKanbanOptions {
  onMoveError?: (error: string) => void;
}

export function useKanban(projectId: string, options?: UseKanbanOptions) {
  const [board, setBoard] = useState<BoardState>({
    columns: {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      released: [],
    },
  });
  const [loading, setLoading] = useState(true);
  const onMoveErrorRef = useRef(options?.onMoveError);
  onMoveErrorRef.current = options?.onMoveError;

  const loadEpics = useCallback(async () => {
    try {
      const [epicsRes, releasesRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/epics`),
        fetch(`/api/projects/${projectId}/releases`),
      ]);
      const epicsData = await epicsRes.json();
      const releasesData = await releasesRes.json();
      const epics: KanbanEpic[] = epicsData.data || [];
      const releaseRows: ReleaseRow[] = releasesData.data || [];

      const columns: BoardState["columns"] = {
        backlog: [],
        todo: [],
        in_progress: [],
        review: [],
        done: [],
        released: [],
      };

      const releasedEpicMap = new Map<string, KanbanEpic>();

      for (const epic of epics) {
        const status = (epic.status as KanbanStatus) || "backlog";
        if (status === "released") {
          releasedEpicMap.set(epic.id, epic);
          columns.released.push(epic);
        } else if (columns[status]) {
          columns[status].push(epic);
        } else {
          columns.backlog.push(epic);
        }
      }

      for (const col of DRAGGABLE_COLUMNS) {
        columns[col].sort((a, b) => a.position - b.position);
      }

      // Review is the one column whose order is not purely `position`:
      // merge-ready tickets float to the top so the column's two sections are
      // contiguous slices of ONE array. Sorting here rather than in the
      // column component keeps a single order in play — drag indices, the
      // optimistic splice in `moveEpic` and the persisted positions all agree
      // with what the user sees, and section membership stays derived (a card
      // dropped into the other section keeps its new position and snaps back).
      columns.review = sortReviewColumn(columns.review);

      const releaseGroups: ReleaseGroup[] = releaseRows.map((rel) => {
        let epicIds: string[] = [];
        try {
          epicIds = rel.epicIds ? JSON.parse(rel.epicIds) : [];
        } catch {
          // Ignore malformed JSON
        }
        const groupEpics = epicIds
          .map((id) => releasedEpicMap.get(id))
          .filter((e): e is KanbanEpic => !!e);
        return {
          id: rel.id,
          version: rel.version,
          title: rel.title,
          createdAt: rel.createdAt,
          epics: groupEpics,
        };
      });

      setBoard({ columns, releaseGroups });
    } catch {
      // ignore
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    loadEpics();
  }, [loadEpics]);

  const moveEpic = useCallback(
    async (
      epicId: string,
      fromColumn: KanbanStatus,
      toColumn: KanbanStatus,
      newIndex: number
    ) => {
      if (fromColumn === "released" || toColumn === "released") return;

      setBoard((prev) => {
        const next = { columns: { ...prev.columns }, releaseGroups: prev.releaseGroups };
        for (const col of KANBAN_COLUMNS) {
          next.columns[col] = [...prev.columns[col]];
        }

        const epicIndex = next.columns[fromColumn].findIndex(
          (e) => e.id === epicId
        );
        if (epicIndex === -1) return prev;
        const [epic] = next.columns[fromColumn].splice(epicIndex, 1);

        epic.status = toColumn;
        next.columns[toColumn].splice(newIndex, 0, epic);

        return next;
      });

      setTimeout(async () => {
        setBoard((current) => {
          const touched = new Set<KanbanStatus>([fromColumn, toColumn]);
          const reorderItems: ReorderItem[] = [];
          const nextPositionById = new Map<string, number>();

          for (const col of DRAGGABLE_COLUMNS) {
            if (!touched.has(col)) continue;

            // Review is DISPLAYED merge-ready-first, so its display index is
            // not its position; persisting the index would write that derived
            // signal into `epics.position` and reorder cards nobody dragged.
            // Every other column is drawn in position order, where the two
            // coincide. See lib/kanban/reorder.ts.
            const persisted =
              col === "review"
                ? persistedColumnOrder(
                    current.columns[col],
                    col === toColumn ? epicId : null
                  )
                : current.columns[col];

            persisted.forEach((epic, idx) => {
              reorderItems.push({ id: epic.id, status: col, position: idx });
              nextPositionById.set(epic.id, idx);
            });
          }

          fetch(`/api/projects/${projectId}/epics/reorder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: reorderItems }),
          }).then(async (res) => {
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              const errorMsg = data.error || "Failed to move epic";
              onMoveErrorRef.current?.(errorMsg);
              loadEpics();
            }
          }).catch(() => {
            loadEpics();
          });

          // Mirror what was just persisted onto the local rows. Without this a
          // second drag before the next refresh would re-sort Review by stale
          // positions and undo the first one.
          const columns = { ...current.columns };
          for (const col of touched) {
            if (col === "released") continue;
            columns[col] = current.columns[col].map((epic) => {
              const position = nextPositionById.get(epic.id);
              return position === undefined || position === epic.position
                ? epic
                : { ...epic, position };
            });
          }

          // Re-establish Review's ready-first order NOW, with the fresh
          // positions. The board renders this exact array and derives drop
          // indices from it, so leaving it in drop order while the Board
          // re-split the sections for display would make the next drag anchor
          // against a different sequence than the user is looking at.
          if (touched.has("review")) {
            columns.review = sortReviewColumn(columns.review);
          }

          return { columns, releaseGroups: current.releaseGroups };
        });
      }, 0);
    },
    [projectId, loadEpics]
  );

  return { board, loading, moveEpic, refresh: loadEpics };
}
