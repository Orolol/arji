import { headers } from "next/headers";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

import { UI_LOCALE_SETTING_KEY, resolveUiLocale, type UiLocale } from "./locales";

/**
 * The stored `ui_locale`, or `null` when nothing is stored or the read fails.
 *
 * The value is stored JSON-encoded like every other setting written by
 * `PATCH /api/settings`. A failed read is `null` rather than an error: the
 * locale of the chrome is not worth a 500 on every route.
 */
export function readStoredUiLocale(): unknown {
  try {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, UI_LOCALE_SETTING_KEY))
      .get();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return null;
  }
}

/**
 * The locale this request renders in. Called once per request by
 * `lib/i18n/request.ts`.
 *
 * `headers()` is read FIRST, on purpose: it is what tells Next the root
 * layout is dynamic, so `next build` never prerenders a page with a baked-in
 * `<html lang>` — and never opens the database at build time to ask.
 */
export async function resolveRequestUiLocale(): Promise<UiLocale> {
  const acceptLanguage = (await headers()).get("accept-language");
  return resolveUiLocale({ stored: readStoredUiLocale(), acceptLanguage });
}
