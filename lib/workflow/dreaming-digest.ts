/**
 * Dreaming — window maths, per-session rendering and the fair-truncation
 * budget. Pure functions only: no database, no filesystem, no clock of its
 * own (every entry point takes `now`), so the collector's rules are testable
 * without seeding a schema.
 *
 * The DB-backed collector that feeds these lives in lib/workflow/dreaming.ts.
 */

import {
  DREAM_DIGEST_MAX_CHARS,
  DREAM_ERROR_MAX_CHARS,
  DREAM_FINAL_TEXT_MAX_CHARS,
  DREAM_FINDING_MAX_CHARS,
  DREAM_FORENSIC_MAX_CHARS,
  DREAM_MAX_FINDINGS_PER_SESSION,
  DREAM_WINDOW_DAYS,
} from "./dreaming-constants";

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface DreamWindow {
  /**
   * Inclusive lower bound: sessions that reached a TERMINAL state at/after
   * this are candidates. Terminal time, not start time — a build running
   * across the previous dream became evidence only when it ended.
   */
  sinceIso: string;
  /** True when the bound came from the previous cutoff rather than the age cap. */
  boundedByLastCutoff: boolean;
}

/**
 * Resolves the collection window's start.
 *
 * The window opens at the previous dream's COLLECTION cutoff — a dream must
 * never re-read evidence a previous dream already folded into the memory — but
 * never reaches further back than `windowDays`, so a project's first dream (or
 * one after a long pause) does not try to swallow its whole history.
 *
 * An unparseable/absent `lastCutoffAt` falls back to the age cap, and a
 * cutoff in the future is honoured as-is: a clock skew that makes the window
 * empty is a no-op dream, which is the safe direction.
 */
export function resolveDreamWindow(input: {
  lastCutoffAt: string | null;
  now: Date;
  windowDays?: number;
}): DreamWindow {
  const windowDays = input.windowDays ?? DREAM_WINDOW_DAYS;
  const floorMs = input.now.getTime() - windowDays * DAY_MS;
  const lastCutoffMs = parseTimestampMs(input.lastCutoffAt);

  if (lastCutoffMs !== null && lastCutoffMs > floorMs) {
    return {
      sinceIso: new Date(lastCutoffMs).toISOString(),
      boundedByLastCutoff: true,
    };
  }
  return {
    sinceIso: new Date(floorMs).toISOString(),
    boundedByLastCutoff: false,
  };
}

/* ------------------------------------------------------------------ */
/* Per-session digest                                                  */
/* ------------------------------------------------------------------ */

/**
 * One session's compact record. Deliberately NOT the raw chunk stream: only
 * the signals that carry a lesson — how the run ended, what the reviewer
 * blocked on, what the post-mortem said, and the tail of what the agent
 * finally wrote.
 */
export interface DreamSessionDigest {
  sessionId: string;
  /** Session start (falls back to row creation) — chronological sort key. */
  at: string | null;
  /** Readable ticket label ("E-proj-003: Login"), or null for untied runs. */
  ticketLabel: string | null;
  agentType: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  /** Delivery verdict: answered | silent | asked_question | transition_refused | error. */
  outcome: string | null;
  durationMs: number | null;
  costUsd: number | null;
  /** Failure text, or the refusal reason for a `transition_refused` run. */
  error: string | null;
  /** "Approved" / "Changes Requested" / ... scraped from a review report. */
  reviewVerdict: string | null;
  /** `[critical]`/`[major]` finding bodies filed during the run. */
  findings: string[];
  /** Forensic post-mortem filed on this session's ticket, if any. */
  forensic: string | null;
  /** Tail of the session's final response. */
  finalText: string | null;
}

/** Cuts `text` to `max` characters, appending an ellipsis marker when cut. */
export function truncateText(
  text: string,
  max: number,
  marker = " …[cut]"
): string {
  if (text.length <= max) return text;
  if (max <= marker.length) return text.slice(0, Math.max(0, max));
  return text.slice(0, max - marker.length) + marker;
}

/** Keeps the LAST `max` characters — a final answer's conclusion is its end. */
export function tailText(text: string, max: number, marker = "…[cut] "): string {
  if (text.length <= max) return text;
  if (max <= marker.length) return text.slice(-max);
  return marker + text.slice(-(max - marker.length));
}

/**
 * Scrapes the `**Overall Verdict: X**` line every review/QA prompt mandates
 * (lib/claude/prompt-builder.ts). Returns null when the reviewer did not
 * produce one — which is itself worth nothing in the digest, so it is omitted
 * rather than guessed at.
 */
export function extractReviewVerdict(
  text: string | null | undefined
): string | null {
  if (!text) return null;
  const match = text.match(/\*\*Overall Verdict:\s*([^*\n]+)\*\*/i);
  if (!match) return null;
  const verdict = match[1].trim();
  return verdict.length > 0 ? verdict : null;
}

function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Renders one session as a markdown block. Every per-field cap is applied
 * here, BEFORE the digest-wide fair-truncation pass, so a single pathological
 * field (a 200 KB stack trace) cannot eat a session's whole allocation.
 */
