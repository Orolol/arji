"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  KANBAN_COLUMNS,
  DRAGGABLE_COLUMNS,
  type KanbanStatus,
  type KanbanEpic,
  type BoardState,
  type ReleaseGroup,
  type TicketDependencyEdge,
  type ReorderItem,
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
  /** Epic-level dependency edges for the project (ticket_dependencies rows). */
  const [dependencies, setDependencies] = useState<TicketDependencyEdge[]>([]);

  const loadEpics = useCallback(async () => {
    try {
      const [epicsRes, releasesRes, depsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/epics`),
        fetch(`/api/projects/${projectId}/releases`),
        // Dependency visibility is an enrichment, not the board itself: this
        // request is made individually fallible so a network failure, an
        // abort or a dev-server restart mid-poll cannot reject the Promise.all
        // and leave the board unrendered.
        fetch(`/api/projects/${projectId}/dependencies`).catch(() => null),
      ]);
      const epicsData = await epicsRes.json();
      const releasesData = await releasesRes.json();
      let depEdges: TicketDependencyEdge[] = [];
      try {
        if (depsRes?.ok) {
          const depsData = await depsRes.json();
          depEdges = (depsData.data ?? []).map(
            (d: { ticketId: string; dependsOnTicketId: string }) => ({
              ticketId: d.ticketId,
              dependsOnTicketId: d.dependsOnTicketId,
            })
          );
        }
      } catch {
        // keep [] — the board renders, just without dependency visibility
      }
      setDependencies(depEdges);
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
      newIndex: number,
      /**
       * Runs only once the server has accepted the move. The optimistic
       * update above is not confirmation — a refused transition calls
       * onMoveError and reloads instead, so anything the user should read as
       * a consequence of the move (e.g. the board's awaiting-reply warning)
       * belongs here rather than at the call site.
       */
      onMoveAccepted?: () => void
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
              return;
            }
            onMoveAccepted?.();
          }).catch(() => {
            loadEpics();
          });

          return current;
        });
      }, 0);
    },
    [projectId, loadEpics]
  );
  return {
    board,
    loading,
    moveEpic,
    refresh: loadEpics,
    dependencies,
  };
}
