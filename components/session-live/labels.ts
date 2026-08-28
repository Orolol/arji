/**
 * Copy tables for the live-session screen.
 *
 * The old page kept these inline alongside a `STATUS_PILL` map that painted
 * each status its own colour. That map is gone: colour is stratum or project
 * identity, never state, so the status is now carried by the WORD inside a
 * `<Stamp>` and by motion (the breathing dot, the crawling progress bar).
 */
import type { StampTone } from "@/components/piscine";

/** Human name per dispatch role. Read by the header stamp and the ENSUITE chain. */
export const AGENT_TYPE_LABELS: Record<string, string> = {
  build: "Build",
  ticket_build: "Ticket Build",
  team_build: "Team Build",
  review_security: "Security Review",
  review_code: "Code Review",
  review_compliance: "Compliance Review",
  review_feature: "Feature Review",
  review_second_opinion: "Second Opinion",
  grading: "Acceptance Grading",
  merge: "Merge",
  tech_check: "Tech Check",
  memory_distill: "Memory Distill",
  dreaming: "Dreaming",
  forensic: "Forensic",
  failure_digest: "Failure Digest",
};

/**
 * Delivery verdicts, copied from `components/shared/SessionOutcomeBadge.tsx`.
 *
 * The LABELS only — that component also carries per-outcome colour classes
 * (`text-agent`, `bg-priority-yellow/10`, `border-destructive/30`), which is
 * state-as-colour and has no place on this screen. The badge itself is left
 * alone: the sessions LIST page still renders it.
 */
export const OUTCOME_LABELS: Record<string, string> = {
  answered: "Answered",
  asked_question: "Asked a question",
  silent: "Silent",
  error: "Error",
  transition_refused: "Transition held",
};

/** What the header stamp says, per session status. */
export interface StatusStamp {
  tone: StampTone;
  word: string;
  dot?: boolean;
}

const STAMP_BY_STATUS: Record<string, StatusStamp> = {
  running: { tone: "live", word: "LIVE", dot: true },
  queued: { tone: "next", word: "QUEUED" },
  completed: { tone: "land", word: "DONE" },
  failed: { tone: "failed", word: "FAILED" },
  cancelled: { tone: "next", word: "CANCELLED" },
};

/**
 * The stamp for a status. An unknown status keeps its own word rather than
 * being silently folded into a neighbour's — the trace has to stay true.
 */
export function statusStamp(status: string): StatusStamp {
  return (
    STAMP_BY_STATUS[status] ?? { tone: "next", word: status.toUpperCase() }
  );
}

/**
 * The short mono label on the project identity chip: `"Arij"` → `"ARIJ"`.
 *
 * Diacritics are stripped through NFD rather than dropped, so `"Prêt-à-coder"`
 * becomes `"PRETAC"` and not `"PRT"`.
 */
export function projectShortLabel(name: string): string {
  const ascii = name
    .normalize("NFD")
    // U+0300–U+036F, the combining diacritical marks NFD just split off.
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const first = ascii.split(/[^A-Z0-9]+/).find(Boolean) ?? "";
  return first.slice(0, 6);
}
