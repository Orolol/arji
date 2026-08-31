import { PROVIDER_LABELS } from "@/lib/agent-config/constants";
import { projectTone, type ProjectTone } from "@/components/piscine";

/**
 * Pure formatting helpers for the Usage observatory.
 *
 * Moved out of `app/usage/page.tsx` unchanged when frame 8d split that file
 * into `components/usage/*`. `formatCostUsd` / `formatTokens` stay in
 * `lib/utils/format-usage.ts` — both return `null` for absent values so the
 * caller picks the placeholder instead of ever rendering a fake "$0.00".
 */

export function providerLabel(provider: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
}

/** Local wall clock, 24h — the report's own generation time. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "3d 2h" / "4h 12m" / "12m" — coarse by design, never seconds-accurate. */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Claude's `resets_at` is an ISO-8601 string ("2026-08-18T16:00:00+00:00").
 * Deliberately NOT routed through the unix-seconds snapshot path: an
 * unparseable value reads as "reset time unknown", never as epoch zero.
 */
export function parseIsoMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Provider-emitted number, or an em-dash — never a stand-in zero. */
export function numberOrDash(value: number | null): string {
  return value === null ? "—" : String(value);
}

/** Age of a snapshot: "less than a minute" / "42m" / "5h" / "62d". */
export function formatRelativeAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "2026-08-18" -> "Aug 18". Parsed by hand: `new Date("2026-08-18")` is UTC
 * midnight and would render the previous day west of Greenwich, while these
 * keys are already local calendar dates.
 */
export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || month < 1 || month > 12) return date;
  return `${MONTH_LABELS[month - 1]} ${day}`;
}

/**
 * Window label derived from what the provider actually emitted — never
 * asserted. Unknown window size gets the neutral "WINDOW".
 */
export function windowLabel(windowMinutes: number | null): string {
  if (windowMinutes === null) return "WINDOW";
  if (windowMinutes === 10080) return "WEEKLY";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}D WINDOW`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}H WINDOW`;
  return `${windowMinutes}MIN WINDOW`;
}

/**
 * Identity colour for a BY PROJECT row.
 *
 * `projects.color_index` does not exist in the schema yet, so `colorIndex` is
 * null on every row today and the fallback is a stable hash of the project id.
 * Deliberately NOT the row's position: `GET /api/projects` orders by
 * `updatedAt`, so a positional colour would reshuffle whenever any project is
 * touched. Two projects sharing a tone past the fourth is accepted.
 */
export function resolveProjectTone(
  colorIndex: number | null,
  projectId: string,
): ProjectTone {
  if (colorIndex !== null && Number.isFinite(colorIndex)) {
    return projectTone(colorIndex);
  }
  // djb2, folded to a non-negative int. Stable across processes and restarts.
  let hash = 5381;
  for (let i = 0; i < projectId.length; i++) {
    hash = ((hash << 5) + hash + projectId.charCodeAt(i)) | 0;
  }
  return projectTone(Math.abs(hash));
}
