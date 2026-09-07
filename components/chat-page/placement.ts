/**
 * Where a ticket landed, in words — the epic card's `created in To Do · #3` and
 * the rail's shorter `To Do #4`.
 *
 * `null` in, `null` out: the caller prints an em-dash. A placement we cannot
 * resolve is never invented, and never a zero-rank.
 *
 * NO COPY IN THIS FILE, and it takes BOTH halves of the catalogue's answer for
 * text a hook cannot reach (`lib/i18n/catalogue.ts`):
 *
 * - PATTERN 3 for the words. Each status maps to catalogue KEY REFERENCES in a
 *   module-scope table evaluated at import time, `<field>Key` typed
 *   `TranslationKey`, so a typo is a compile error and the key-coverage script
 *   sees the literal where it lives.
 * - A TRANSLATOR ARGUMENT for the resolution, because this module is not React
 *   and composes its sentence from parts (a status and a queue rank). The
 *   caller supplies the NAMESPACE-LESS translator — the keys below are full
 *   dotted paths — and it is the caller that knows the locale.
 *
 * The table also carries the branch, which is why it is a table rather than an
 * if-chain: `todo` is the only status with a ranked variant, and a status that
 * is in neither row falls through to its own word — DATA, with no catalogue
 * key at all, which is exactly why this cannot return a key instead of a
 * string.
 */

import type { useTranslations } from "next-intl";

import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * The namespace-less translator the caller already resolved:
 * `useTranslations()` in a component, a bare `createTranslator` over
 * `messagesFor(locale)` off React.
 *
 * `<never>` IS LOAD-BEARING. Left off, `ReturnType` erases the hook's type
 * parameter to its CONSTRAINT rather than to its default, and the alias then
 * describes a translator bound to some namespace: every full dotted key below
 * fails with "did you mean `placement.backlog`?". `never` is the default the
 * call site gets, i.e. no namespace.
 */
export type CatalogueTranslator = ReturnType<typeof useTranslations<never>>;

/**
 * This table's own slice of the catalogue.
 *
 * NARROWED ON PURPOSE, not for tidiness: `t(key, { rank })` makes the compiler
 * derive the ICU argument shape from the message behind `key`, and doing that
 * across the whole `TranslationKey` union (every leaf of every namespace) is a
 * TS2590 "union type too complex". Six messages is instant, and `Extract` off
 * `TranslationKey` keeps the same compile-time check against the catalogue —
 * a key that stops existing is still an error here.
 */
type PlacementKey = Extract<TranslationKey, `Chat.placement.${string}`>;

interface PlacementKeys {
  /** The sentence with no queue rank in it. */
  plainKey: PlacementKey;
  /** The `#3` variant. Absent for a status that has no rank to print. */
  rankedKey?: PlacementKey;
}

/** The in-thread card's note. */
const LONG_PLACEMENT_KEYS: Record<string, PlacementKeys> = {
  todo: {
    plainKey: "Chat.placement.createdInTodo",
    rankedKey: "Chat.placement.createdInTodoRanked",
  },
  backlog: { plainKey: "Chat.placement.createdInBacklog" },
};

/** The "Created in this chat" rail's shorter note. */
const SHORT_PLACEMENT_KEYS: Record<string, PlacementKeys> = {
  todo: {
    plainKey: "Chat.placement.todo",
    rankedKey: "Chat.placement.todoRanked",
  },
  backlog: { plainKey: "Chat.placement.backlog" },
};

function resolvePlacement(
  keys: Record<string, PlacementKeys>,
  status: string | null | undefined,
  rank: number | null | undefined,
  t: CatalogueTranslator,
): string | null {
  if (!status) return null;
  const entry = keys[status];
  // Anything else is the status word alone rather than a phrase we made up.
  if (!entry) return status;
  return entry.rankedKey && rank !== null && rank !== undefined
    ? t(entry.rankedKey, { rank })
    : t(entry.plainKey);
}

/** The in-thread card's note. */
export function longPlacement(
  status: string | null | undefined,
  rank: number | null | undefined,
  t: CatalogueTranslator,
): string | null {
  return resolvePlacement(LONG_PLACEMENT_KEYS, status, rank, t);
}

/** The "Created in this chat" rail's note. */
export function shortPlacement(
  status: string | null | undefined,
  rank: number | null | undefined,
  t: CatalogueTranslator,
): string | null {
  return resolvePlacement(SHORT_PLACEMENT_KEYS, status, rank, t);
}