export function renderSessionDigest(entry: DreamSessionDigest): string {
  const lines: string[] = [];
  const heading = entry.ticketLabel
    ? `### ${entry.ticketLabel}`
    : `### (no ticket)`;
  lines.push(heading);

  const meta: string[] = [];
  if (entry.agentType) meta.push(`type ${entry.agentType}`);
  if (entry.provider) {
    meta.push(entry.model ? `${entry.provider}/${entry.model}` : entry.provider);
  }
  if (entry.status) meta.push(`status ${entry.status}`);
  if (entry.outcome) meta.push(`outcome ${entry.outcome}`);
  const duration = formatDuration(entry.durationMs);
  if (duration) meta.push(duration);
  if (entry.costUsd !== null && Number.isFinite(entry.costUsd)) {
    meta.push(`$${entry.costUsd.toFixed(2)}`);
  }
  if (entry.at) meta.push(entry.at);
  lines.push(`- ${meta.join(" · ")}`);

  if (entry.outcome === "transition_refused") {
    lines.push(
      `- **Transition refused:** ${truncateText(
        entry.error?.trim() || "(no reason recorded)",
        DREAM_ERROR_MAX_CHARS
      )}`
    );
  } else if (entry.error && entry.error.trim()) {
    lines.push(
      `- **Error:** ${truncateText(entry.error.trim(), DREAM_ERROR_MAX_CHARS)}`
    );
  }

  if (entry.reviewVerdict) {
    lines.push(`- **Review verdict:** ${entry.reviewVerdict}`);
  }

  const findings = entry.findings.slice(0, DREAM_MAX_FINDINGS_PER_SESSION);
  if (findings.length > 0) {
    lines.push(`- **Blocking findings:**`);
    for (const finding of findings) {
      lines.push(
        `  - ${truncateText(finding.replace(/\s+/g, " ").trim(), DREAM_FINDING_MAX_CHARS)}`
      );
    }
    const hidden = entry.findings.length - findings.length;
    if (hidden > 0) lines.push(`  - (+${hidden} more)`);
  }

  if (entry.forensic && entry.forensic.trim()) {
    lines.push(`- **Forensic:**`);
    lines.push(truncateText(entry.forensic.trim(), DREAM_FORENSIC_MAX_CHARS));
  }

  if (entry.finalText && entry.finalText.trim()) {
    lines.push(`- **Final response (tail):**`);
    lines.push(tailText(entry.finalText.trim(), DREAM_FINAL_TEXT_MAX_CHARS));
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Fair truncation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Water-filling allocation: hands every item an equal share of `totalBudget`,
 * then recycles the surplus left by items that need less than their share to
 * the ones that need more. The result is that a short session is NEVER cut to
 * make room for a verbose one, and the verbose ones share what is left evenly
 * — the "troncature équitable" the digest budget requires.
 *
 * Returns one allocation per item, in input order; the sum never exceeds
 * `totalBudget`. Items allocated 0 did not fit at all and are dropped by the
 * caller (reported, never silently).
 */
export function allocateFairBudgets(
  sizes: number[],
  totalBudget: number
): number[] {
  const allocations = new Array<number>(sizes.length).fill(0);
  if (sizes.length === 0 || totalBudget <= 0) return allocations;

  let pending = sizes.map((_, index) => index);
  let remaining = totalBudget;

  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    if (share <= 0) break;

    const satisfied = pending.filter((index) => sizes[index] <= share);
    if (satisfied.length === 0) {
      // Everyone left wants more than an equal share: split what remains
      // evenly, giving the integer-division remainder to the earliest items
      // so the result is deterministic.
      let leftover = remaining - share * pending.length;
      for (const index of pending) {
        allocations[index] = share + (leftover > 0 ? 1 : 0);
        if (leftover > 0) leftover -= 1;
      }
      return allocations;
    }

    for (const index of satisfied) {
      allocations[index] = sizes[index];
      remaining -= sizes[index];
    }
    pending = pending.filter((index) => sizes[index] > share);
  }

  return allocations;
}

export interface AssembledDreamDigest {
  /** The markdown digest handed to the dream session. */
  text: string;
  /** Sessions that made it into the digest (allocation > 0). */
  includedCount: number;
  /** Of those, how many were cut to fit their allocation. */
  truncatedCount: number;
  /** Sessions the budget could not fit at all. */
  droppedCount: number;
}

const DIGEST_SEPARATOR = "\n\n";

/**
 * Assembles the per-session blocks into the digest, enforcing the hard size
 * budget through `allocateFairBudgets`. Blocks are rendered in the order
 * given (the collector passes them oldest → newest, so the dream reads the
 * period as a story).
 */
export function assembleDreamDigest(
  entries: DreamSessionDigest[],
  maxChars: number = DREAM_DIGEST_MAX_CHARS
): AssembledDreamDigest {
  if (entries.length === 0) {
    return { text: "", includedCount: 0, truncatedCount: 0, droppedCount: 0 };
  }

  const blocks = entries.map(renderSessionDigest);
  // Separators are part of the budget: the cap is on what the prompt carries,
  // not on the blocks alone.
  const separatorCost = DIGEST_SEPARATOR.length * Math.max(0, blocks.length - 1);
  const budget = Math.max(0, maxChars - separatorCost);
  const allocations = allocateFairBudgets(
    blocks.map((block) => block.length),
    budget
  );

  const kept: string[] = [];
  let truncatedCount = 0;
  let droppedCount = 0;

  blocks.forEach((block, index) => {
    const allocation = allocations[index];
    if (allocation <= 0) {
      droppedCount += 1;
      return;
    }
    if (block.length > allocation) {
      truncatedCount += 1;
      kept.push(truncateText(block, allocation, "\n…[session digest cut]"));
      return;
    }
    kept.push(block);
  });

  return {
    text: kept.join(DIGEST_SEPARATOR),
    includedCount: kept.length,
    truncatedCount,
    droppedCount,
  };
}
