/**
 * Client-side ticket filters — the pure half of the retired kanban FilterBar.
 *
 * The bar itself is gone with the board; these predicates are not. They are
 * the only definition of "does this ticket survive the active filters", they
 * carry the persistence format written to
 * `arij.kanban-board.filters.<projectId>` since the board shipped, and
 * `parseStoredFilters` is what keeps a malformed or legacy payload from
 * throwing on read.
 *
 * Client-safe by convention (lib/kanban/*): pure functions, no database, no
 * server imports, no React.
 */

import type { KanbanEpic } from "@/lib/types/kanban";

/** Client-side ticket filters. Empty arrays / false flags mean "no filter". */
export interface KanbanFilters {
  /** Ticket types to keep ("feature" / "bug"); empty keeps all */
  types: string[];
  /** Priorities to keep (0-3); empty keeps all */
  priorities: number[];
  /** Keep only epics with an agent currently running */
  agentRunning: boolean;
  /** Keep only epics with an unread AI reply */
  unreadAi: boolean;
  /** Keep only epics whose last agent session failed */
  failedSession: boolean;
}

export const EMPTY_FILTERS: KanbanFilters = {
  types: [],
  priorities: [],
  agentRunning: false,
  unreadAi: false,
  failedSession: false,
};

export function countActiveFilters(filters: KanbanFilters): number {
  return (
    filters.types.length +
    filters.priorities.length +
    (filters.agentRunning ? 1 : 0) +
    (filters.unreadAi ? 1 : 0) +
    (filters.failedSession ? 1 : 0)
  );
}

/** Per-epic live signals the caller already derives, needed to evaluate filters. */
export interface EpicFilterSignals {
  isRunning: boolean;
  unreadAi: boolean;
  hasFailedSession: boolean;
}

/** Pure predicate: does this epic survive the active filters? */
export function epicMatchesFilters(
  epic: Pick<KanbanEpic, "type" | "priority">,
  filters: KanbanFilters,
  signals: EpicFilterSignals,
): boolean {
  if (filters.types.length > 0 && !filters.types.includes(epic.type)) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(epic.priority)
  ) {
    return false;
  }
  if (filters.agentRunning && !signals.isRunning) return false;
  if (filters.unreadAi && !signals.unreadAi) return false;
  if (filters.failedSession && !signals.hasFailedSession) return false;
  return true;
}

/** Parse a persisted filter payload, tolerating malformed or legacy shapes. */
export function parseStoredFilters(raw: string | null): KanbanFilters {
  if (!raw) return EMPTY_FILTERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_FILTERS;
    const record = parsed as Record<string, unknown>;
    return {
      types: Array.isArray(record.types)
        ? record.types.filter((t): t is string => typeof t === "string")
        : [],
      priorities: Array.isArray(record.priorities)
        ? record.priorities.filter((p): p is number => typeof p === "number")
        : [],
      agentRunning: record.agentRunning === true,
      unreadAi: record.unreadAi === true,
      failedSession: record.failedSession === true,
    };
  } catch {
    return EMPTY_FILTERS;
  }
}

/** localStorage key the desk and the retired board share, per project. */
export function filtersStorageKey(projectId: string): string {
  return `arij.kanban-board.filters.${projectId}`;
}
