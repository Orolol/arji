/**
 * Board execution-queue, blocked-state, and readiness helpers.
 *
 * Pure, deterministic functions backing the board's execution visibility:
 * effective queue ranking of the To Do column, dependency-blocked
 * detection, predecessor/successor adjacency for hover highlighting, and
 * the three-criterion readiness indicator on Backlog cards.
 *
 * ORDER. `compareExecutionOrder` below is the single definition of "the order
 * work is picked up in", shared with the Full Auto supervisor —
 * `compareEpics` in lib/auto-mode/select.ts IS this function. That is what
 * lets the desk's UP NEXT column claim to be "l'ordre où Full Auto va
 * piocher" instead of merely resembling it. Dependency blocking is shared
 * too: `selectBuildCandidates` runs the transitive prerequisite gate from
 * lib/dependencies/validation.ts, and this module's `computeBlockedBy` is its
 * direct-edge equivalent for display.
 *
 * What a UI built on this module still cannot see are the supervisor's
 * IN-PROCESS exclusions: `parkedTicketIds` (soft-parked after three
 * consecutive failures), pipeline / night-run ownership and merge backoff all
 * live in `lib/auto-mode/registry.ts`, are lost on restart and no API exposes
 * them. A parked epic therefore still carries a rank here. That is the one
 * remaining divergence, and this module has no way to close it.
 */

import { isAwaitingReply } from "./awaiting-reply";
import {
  isDeliveredStatus,
  type KanbanEpic,
  type TicketDependencyEdge,
} from "@/lib/types/kanban";

/**
 * Execution-order rank of a column.
 *
 * In Progress ranks before To Do: a ticket sitting there came back from a
 * negative review, and finishing work already started beats opening a new
 * front. Everything else sorts last, among itself.
 *
 * `position` is written PER COLUMN — creation uses `MAX(position) + 1` scoped
 * to the target status, and the reorder route rewrites each column as 0..n-1 —
 * so every column has its own position 0 and position alone is not a total
 * order over a set spanning two columns. The column is the primary key,
 * position the secondary one.
 */
const EXECUTION_COLUMN_RANK: Readonly<Record<string, number>> = {
  in_progress: 0,
  todo: 1,
};

/** Columns the build selector does not span sort last, among themselves. */
const UNRANKED_COLUMN = 2;

/** The minimum an epic must carry to be placed in execution order. */
export interface ExecutionOrderEpic {
  id: string;
  status?: string | null;
  position?: number | null;
}

/**
 * The order work is picked up in: column rank, then position ASC, then id.
 *
 * Within a column, position ASC is the column's visual reading order —
 * position is the single source of truth for execution order, so what the user
 * sees is what the supervisor runs (WYSIWYG). Priority stays a badge and a
 * filter, never a scheduling criterion; the "Sort by priority" action makes it
 * visible in the order by rewriting positions in bulk.
 *
 * The `id` tiebreak only fires on a malformed board (two rows sharing a
 * position after a partial write). It is arbitrary but deterministic, which
 * beats "whatever SQLite returned first".
 *
 * Lives here, in the client-safe predicate layer, so the supervisor
 * (lib/auto-mode/select.ts) and every UI that claims to show its queue read
 * ONE definition. A second copy is a divergence waiting to happen.
 */
export function compareExecutionOrder(
  a: ExecutionOrderEpic,
  b: ExecutionOrderEpic,
): number {
  const byColumn =
    (EXECUTION_COLUMN_RANK[a.status ?? ""] ?? UNRANKED_COLUMN) -
    (EXECUTION_COLUMN_RANK[b.status ?? ""] ?? UNRANKED_COLUMN);
  if (byColumn !== 0) return byColumn;

  const byPosition = (a.position ?? 0) - (b.position ?? 0);
  if (byPosition !== 0) return byPosition;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Per-epic blocked map: for every epic that declares unmet dependencies,
 * the ids of the dependency targets that are not done/released yet.
 * Epics with all dependencies satisfied are absent from the map.
 *
 * A dependent that is itself delivered is never blocked, whatever its
 * prerequisites look like: Full Auto ignores `ticket_dependencies`, so an epic
 * can legitimately be built and merged ahead of a ticket it depends on, and a
 * Done card must not advertise a block it has already outlived.
 */
export function computeBlockedBy(
  edges: readonly TicketDependencyEdge[],
  statusById: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const blockedBy = new Map<string, string[]>();
  for (const edge of edges) {
    if (isDeliveredStatus(statusById.get(edge.ticketId))) continue;
    if (isDeliveredStatus(statusById.get(edge.dependsOnTicketId))) continue;
    const list = blockedBy.get(edge.ticketId) ?? [];
    list.push(edge.dependsOnTicketId);
    blockedBy.set(edge.ticketId, list);
  }
  return blockedBy;
}

/**
 * Effective execution order of an already-ordered candidate list.
 *
 * Iterates the epics in the order given — sort them with
 * {@link compareExecutionOrder} first; a ticket excluded by `isExcluded`
 * (blocked or awaiting its user's reply) does not consume a number. The first
 * numbered ticket is rank 1 — the "next" one.
 *
 * Generic over the row shape: the only field it reads is `id`, and the desk
 * feeds it rows that are not full `KanbanEpic`s. Every existing caller passes a
 * `KanbanEpic[]` and is unaffected.
 */
export function computeQueueRanks<T extends { id: string }>(
  todoEpics: readonly T[],
  isExcluded: (epic: T) => boolean,
): Map<string, number> {
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const epic of todoEpics) {
    if (isExcluded(epic)) continue;
    rank += 1;
    ranks.set(epic.id, rank);
  }
  return ranks;
}

