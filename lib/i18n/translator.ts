import { createTranslator } from "next-intl";

import { messagesFor } from "./catalogue";
import type { UiLocale } from "./locales";

type Messages = ReturnType<typeof messagesFor>;

/**
 * A translator for code that runs outside React and outside a request-scoped
 * `getTranslations()`: `lib/` derivations that compose display strings, and
 * API routes that ship them (the tickets registry). The caller supplies the
 * locale it resolved — `resolveUiLocaleForRequest(request)` in a route — so
 * nothing here guesses one.
 *
 *   const t = translatorFor(locale, "Registry");
 *   t("activity.created", { age })
 *
 * Same message source, same ICU, same typed keys as `useTranslations`.
 */
export function translatorFor<Namespace extends keyof Messages & string>(
  locale: UiLocale,
  namespace: Namespace,
) {
  return createTranslator({ locale, messages: messagesFor(locale), namespace });
}
