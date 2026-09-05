/**
 * The registry's filters, as they live in `/tickets`'s query string.
 *
 * `?project=` was already the way in — a top-bar chip, a desk link — but it
 * was ONLY the way in: every later selection stayed in component state, so
 * picking another project left the parameter behind and a reload restored the
 * one in the URL. The address bar and the screen disagreed, which is the same
 * defect whichever filter you move.
 *
 * So the URL is the single source of truth for the five filters that scope
 * the table: `project`, `status` (an exact kanban column), `state` (the group
 * pills), `sort` and `direction`. Consequences worth stating:
 *
 * - Reload, bookmark and share all work, because there is nothing to restore.
 * - Navigation keeps its priority for free. Arriving at `/tickets?project=X`
 *   shows X — no selection survives the navigation to argue with it.
 * - Every screen state is expressible as a URL, so Back and Forward walk the
 *   filter history (`components/tickets-registry/useRegistryUrlState.ts`).
 *
 * WHAT IS NOT HERE, on purpose: the ⌘F query field, the Bug and High+
 * toggles, the collapsed groups and the "tout montrer" windows. A parameter
 * written on every keystroke would fill the history stack with entries the
 * Back button then has to walk one letter at a time; the toggles and the
 * windows are reading posture rather than scope. They stay component state.
 *
 * DEFAULTS ARE OMITTED, never written as `state=all` or `status=all`: a plain
 * `/tickets` stays plain, and the URL only ever names what the user changed.
 * `direction` is defaulted PER SORT (`defaultSortDirection`), so `?sort=titre`
 * means titre ascending and only a flip writes `direction=desc`.
 *
 * PARSING IS TOTAL. A hand-edited or stale parameter falls back to its
 * default instead of throwing or rendering an empty table — the query string
 * is user input, and this screen is often reached from an old link.
 */

import { KANBAN_COLUMNS, type KanbanStatus } from "@/lib/types/kanban";

import {
  REGISTRY_SORTS,
  defaultSortDirection,
  type RegistrySort,
  type RegistrySortDirection,
} from "./sort";

/** The group pills, left to right. `all` is the default and is never written. */
export const REGISTRY_STATE_FILTERS = [
  "all",
  "open",
  "active",
  "your_turn",
  "done",
  "released",
] as const;

export type RegistryStateFilter = (typeof REGISTRY_STATE_FILTERS)[number];

export interface RegistryUrlState {
  /** `null` — the parameter absent — is the whole-workspace registry. */
  projectId: string | null;
  status: KanbanStatus | "all";
  state: RegistryStateFilter;
  sort: RegistrySort;
  direction: RegistrySortDirection;
}

/** The keys this module owns. Anything else in the query string is left alone. */
export const REGISTRY_URL_KEYS = [
  "project",
  "status",
  "state",
  "sort",
  "direction",
] as const;

export const REGISTRY_URL_DEFAULTS: RegistryUrlState = {
  projectId: null,
  status: "all",
  state: "all",
  sort: "activite",
  direction: defaultSortDirection("activite"),
};

function toParams(search: string | URLSearchParams | null | undefined): URLSearchParams {
  if (!search) return new URLSearchParams();
  return typeof search === "string" ? new URLSearchParams(search) : new URLSearchParams(search);
}

/** Read the five filters out of a query string. Unreadable values default. */
export function parseRegistryUrlState(
  search: string | URLSearchParams | null | undefined,
): RegistryUrlState {
  const params = toParams(search);

  const project = params.get("project")?.trim();
  const status = params.get("status");
  const state = params.get("state");
  const sort = params.get("sort");
  const direction = params.get("direction");

  const resolvedSort = REGISTRY_SORTS.includes(sort as RegistrySort)
    ? (sort as RegistrySort)
    : REGISTRY_URL_DEFAULTS.sort;

  return {
    projectId: project ? project : null,
    status: KANBAN_COLUMNS.includes(status as KanbanStatus)
      ? (status as KanbanStatus)
      : "all",
    state: REGISTRY_STATE_FILTERS.includes(state as RegistryStateFilter)
      ? (state as RegistryStateFilter)
      : "all",
    sort: resolvedSort,
    direction:
      direction === "asc" || direction === "desc"
        ? direction
        : defaultSortDirection(resolvedSort),
  };
}

/**
 * The query string `state` becomes, keeping every parameter this module does
 * not own — `?ticket=` and its kind are other people's deep links, and a
 * filter click must not swallow them.
 *
 * Returns `""` for an all-defaults registry, so the caller writes `/tickets`
 * rather than `/tickets?`.
 */
export function registryUrlSearch(
  state: RegistryUrlState,
  current?: string | URLSearchParams | null,
): string {
  const params = toParams(current);
  for (const key of REGISTRY_URL_KEYS) params.delete(key);

  // Written in a fixed order so two equal states produce one URL — the no-op
  // guard in `useRegistryUrlState` compares the strings.
  if (state.projectId) params.set("project", state.projectId);
  if (state.status !== "all") params.set("status", state.status);
  if (state.state !== "all") params.set("state", state.state);
  if (state.sort !== REGISTRY_URL_DEFAULTS.sort) params.set("sort", state.sort);
  if (state.direction !== defaultSortDirection(state.sort)) {
    params.set("direction", state.direction);
  }

  const search = params.toString();
  return search ? `?${search}` : "";
}
