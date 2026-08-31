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
import { sortMergeColumn } from "@/lib/kanban/merge-readiness";
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
      to_merge: [],
      done: [],
      released: [],
    },
  });
  const [loading, setLoading] = useState(true);
  const onMoveErrorRef = useRef(options?.onMoveError);
  /** Epic-level dependency edges for the project (ticket_dependencies rows). */
  const [dependencies, setDependencies] = useState<TicketDependencyEdge[]>([]);
  /**
   * Latest committed board, readable outside a state updater. `moveEpic` needs
   * the current columns to build its reorder payload; reading them from a
   * `setBoard` updater instead would run that work — and the request it issues
   * — twice under Strict Mode.
   */
  const boardRef = useRef(board);

  /**
   * Ordering guards for board GETs.
   *
   * `loadEpics` runs on a cadence that has nothing to do with the user's
   * drags: the project page bumps its refresh trigger on every SSE event
   * (`ticket:moved`, `session:progress`, …) and on every poll tick of the
   * SSE-down fallback. A GET issued before a drop can therefore still be in
   * flight when the drop lands, and it carries the PRE-move order. Applying
   * it repaints the board with the order the user just changed — the card
   * appears to snap back — even though the reorder was stored, and nothing
   * else was scheduled to correct it.
   *
   * - `requestSeq` numbers each issued request, `appliedSeq` records the
   *   newest one that reached the board: an older response resolving late is
   *   dropped.
   * - `mutationSeq` counts local optimistic writes: a response issued before
   *   the most recent one describes a world the user has already moved past,
   *   so it is dropped too even if it is the newest request in flight.
   *
   * The other half of the fix is in `postReorder`, which refetches once the
   * server confirms the write — that is what lets the board reconcile after a
   * response is discarded here.
   */
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);

  useEffect(() => {
    onMoveErrorRef.current = options?.onMoveError;
    boardRef.current = board;
  });

  const loadEpics = useCallback(async () => {
    const requestSeq = ++requestSeqRef.current;
    const issuedAtMutation = mutationSeqRef.current;
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
      // A failed board request must not be read as "the board is empty": an
      // errored /epics would blank every column, and an errored /dependencies
      // would report every blocked ticket as unblocked and hand one of them the
      // "next" badge. Keeping the last known state is the safer failure — it
      // self-corrects on the next successful reload and never invents
      // readiness.
      // Thrown, not returned: the catch below still lets `setLoading(false)`
      // run, so a first-load failure shows an empty board rather than an
      // eternal skeleton.
      if (!epicsRes.ok) throw new Error("epics request failed");
      const epicsData = await epicsRes.json();
      const releasesData = releasesRes.ok
        ? await releasesRes.json()
        : { data: [] };

      let depEdges: TicketDependencyEdge[] | null = null;
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
        // leave null — the previous edges stand
      }

      // Last await is behind us: from here to `setBoard` nothing can slip in,
      // so this single check decides the whole response. Edges and columns are
      // dropped together — a response that lost the race describes the same
      // stale world for both.
      if (
        requestSeq <= appliedSeqRef.current ||
        mutationSeqRef.current !== issuedAtMutation
      ) {
        setLoading(false);
        return;
      }
      appliedSeqRef.current = requestSeq;

      if (depEdges !== null) setDependencies(depEdges);

      const epics: KanbanEpic[] = epicsData.data || [];
      const releaseRows: ReleaseRow[] = releasesData.data || [];

      const columns: BoardState["columns"] = {
        backlog: [],
        todo: [],
        in_progress: [],
        review: [],
        to_merge: [],
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

      // To Merge is the one column whose order is not purely `position`:
      // merge-ready tickets float to the top (conflicted branches sink) so
      // the column's two sections are contiguous slices of ONE array. Sorting
      // here rather than in the column component keeps a single order in play
      // — drag indices, the optimistic splice in `moveEpic` and the persisted
      // positions all agree with what the user sees, and section membership
      // stays derived (a card dropped into the other section keeps its new
      // position and snaps back).
      columns.to_merge = sortMergeColumn(columns.to_merge);

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

      boardRef.current = { columns, releaseGroups };
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
   * it left alone; any such row means the optimistic board is out of date.
   *
   * Either way the accepted write is followed by a refetch: it re-reads the
   * rows the route refused to move, and — the reason it is unconditional —
   * it is the one board GET whose timing is tied to the write, so it is what
   * reconciles a board left stale by a response `loadEpics` discarded (or by
   * SSE being down between poll ticks).
   */
  const postReorder = useCallback(
    (
      items: ReorderItem[],
      failureMessage: string,
      options?: { reorderOnly?: boolean; onAccepted?: () => void }
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
          // The server committed the write: the optimistic update is
          // confirmed, so post-move side effects may run. A refused
          // transition took the error path above and reloaded instead.
          options?.onAccepted?.();
          loadEpics();
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
      newIndex: number,
      /**
       * Runs only once the server has accepted the move. The optimistic update
       * below is not confirmation — a refused transition calls onMoveError and
       * reloads instead, so anything the user should read as a consequence of
       * the move (e.g. the board's awaiting-reply warning) belongs here rather
       * than at the call site.
       */
      onMoveAccepted?: () => void
    ) => {
      if (fromColumn === "released" || toColumn === "released") return;

      // Built here rather than inside a setBoard updater: React double-invokes
      // updaters under Strict Mode, which would fire the request and the
      // accepted-callback twice in development.
      const prev = boardRef.current;
      const next: BoardState = {
        columns: { ...prev.columns },
        releaseGroups: prev.releaseGroups,
      };
      for (const col of KANBAN_COLUMNS) {
        next.columns[col] = [...prev.columns[col]];
      }

      const epicIndex = next.columns[fromColumn].findIndex(
        (e) => e.id === epicId
      );
      if (epicIndex === -1) return;
      const [epic] = next.columns[fromColumn].splice(epicIndex, 1);
      next.columns[toColumn].splice(newIndex, 0, { ...epic, status: toColumn });

      const touched = new Set<KanbanStatus>([fromColumn, toColumn]);
      const reorderItems: ReorderItem[] = [];
      const nextPositionById = new Map<string, number>();

      for (const col of DRAGGABLE_COLUMNS) {
        if (!touched.has(col)) continue;

        // To Merge is DISPLAYED merge-ready-first, so its display index is
        // not its position; persisting the index would write that derived
        // signal into `epics.position` and reorder cards nobody dragged.
        // Every other column is drawn in position order, where the two
        // coincide. See lib/kanban/reorder.ts.
        const persisted =
          col === "to_merge"
            ? persistedColumnOrder(
                next.columns[col],
                col === toColumn ? epicId : null
              )
            : next.columns[col];

        persisted.forEach((item, idx) => {
          reorderItems.push({ id: item.id, status: col, position: idx });
          nextPositionById.set(item.id, idx);
        });
      }

      // Mirror what is about to be persisted onto the local rows. Without
      // this a second drag before the next refresh would re-sort Review by
      // stale positions and undo the first one.
      for (const col of touched) {
        if (col === "released") continue;
        next.columns[col] = next.columns[col].map((item) => {
          const position = nextPositionById.get(item.id);
          return position === undefined || position === item.position
            ? item
            : { ...item, position };
        });
      }

      // Re-establish To Merge's ready-first order NOW, with the fresh
      // positions. The Board renders this exact array and derives drop
      // indices from it, so leaving it in drop order while the Board re-split
      // the sections for display would make the next drag anchor against a
      // different sequence than the user is looking at.
      if (touched.has("to_merge")) {
        next.columns.to_merge = sortMergeColumn(next.columns.to_merge);
      }

      boardRef.current = next;
      setBoard(next);
      // Every board GET already in flight was issued against the pre-drop
      // order; none of them may land on this board. Bumped before the POST so
      // the refetch that follows the accepted write is not caught by its own
      // guard.
      mutationSeqRef.current += 1;

      postReorder(reorderItems, "Failed to move epic", {
        onAccepted: onMoveAccepted,
      });
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
   * No deferral is needed: the target order is fully determined here, from
   * the rendered board. Reading it back inside a `setTimeout` would let an
   * in-flight `loadEpics()` land in between and make the request body
   * describe the *pre-sort* order — a click that appears to sort and then
   * silently persists the old positions.
   */
  const sortColumnByPriority = useCallback(
    (column: KanbanStatus) => {
      if (column === "released") return;

      const sorted = [...board.columns[column]].sort(
        (a, b) => b.priority - a.priority
      );
      if (sorted.length === 0) return;

      // The positions about to be written, carried on the local rows so the
      // optimistic board and the request describe the same ranking.
      const repositioned = sorted.map((epic, idx) =>
        epic.position === idx ? epic : { ...epic, position: idx }
      );

      // Optimistic half: the reorder route rewrites the same positions.
      // To Merge is DISPLAYED merge-ready-first, so the priority ranking
      // lands in `position` while the column keeps showing its two sections —
      // the sort reorders within each, which is what the user is looking at.
      setBoard((prev) => {
        const next = {
          columns: { ...prev.columns },
          releaseGroups: prev.releaseGroups,
        };
        next.columns[column] =
          column === "to_merge" ? sortMergeColumn(repositioned) : repositioned;
        return next;
      });
      // Same reason as in `moveEpic`: a GET issued before the click carries
      // the pre-sort ranking and must not repaint the column.
      mutationSeqRef.current += 1;

      postReorder(
        repositioned.map((epic) => ({
          id: epic.id,
          status: column,
          position: epic.position,
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

  return {
    board,
    loading,
    moveEpic,
    sortColumnByPriority,
    refresh: loadEpics,
    dependencies,
  };
}
