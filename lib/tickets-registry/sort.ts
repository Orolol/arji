import { parseStoredTimestamp } from "@/lib/agent-sessions/last-activity";
import { KANBAN_COLUMNS } from "@/lib/types/kanban";
import type { RegistryRow } from "./types";

export const REGISTRY_SORTS = ["activite", "priorite", "cout", "ticket", "titre", "etat", "stories"] as const;
export type RegistrySort = (typeof REGISTRY_SORTS)[number];
export type RegistrySortDirection = "asc" | "desc";

export function defaultSortDirection(sort: RegistrySort): RegistrySortDirection {
  return ["activite", "priorite", "cout", "stories"].includes(sort) ? "desc" : "asc";
}

/**
 * Display order only, within the existing groups. Missing values stay last.
 * State uses workflow order here. Each SQL terminal window has one constant
 * status, so state sorting leaves its selection in newest-first order.
 */
export function sortRegistryRows(rows: readonly RegistryRow[], sort: RegistrySort, direction: RegistrySortDirection): RegistryRow[] {
  const value = (row: RegistryRow): string | number | null => {
    switch (sort) {
      case "ticket": return row.readableId ?? row.epicId;
      case "titre": return row.title;
      case "etat": return KANBAN_COLUMNS.indexOf(row.status as typeof KANBAN_COLUMNS[number]);
      case "stories": return row.usCount;
      case "priorite": return row.priority;
      case "cout": return row.costUsd;
      case "activite": return row.activityAt ? parseStoredTimestamp(row.activityAt) : null;
    }
  };
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const delta = av === null || bv === null ? 0
      : typeof av === "number" && typeof bv === "number" ? av - bv
      : String(av).toLowerCase() < String(bv).toLowerCase() ? -1
      : String(av).toLowerCase() > String(bv).toLowerCase() ? 1 : 0;
    return delta * (direction === "asc" ? 1 : -1) || a.epicId.localeCompare(b.epicId);
  });
}
