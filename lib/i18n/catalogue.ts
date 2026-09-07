/**
 * THE CATALOGUE — every user-facing string of the interface, and the one way
 * code refers to one.
 *
 * ONE FILE PER NAMESPACE. `messages/en/<Namespace>.json` is the source
 * language; `messages/fr/<Namespace>.json` is a PARTIAL seed: it holds the
 * original French of the screens that were rewritten in English, and nothing
 * for the screens that were English to begin with. A key absent from the
 * French file renders its English text (deep merge below) — it is never
 * filled with an English placeholder, because a placeholder would later read
 * as "already translated". `messages/index.ts` is GENERATED from the
 * directory listing (`npm run i18n:index`); adding a namespace is adding one
 * file and re-running it, so two bands can land at once without touching a
 * shared file.
 *
 * ---------------------------------------------------------------------------
 * HOW COPY IS WRITTEN. Apply these mechanically; do not invent a per-file
 * variant.
 *
 * 1. NAMESPACES. One PascalCase namespace per surface or component family
 *    (`Nav`, `Settings`, `TopBar`, `Desk`, …), camelCase keys inside it, and
 *    no dots in a key: `Nav.entries.tickets`. ICU everywhere a value varies:
 *    `"{count, plural, one {# ready} other {# ready}}"`, `"{name} · {age}"`.
 *
 * 2. JSX COPY resolves at render.
 *      client:  const t = useTranslations("Desk");   t("upNext.empty")
 *      server:  const t = await getTranslations("Settings");   t("tabs.workspace")
 *    Keys are string literals at the call site — never a template, never a
 *    concatenation — so the key-coverage script and the typed `t` both see
 *    them. An `id → key` choice is an explicit map (pattern 3), not
 *    `t(\`status.${status}\`)`.
 *
 * 3. MODULE-SCOPE COPY TABLES hold KEY REFERENCES, resolved at render.
 *    A `Record<…>` or object literal evaluated at import time cannot call a
 *    hook, and the tables are read by pure logic and tests that never draw
 *    text (`activeNavCategory`, `resolveNavHref`, an options registry's
 *    `toArgs`). So the table keeps its shape and stores the catalogue key in
 *    place of the text, under a field named `<field>Key` typed as
 *    `TranslationKey`:
 *
 *      { id: "tickets", labelKey: "Nav.entries.tickets", href: "/tickets" }
 *
 *    and the component that draws it resolves with the NAMESPACE-LESS
 *    translator, which takes the full dotted path:
 *
 *      const t = useTranslations();            // or await getTranslations()
 *      <span>{t(entry.labelKey)}</span>
 *
 *    A `Record<string, string>` label map becomes `Record<string,
 *    TranslationKey>` and the consumer does `t(LABEL_KEYS[id] ?? fallback)`.
 *
 *    Why not factories taking `t`: a factory forces `t` through every
 *    consumer of the table (including the ones that never render), rebuilds
 *    the table on every call, and cannot be type-checked against the
 *    catalogue. Key references stay plain data, importable from server,
 *    client, `lib/` and tests alike, and `TranslationKey` makes a typo a
 *    compile error. Proven on `lib/piscine/nav.ts` and
 *    `app/settings/layout.tsx` (a server component — no `"use client"`).
 *
 *    COPY COMPOSED OUTSIDE REACT — a `lib/` derivation or an API route that
 *    builds a display string from parts — takes a translator as an argument
 *    rather than importing one: the component passes its
 *    `useTranslations("Ns")`, a route passes
 *    `translatorFor(resolveUiLocaleForRequest(request), "Ns")`
 *    (lib/i18n/translator.ts). The copy still lives in the catalogue; only
 *    the resolution moves to the caller, which is the one that knows the
 *    locale.
 *
 * 4. LOCALE-SENSITIVE FORMATTING (dates, numbers, plurals) goes through
 *    `lib/i18n/format.ts`, never through a bespoke helper: one family,
 *    parameterised by locale, is what stops a second language from cloning
 *    logic.
 *
 * 5. NOT COPY, NOT HERE: agent-facing text (`lib/chat/board-tools.ts`, the
 *    prompt builders), persisted server text (notifications, activity rows,
 *    API error strings), code comments, user data, and the dev harness under
 *    `app/piscine-preview/`.
 * ---------------------------------------------------------------------------
 */

import type { MessageKeys, NestedKeyOf } from "next-intl";

import { DEFAULT_UI_LOCALE, type UiLocale } from "./locales";
import { en, fr } from "./messages";

/** The shape of the source catalogue; every other locale is a partial of it. */
export type Messages = typeof en;

/** Every leaf key of the catalogue as a full dotted path: `"Nav.entries.tickets"`. */
export type TranslationKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

type MessageTree = { [key: string]: string | MessageTree };

/**
 * `overlay` on top of `base`, branch by branch. A string in the overlay wins;
 * a branch missing from the overlay is the base's branch entirely.
 */
function mergeMessages(base: MessageTree, overlay: MessageTree): MessageTree {
  const merged: MessageTree = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    merged[key] =
      typeof value === "object" && value !== null && typeof current === "object" && current !== null
        ? mergeMessages(current, value)
        : value;
  }
  return merged;
}

const PARTIAL_CATALOGUES: Record<Exclude<UiLocale, typeof DEFAULT_UI_LOCALE>, MessageTree> = {
  fr: fr as MessageTree,
};

const resolved = new Map<UiLocale, Messages>();

/**
 * The complete message tree for a locale: the source catalogue, with the
 * locale's own strings laid over it so a missing key falls back to English
 * rather than to its dotted path.
 */
export function messagesFor(locale: UiLocale): Messages {
  const cached = resolved.get(locale);
  if (cached) return cached;
  const messages =
    locale === DEFAULT_UI_LOCALE
      ? en
      : (mergeMessages(en as MessageTree, PARTIAL_CATALOGUES[locale]) as Messages);
  resolved.set(locale, messages);
  return messages;
}

/**
 * One catalogue string by its full key, outside React — for the formatting
 * family, which is pure and reads its two locale-data values this way.
 * Everything that renders goes through `useTranslations` / `getTranslations`.
 */
export function catalogueValue(locale: UiLocale, key: TranslationKey): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messagesFor(locale),
    );
  return typeof value === "string" ? value : key;
}

/** The raw partial catalogue as checked in — what a translator edits. */
export function partialCatalogueFor(locale: UiLocale): MessageTree {
  return locale === DEFAULT_UI_LOCALE ? (en as MessageTree) : PARTIAL_CATALOGUES[locale];
}