/** Predecessor/successor adjacency for dependency hover highlighting. */
export interface DependencyAdjacency {
  /** ticket -> the tickets it depends on (upstream) */
  predecessors: Map<string, string[]>;
  /** ticket -> the tickets that depend on it (downstream) */
  successors: Map<string, string[]>;
}

export function buildDependencyAdjacency(
  edges: readonly TicketDependencyEdge[],
): DependencyAdjacency {
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    const preds = predecessors.get(edge.ticketId) ?? [];
    preds.push(edge.dependsOnTicketId);
    predecessors.set(edge.ticketId, preds);

    const succs = successors.get(edge.dependsOnTicketId) ?? [];
    succs.push(edge.ticketId);
    successors.set(edge.dependsOnTicketId, succs);
  }
  return { predecessors, successors };
}

/** The card under the pointer plus the two sets its focus lights up. */
export interface DependencyFocus {
  epicId: string;
  predecessors: ReadonlySet<string>;
  successors: ReadonlySet<string>;
}

/**
 * Focus sets for the hovered card, or `null` when the focus would dim cards
 * without lighting anything up.
 *
 * `renderedIds` is the set of epics actually on screen, so the test is "has a
 * VISIBLE neighbour", not "has an edge". An edge whose other end sits in the
 * Released column, in a Done column collapsed by focus mode, or behind an
 * active filter cannot be highlighted, and dimming the board to point at a card
 * nobody can see communicates nothing. The hovered card itself must also still
 * be rendered — that is what drops the focus when it is filtered away or moved
 * by an SSE update, since React synthesises no mouseleave on unmount.
 */
export function buildDependencyFocus(
  epicId: string,
  adjacency: DependencyAdjacency,
  renderedIds: ReadonlySet<string>,
): DependencyFocus | null {
  if (!renderedIds.has(epicId)) return null;
  const predecessors = (adjacency.predecessors.get(epicId) ?? []).filter((id) =>
    renderedIds.has(id),
  );
  const successors = (adjacency.successors.get(epicId) ?? []).filter((id) =>
    renderedIds.has(id),
  );
  if (predecessors.length === 0 && successors.length === 0) return null;
  return {
    epicId,
    predecessors: new Set(predecessors),
    successors: new Set(successors),
  };
}

/**
 * How one card relates to the active focus: the hovered card itself, one of
 * its neighbours (each with its own ring), or an unrelated card that dims.
 */
export type DependencyFocusRole =
  | "focused"
  | "predecessor"
  | "successor"
  | "dimmed";

export function dependencyFocusRole(
  epicId: string,
  focus: DependencyFocus | null,
): DependencyFocusRole | undefined {
  if (!focus) return undefined;
  if (epicId === focus.epicId) return "focused";
  if (focus.predecessors.has(epicId)) return "predecessor";
  if (focus.successors.has(epicId)) return "successor";
  return "dimmed";
}

/** How many readiness criteria a card met, out of how many apply to it. */
export interface ReadinessScore {
  met: number;
  total: number;
}

/**
 * Readiness of a Backlog card: no open agent question, a non-empty
 * description, and — for feature epics — at least one user story carrying
 * acceptance criteria.
 *
 * The third criterion counts stories with a non-empty rubric
 * (`usWithCriteriaCount`), not stories outright: a story with an empty rubric
 * is precisely what makes the grading stage a journalled no-op.
 *
 * Bug tickets are scored out of 2. Their creation flow is a direct form with no
 * mandatory rubric, so a third criterion they structurally cannot meet would
 * park every bug card permanently in the "not ready" style and advertise a
 * requirement that does not exist for them.
 */
export function computeReadiness(epic: KanbanEpic): ReadinessScore {
  const rubricApplies = epic.type !== "bug";
  let met = 0;
  if (!isAwaitingReply(epic)) met += 1;
  if ((epic.description ?? "").trim().length > 0) met += 1;
  if (rubricApplies && (epic.usWithCriteriaCount ?? 0) > 0) met += 1;
  return { met, total: rubricApplies ? 3 : 2 };
}
