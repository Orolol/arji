/**
 * The interface locales and how the one to render is chosen.
 *
 * ONE STORED SETTING, NOT URL ROUTING. Arij is a single-user localhost app
 * with no SEO and no shareable URLs, so the `[lang]` sub-path routing that
 * Next's own guide recommends buys nothing and would move every route file
 * under a dynamic segment. The locale is a `ui_locale` row in the existing
 * `settings` table (free-form keys need no migration), read and written
 * through `app/api/settings/route.ts`, and resolved once per request by
 * `resolveRequestUiLocale` in ./resolve-request-locale.ts.
 *
 * Resolution order:
 *   1. the stored `ui_locale` when it names a catalogue that exists;
 *   2. the browser language (`Accept-Language`), negotiated against the
 *      locales whose catalogue is COMPLETE — see `NEGOTIABLE_UI_LOCALES`;
 *   3. `DEFAULT_UI_LOCALE`.
 *
 * Nothing here touches `proxy.ts` (the file Next 16 keeps where
 * `middleware.ts` used to be): it keeps doing only its localhost-origin job.
 */

/** Every locale that has a catalogue under ./messages. */
export const UI_LOCALES = ["en", "fr"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** The source language: the catalogue every key is written in first. */
export const DEFAULT_UI_LOCALE = "en" satisfies UiLocale;

/**
 * The locales the browser language may pick on first run.
 *
 * `fr` is deliberately NOT here yet. Its catalogue is the seed captured while
 * the French screens were rewritten in English — the swept Piscine bands have
 * French, everything that was already English has no French at all — so
 * choosing it automatically would put a French-speaking browser straight back
 * into the mixed interface this substrate exists to end. A stored `ui_locale`
 * of `fr` is still honoured (that is what the follow-up "French locale +
 * language switcher" epic writes); only the AUTOMATIC choice is restricted.
 * Completing `fr.json` and adding it here is that epic's one-line flip.
 */
export const NEGOTIABLE_UI_LOCALES: readonly UiLocale[] = ["en"];

/** The `settings.key` the interface locale is stored under. */
export const UI_LOCALE_SETTING_KEY = "ui_locale";

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the best candidate for an `Accept-Language` header.
 *
 * Ranges are ordered by their `q` weight (absent = 1, `q=0` = excluded), then
 * by position; a range matches a candidate on its base language, so `fr-CA`
 * picks `fr` and `en-GB;q=0.8, fr;q=0.9` picks `fr` when both are offered.
 * Anything unparsable, empty or unmatched falls back to `DEFAULT_UI_LOCALE`.
 */
export function negotiateUiLocale(
  acceptLanguage: string | null | undefined,
  candidates: readonly UiLocale[] = NEGOTIABLE_UI_LOCALES,
): UiLocale {
  if (!acceptLanguage) return DEFAULT_UI_LOCALE;

  const ranges = acceptLanguage
    .split(",")
    .map((raw, index) => {
      const [tag, ...params] = raw.trim().split(";");
      const language = tag.trim().toLowerCase();
      let quality = 1;
      for (const param of params) {
        const [name, value] = param.trim().split("=");
        if (name?.trim().toLowerCase() === "q" && value !== undefined) {
          const parsed = Number.parseFloat(value);
          quality = Number.isFinite(parsed) ? parsed : 0;
        }
      }
      return { language, quality, index };
    })
    .filter((range) => range.language.length > 0 && range.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  for (const range of ranges) {
    if (range.language === "*") return candidates[0] ?? DEFAULT_UI_LOCALE;
    const base = range.language.split("-")[0];
    const match = candidates.find((candidate) => candidate === range.language || candidate === base);
    if (match) return match;
  }
  return DEFAULT_UI_LOCALE;
}

/**
 * The locale a request renders in: the stored setting when it is one we have
 * a catalogue for, otherwise the browser language.
 */
export function resolveUiLocale({
  stored,
  acceptLanguage,
}: {
  stored: unknown;
  acceptLanguage: string | null | undefined;
}): UiLocale {
  if (isUiLocale(stored)) return stored;
  return negotiateUiLocale(acceptLanguage);
}
