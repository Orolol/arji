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
          const reorderItems: ReorderItem[] = [];
          for (const col of DRAGGABLE_COLUMNS) {
            if (col === fromColumn || col === toColumn) {
              current.columns[col].forEach((epic, idx) => {
                reorderItems.push({
                  id: epic.id,
                  status: col,
                  position: idx,
                });
              });
            }
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

          return current;
        });
      }, 0);
    },
    [projectId, loadEpics]
  );

  /**
   * "Sort by priority": rewrite the column's positions so the board's
   * display order (position ASC) becomes priority DESC. Ties keep their
   * current display order (stable sort), so the button is deterministic.
   * Same bulk write as drag-and-drop — no status change, no transitions —
   * and Full Auto then executes the column in exactly the order the board
   * shows, which is the point of position being the source of truth.
   */
  const sortColumnByPriority = useCallback(
    (column: KanbanStatus) => {
      if (column === "released") return;

      // Optimistic half: the reorder route rewrites the same positions.
      setBoard((prev) => {
        const next = {
          columns: { ...prev.columns },
          releaseGroups: prev.releaseGroups,
        };
        next.columns[column] = [...prev.columns[column]].sort(
          (a, b) => b.priority - a.priority
        );
        return next;
      });

      setTimeout(() => {
        setBoard((current) => {
          const reorderItems: ReorderItem[] = current.columns[column].map(
            (epic, idx) => ({
              id: epic.id,
              status: column,
              position: idx,
            })
          );

          fetch(`/api/projects/${projectId}/epics/reorder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: reorderItems }),
          })
            .then(async (res) => {
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                onMoveErrorRef.current?.(data.error || "Failed to sort column");
                loadEpics();
              }
            })
            .catch(() => {
              loadEpics();
            });

          return current;
        });
      }, 0);
    },
    [projectId, loadEpics]
  );

  return { board, loading, moveEpic, sortColumnByPriority, refresh: loadEpics };
}
