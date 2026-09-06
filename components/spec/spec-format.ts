/**
 * Pure formatters shared by the Spec & Memory screen (frame 8b).
 *
 * Kept out of the components so they can be unit-tested directly and so the
 * prompt-anatomy route and the band agree on one row shape.
 *
 * CHARACTER FIDELITY IS LOAD-BEARING here: the em dash is U+2014, the middle
 * dot U+00B7, the arrow U+2192. Thousands grouping and relative time come
 * from the shared family in `lib/i18n/format.ts`, which keeps the frame's
 * PLAIN U+0020 where a locale would group with U+202F (measured there) — this
 * file no longer formats anything by hand.
 */

import { formatNumber, formatRelative } from "@/lib/i18n/format";
import type { UiLocale } from "@/lib/i18n/locales";
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
 * The word count as the frame prints it: `1 240` in French (plain space),
 * `1,240` in English — one call into the shared family, no hand-rolled
 * grouping. A rounded whole number: a word count has no decimals.
 */
export function formatCount(value: number, locale: UiLocale): string {
  return formatNumber(Math.round(value), { locale });
}

/**
 * The footer's two strings, resolved by the caller from the `Spec` namespace:
 * `{ unsaved: t("footer.unsaved"), saved: (age) => t("footer.saved", { age }) }`.
 */
export interface SpecFooterCopy {
  unsaved: string;
  saved: (age: string) => string;
}

/**
 * The trailing clause of the spec editor's mono footer:
 * `saved 12s ago` / `unsaved` / `—` (`sauvegardé il y a 12 s` /
 * `non sauvegardé` under fr). Seconds are counted because the stamp is
 * watched while typing; under five seconds it reads "just now", never "0s".
 */
export function formatSaveState(
  {
    dirty,
    savedAt,
  }: {
    dirty: boolean;
    savedAt: string | null | undefined;
  },
  {
    locale,
    now = Date.now(),
    copy,
  }: {
    locale: UiLocale;
    now?: number;
    copy: SpecFooterCopy;
  },
): string {
  if (dirty) return copy.unsaved;
  if (!savedAt) return EM_DASH;
  const age = formatRelative(savedAt, { locale, now, precision: "second" });
  return age ? copy.saved(age) : EM_DASH;
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
