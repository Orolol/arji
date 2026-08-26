/**
 * Board execution-queue, blocked-state, and readiness helpers.
 *
 * Pure, deterministic functions backing the board's execution visibility:
 * effective queue ranking of the To Do column, dependency-blocked
 * detection, predecessor/successor adjacency for hover highlighting, and
 * the three-criterion readiness indicator on Backlog cards.
 *
 * The exclusion rule (blocked or awaiting-reply tickets are skipped by the
 * numbering) mirrors the Full Auto dispatch skip, so the board's "next"
 * marker and the supervisor's first dispatch agree.
 */

import { isAwaitingReply } from "./awaiting-reply";
import type {
  KanbanEpic,
  TicketDependencyEdge,
} from "@/lib/types/kanban";

/** Statuses considered delivered — a dependency target in one of these is satisfied. */
export const DELIVERED_STATUSES: Record<string, true> = {
  done: true,
  released: true,
};

/**
 * Per-epic blocked map: for every epic that declares unmet dependencies,
 * the ids of the dependency targets that are not done/released yet.
 * Epics with all dependencies satisfied are absent from the map.
 */
export function computeBlockedBy(
  edges: readonly TicketDependencyEdge[],
  statusById: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const blockedBy = new Map<string, string[]>();
  for (const edge of edges) {
    if (DELIVERED_STATUSES[statusById.get(edge.dependsOnTicketId) ?? ""]) {
      continue;
    }
    const list = blockedBy.get(edge.ticketId) ?? [];
    list.push(edge.dependsOnTicketId);
    blockedBy.set(edge.ticketId, list);
  }
  return blockedBy;
}

/**
 * Effective execution order of the To Do column.
 *
 * Iterates the position-ordered To Do epics; a ticket excluded by
 * `isExcluded` (blocked or awaiting its user's reply) does not consume a
 * number. The first numbered ticket is rank 1 — the "next" one.
 */
export function computeQueueRanks(
  todoEpics: readonly KanbanEpic[],
  isExcluded: (epic: KanbanEpic) => boolean,
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

/** Total readiness criteria a Backlog card reports. */
export const READINESS_TOTAL = 3;

/**
 * Readiness of a Backlog card: no open agent question, a non-empty
 * description, and at least one user story (acceptance criteria).
 * Returns how many of the `READINESS_TOTAL` criteria are met.
 */
export function computeReadiness(epic: KanbanEpic): number {
  let met = 0;
  if (!isAwaitingReply(epic)) met += 1;
  if ((epic.description ?? "").trim().length > 0) met += 1;
  if (epic.usCount > 0) met += 1;
  return met;
}
