/**
 * Board execution-queue, blocked-state, and readiness helpers.
 *
 * Pure, deterministic functions backing the board's execution visibility:
 * effective queue ranking of the To Do column, dependency-blocked
 * detection, predecessor/successor adjacency for hover highlighting, and
 * the three-criterion readiness indicator on Backlog cards.
 *
 * The numbering reflects board `position` order and deliberately anticipates
 * the unmerged "unified execution order" work (position as the single source
 * of truth for both the board and Full Auto dispatch). Until that lands, the
 * board's "next" marker and the supervisor's first dispatch can disagree in
 * two known ways:
 *
 *  - Ordering: `compareEpics` in lib/auto-mode/select.ts sorts priority DESC
 *    before position ASC, while this module walks the position-only order the
 *    board renders. Two To Do epics of different priority therefore rank
 *    differently on each side.
 *  - Blocking: `isEpicSelectable` in lib/auto-mode/select.ts does not consult
 *    `ticket_dependencies` at all (its `blockedEpicIds` means "claimed by a
 *    pipeline, night run or merge" — an unrelated notion that happens to share
 *    the name). Full Auto will dispatch an epic this module greys out.
 *  - Skips the board cannot see: `isEpicSelectable` also refuses epics in
 *    `parkedTicketIds` (soft-parked after three consecutive failures) and
 *    `busyEpicIds`. Both live in the in-process `autoModeRegistry`, not in the
 *    database, and no API exposes them — so a parked epic keeps rank #1 and the
 *    "next" badge while the supervisor will never dispatch it. This is the most
 *    misleading divergence and the one this module has no way to close.
 *
 * Only the awaiting-reply exclusion is genuinely shared: both sides call
 * `isAwaitingReply`. Do not assume the rest agrees until the prerequisite epic
 * is merged.
 */

import { isAwaitingReply } from "./awaiting-reply";
import {
  isDeliveredStatus,
  type KanbanEpic,
  type TicketDependencyEdge,
} from "@/lib/types/kanban";

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
