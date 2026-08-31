/**
 * Pure formatters shared by the Spec & Memory screen (frame 8b).
 *
 * Kept out of the components so they can be unit-tested directly and so the
 * prompt-anatomy route and the band agree on one row shape.
 *
 * CHARACTER FIDELITY IS LOAD-BEARING here: the em dash is U+2014, the middle
 * dot U+00B7, the arrow U+2192. The thousands separator is a PLAIN U+0020 —
 * `Intl.NumberFormat("fr-FR")` emits U+202F (narrow no-break space), which the
 * frame does not use and which Space Mono renders at a different advance.
 */

import type { PromptAnatomySegment } from "@/lib/tokens/estimator";

/** The em dash every "unavailable numeral" collapses to. Never a zero. */
export const EM_DASH = "—";

/**
 * One row of the ANATOMIE DU PROMPT band: a named agent × role, sampled from
 * that pair's most recent session that stored a prompt breakdown.
 *
 * Shared between `app/api/projects/[projectId]/prompt-anatomy/route.ts` (which
 * produces it) and `components/spec/PromptAnatomyBand.tsx` (which draws it).
 */
export interface PromptAnatomyRow {
  /** `named_agents.id` when the session recorded one. */
  agentId: string | null;
  /** Display name, e.g. "Opus Builder". */
  agentName: string;
  /** BUILD | BUG FIX | REVIEW | MERGE FIX | CHAT & SPEC | <uppercased type>. */
  role: string;
  /** Token counts per drawn segment, already folded. Zero = draw nothing. */
  segments: Record<PromptAnatomySegment, number>;
  /** Best-effort labels appended inside a segment. Never fabricated. */
  annotations: Partial<Record<"system" | "ticket", string>>;
  /** Sum of the six segments — NOT the stored `estimatedPromptTokens`. */
  total: number;
  /** The sampled session's `createdAt`, for the row tooltip. */
  sampledAt: string | null;
  sessionId: string | null;
}

/**
 * Token counts as the frame prints them: `999`, `1.1k`, `14.2k`, `10k`.
 *
 * Anything unknown is an em dash — never `0k`, never a bare `0` standing in
 * for "we did not measure this".
 */
export function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return EM_DASH;
  if (value < 1000) return String(Math.round(value));
  const thousands = (value / 1000).toFixed(1);
  // "10.0k" reads as false precision; the frame writes "10k".
  return `${thousands.endsWith(".0") ? thousands.slice(0, -2) : thousands}k`;
}

/**
 * Thousands grouping with a PLAIN space: `1240` → `1 240`, per the frame.
 * See the file header for why this is not `Intl.NumberFormat`.
 */
export function formatCount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * French relative time for the spec footer.
 *
 * `lib/utils/format-date.ts:timeAgo()` returns English ("12m ago") and is used
 * by 20+ other screens — this is a local French sibling, not a change to it.
 *
 * Never renders "il y a 0 s": under five seconds the answer is "à l'instant".
 */
export function formatFrenchRelative(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return EM_DASH;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return EM_DASH;

  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 5) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;

  return `il y a ${Math.floor(hours / 24)} j`;
}

/**
 * The trailing clause of the spec editor's mono footer:
 * `sauvegardé il y a 12 s` / `non sauvegardé` / `—`.
 */
export function formatSaveState(
  {
    dirty,
    savedAt,
  }: {
    dirty: boolean;
    savedAt: string | null | undefined;
  },
  now: number = Date.now(),
): string {
  if (dirty) return "non sauvegardé";
  if (!savedAt) return EM_DASH;
  return `sauvegardé ${formatFrenchRelative(savedAt, now)}`;
}

/**
 * Word count of the editor text. `null` (not `0`) before the spec has loaded:
 * an unavailable numeral is an em dash, and `0 mots` is only ever legitimate
 * once we know the document is genuinely empty.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
