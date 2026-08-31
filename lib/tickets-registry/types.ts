/**
 * The payload of `GET /api/tickets` — the one read the tickets REGISTRY makes.
 *
 * The registry (frame 12a) is the only table view in Arij and the only surface
 * that shows *every* ticket, `released` ones included. It replaces nothing: the
 * board renders open columns, the "Now" desk renders what demands attention.
 * This is the flat, complete inventory you go to when you want to look
 * something up rather than be told what to do.
 *
 * Nothing in this module touches the database; it is the contract shared by
 * `lib/tickets-registry/aggregate.ts` (which derives it), the route (which
 * feeds that derivation) and `components/tickets-registry/useTicketsRegistry.ts`
 * (which consumes it).
 *
 * DATA-GAP RULE, everywhere in here: a figure that does not exist is `null`,
 * never `0`. The registry renders `null` as an em-dash, and a zero would be a
 * lie the rest of the app does not tell. `SUM(total_cost_usd)` answers NULL on
 * a ticket no session ever billed; that NULL must survive to the em-dash.
 */

import type { DeskProject, DeskTaskType } from "@/lib/control-desk/types";

/**
 * The five strata of the table, in render order.
 *
 * Membership is decided by `deriveRegistryRows`, which calls the SAME helpers
 * the desk calls — never a fresh `if (status === ...)`. See that module's
 * precedence table.
 */
export type RegistryGroup = "active" | "your_turn" | "waiting" | "done" | "released";

export const REGISTRY_GROUP_ORDER: readonly RegistryGroup[] = [
  "active",
  "your_turn",
  "waiting",
  "done",
  "released",
] as const;

/** Why a YOUR TURN row is yours: the desk's own three sub-kinds, in its order. */
export type YourTurnKind = "asks" | "failed" | "conflict";

/**
 * The window the footer's cost figure covers.
 *
 * Deliberately NOT `CONTROL_DESK_LOOKBACK_DAYS` (14): the frame asks for
 * "coût total 30j", which is a different question from "how far back does the
 * desk still shout about a failure".
 */
export const REGISTRY_COST_WINDOW_DAYS = 30;

/** Rows of `status='done'` the route ships before the user asks for more. */
export const REGISTRY_DONE_WINDOW = 40;

/** Rows of `status='released'` the route ships before the user asks for more. */
export const REGISTRY_RELEASED_WINDOW = 40;

/** Ceiling on either window, however large a client asks. */
export const REGISTRY_WINDOW_MAX = 500;

/** Max characters of `?q=` the route reads. */
export const REGISTRY_QUERY_MAX = 120;

export interface RegistryRow {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  /** Raw `epics.status`, never a display label. */
  status: string;
  /** `'feature' | 'bug'` — the type filter pill reads it. */
  type: string;
  priority: number | null;
  group: RegistryGroup;

  /* ÉTAT payload — exactly one branch is populated, chosen by `group`. */

  /** active — the dispatch role, from `inferTaskType`. */
  taskType: DeskTaskType | null;
  /** active — the chrono's origin. */
  startedAt: string | null;
  yourTurnKind: YourTurnKind | null;
  /** waiting — `COLUMN_LABELS[status]`. */
  queueLabel: string | null;
  /** waiting — execution rank from `deriveUpNext`, `null` when it has none. */
  queueRank: number | null;
  /** waiting — resolved labels of the unmet prerequisites. */
  blockedBy: string[];
  /** waiting — `status === 'backlog'`, the DRAFT pill. */
  isDraft: boolean;
  /** waiting — a queued session already owns this ticket. */
  isQueued: boolean;
  /** done — `evaluateMergeReadiness(...).ready`. */
  mergeReady: boolean;
  /** done — `describeMergeBlocker()`, when a blocker stands. */
  mergeBlockerLine: string | null;
  /** released — the release's version, `null` when `release_id` is null. */
  releaseVersion: string | null;

  /* Shared columns. */

  usDone: number;
  usCount: number;
  /** DERNIÈRE ACTIVITÉ, composed server-side so the CSV and the DOM agree. */
  activity: string | null;
  activityTone: "muted" | "you-deep";
  /** `SUM(total_cost_usd)` over the ticket's sessions. NULL is load-bearing. */
  costUsd: number | null;
  projectName: string;
}

/**
 * The six filter-pill counts.
 *
 * Derived from the GROUPS, not from raw status counts, so the number on a pill
 * is exactly the number of rows the pill reveals. `open` is
 * `active + your_turn + waiting`; `all` is every group. `null` before the first
 * response — the pills read `All · —`, never `All · 0`.
 */
export interface RegistryCounts {
  all: number | null;
  open: number | null;
  active: number | null;
  yourTurn: number | null;
  done: number | null;
  released: number | null;
}

export interface TicketsRegistryPayload {
  generatedAt: string;
  /**
   * Every project, even under `?project=` — `colorIndex` is a position in
   * creation order, so narrowing the list would repaint the ticket chips.
   */
  projects: DeskProject[];
  rows: RegistryRow[];
  counts: RegistryCounts;
  /** True count per group, even when the window is smaller than the group. */
  groupTotals: Record<RegistryGroup, number>;
  /** Rows actually shipped per group — compare with `groupTotals` to know if windowed. */
  groupLoaded: Record<RegistryGroup, number>;
  totals: {
    tickets: number;
    projects: number;
    /** `SUM` over 30 days. NULL on a quiet month, and the NULL reaches the em-dash. */
    cost30dUsd: number | null;
  };
}
