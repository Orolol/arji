/**
 * The i18n import surface.
 *
 *   import { type TranslationKey, UI_LOCALES } from "@/lib/i18n";
 *
 * Read `./catalogue.ts` first: its header is the contract every extraction
 * follows. The translation hooks themselves come straight from `next-intl`
 * (`useTranslations`, `useLocale`) and `next-intl/server` (`getTranslations`,
 * `getLocale`); nothing wraps them.
 */

export {
  DEFAULT_UI_LOCALE,
  NEGOTIABLE_UI_LOCALES,
  UI_LOCALES,
  UI_LOCALE_SETTING_KEY,
  isUiLocale,
  negotiateUiLocale,
  resolveUiLocale,
} from "./locales";
export type { UiLocale } from "./locales";

export { catalogueValue, messagesFor, partialCatalogueFor } from "./catalogue";
export type { Messages, TranslationKey } from "./catalogue";

export {
  formatDateTime,
  formatDayLabel,
  formatNumber,
  formatRelative,
  parseTimestamp,
  pluralCategory,
} from "./format";
export type {
  DateTimeStyle,
  FormatDateTimeOptions,
  FormatNumberOptions,
  FormatRelativeOptions,
  Timestamp,
} from "./format";
