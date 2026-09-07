import { getRequestConfig } from "next-intl/server";

import { messagesFor } from "./catalogue";
import { resolveRequestUiLocale } from "./resolve-request-locale";

/**
 * next-intl's per-request configuration, registered by `next.config.ts`
 * through `createNextIntlPlugin("./lib/i18n/request.ts")`.
 *
 * No routing layer: the locale comes from the stored setting and the browser
 * language (see ./locales.ts), never from a URL segment, so `requestLocale`
 * is deliberately not read.
 */
export default getRequestConfig(async () => {
  const locale = await resolveRequestUiLocale();
  return {
    locale,
    messages: messagesFor(locale),
  };
});
