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

  /**
   * The board's single bulk position write, shared by drag-and-drop and
   * "Sort by priority". Both send the same `{ items }` shape to the reorder
   * route; on failure the optimistic board is rolled back by re-reading the
   * server's order.
   *
   * `reorderOnly` says "never move anything" — see the route. Drag-and-drop
   * does not set it, because moving a card between columns is the whole
   * point there. A sort does, and the route then reports how many stale rows
   * it left alone; any such row means the optimistic board is out of date,
   * so re-read it.
   */
  const postReorder = useCallback(
    (
      items: ReorderItem[],
      failureMessage: string,
      options?: { reorderOnly?: boolean }
    ) => {
      fetch(`/api/projects/${projectId}/epics/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          options?.reorderOnly ? { items, reorderOnly: true } : { items }
        ),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            onMoveErrorRef.current?.(data.error || failureMessage);
            loadEpics();
            return;
          }
          if ((data?.data?.skipped ?? 0) > 0) loadEpics();
        })
        .catch(() => {
          loadEpics();
        });
    },
    [projectId, loadEpics]
  );

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

          postReorder(reorderItems, "Failed to move epic");

          return current;
        });
      }, 0);
    },
    [postReorder]
  );

  /**
   * "Sort by priority": rewrite the column's positions so the board's
   * display order (position ASC) becomes priority DESC. Ties keep their
   * current display order (`Array.prototype.sort` is stable), so the button
   * is deterministic. Same bulk write as drag-and-drop — no status change, no
   * transitions — and Full Auto then executes the column in exactly the order
   * the board shows, which is the point of position being the source of truth.
   *
   * Unlike `moveEpic` this needs no deferral: the target order is fully
   * determined here, from the rendered board. Reading it back inside a
   * `setTimeout` would let an in-flight `loadEpics()` land in between and
   * make the request body describe the *pre-sort* order — a click that
   * appears to sort and then silently persists the old positions.
   */
  const sortColumnByPriority = useCallback(
    (column: KanbanStatus) => {
      if (column === "released") return;

      const sorted = [...board.columns[column]].sort(
        (a, b) => b.priority - a.priority
      );
      if (sorted.length === 0) return;

      // Optimistic half: the reorder route rewrites the same positions.
      setBoard((prev) => {
        const next = {
          columns: { ...prev.columns },
          releaseGroups: prev.releaseGroups,
        };
        next.columns[column] = sorted;
        return next;
      });

      postReorder(
        sorted.map((epic, idx) => ({
          id: epic.id,
          status: column,
          position: idx,
        })),
        "Failed to sort column",
        // Sorting is never a move. Without this, a card the server has since
        // promoted (Full Auto picking it up, another tab, an arji.json
        // import) would be read as a requested transition — failing the whole
        // sort, or worse, demoting the ticket out of the queue.
        { reorderOnly: true }
      );
    },
    [board, postReorder]
  );

  return { board, loading, moveEpic, sortColumnByPriority, refresh: loadEpics };
}
