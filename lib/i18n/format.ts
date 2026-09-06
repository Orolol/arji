/**
 * THE formatting family: dates, relative ages, numbers and plural categories,
 * parameterised by locale. Nothing else in the interface formats a date or a
 * number by hand.
 *
 * WHY ONE FAMILY. Language drift had produced five relative-age formatters
 * (`timeAgo`, two identical `relativeAge` copies on the desk and the registry,
 * `formatFrenchRelative` on the spec footer, the chat roster's `relativeAge`),
 * a French `plural()` in the top bar and a hand-rolled thousands grouper — one
 * per language, each documented as deliberately not sharing. Every one of
 * them collapses into a call here. A further locale is catalogue data
 * (`Format.*` in lib/i18n/messages) plus the ICU data the runtime already
 * ships, never another helper.
 *
 * PURE, EXPLICIT LOCALE. These are plain functions taking `{ locale }`, not
 * hooks, so `lib/` derivations, API routes and tests run the same code as
 * components: a client component passes `useLocale()`, a route passes
 * `resolveUiLocaleForRequest(request)`. Nothing here reads a global.
 *
 * WHAT STAYS OUT, ON PURPOSE. Agent-facing and persisted text — the prompt
 * sections, the E2BIG message, the chunk/prompt elision markers — is pinned
 * to `"en-US"` at its own site (each carries a comment saying so) and must
 * not follow the interface locale. Running-duration tickers
 * (`lib/utils/format-elapsed.ts`) and unit shorthands (`formatTokens`,
 * `formatCostUsd`) are not locale sensitive and stay where they are.
 *
 * THE U+202F RULE (measured in Chrome 152 with Space Mono 13px loaded,
 * 2026-09-06): `Intl.NumberFormat("fr-FR")` groups thousands with U+202F
 * NARROW NO-BREAK SPACE, and in Space Mono that glyph advances 3.98px against
 * 7.95px for U+0020 — half a mono cell — so a grouped numeral falls off the
 * mono grid the Piscine frames are drawn on. `formatNumber` therefore rewrites
 * a no-break group separator (U+202F or U+00A0) to a plain U+0020, for every
 * locale that groups that way. English groups with a comma and is untouched.
 * The same rewrite applies to `formatRelative`: French `Intl` writes
 * `il y a 12 s` with U+202F before the unit, and the frame's stamps
 * (`il y a 12 s`, `il y a 4 min`) were drawn with U+0020 on the same grid.
 */

import { catalogueValue } from "./catalogue";
import type { UiLocale } from "./locales";

/** Anything the app stores or receives as a point in time. */
export type Timestamp = string | number | Date | null | undefined;

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Epoch milliseconds, or `NaN` when the value cannot be read.
 *
 * SQLite's `CURRENT_TIMESTAMP` writes `2026-08-30 06:00:00` — no `T`, no zone
 * marker — and is UTC by contract, so that shape is normalised to an ISO UTC
 * instant first. Everything else goes through `Date.parse` unchanged.
 */
export function parseTimestamp(value: Timestamp): number {
  if (value === null || value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  return Date.parse(
    SQLITE_TIMESTAMP.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed,
  );
}

function nowMs(now: number | Date | undefined): number {
  if (now === undefined) return Date.now();
  return now instanceof Date ? now.getTime() : now;
}

/* ------------------------------------------------------------------ */
/* Relative time                                                       */
/* ------------------------------------------------------------------ */

export interface FormatRelativeOptions {
  locale: UiLocale;
  /** Injected by tests and by screens that tick on their own clock. */
  now?: number | Date;
  /**
   * `"minute"` (default): anything under a minute is the catalogue's
   * "just now". `"second"`: seconds are counted (`30s ago`), and only the
   * first five are "just now" — the desk's failure rows and the spec
   * footer's save stamp want to be seen moving.
   */
  precision?: "minute" | "second";
}

const RELATIVE_STYLES = new Set<Intl.RelativeTimeFormatStyle>(["long", "short", "narrow"]);
const NO_BREAK_SPACES = /[\u00A0\u202F]/g;

/** `Intl` output with its no-break spaces flattened to the frame's U+0020. */
function onMonoGrid(text: string): string {
  return text.replace(NO_BREAK_SPACES, " ");
}
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

/**
 * The `Intl.RelativeTimeFormat` style a locale renders its bands in — from
 * the catalogue (`Format.relativeStyle`), because it is locale data: English
 * `narrow` gives the frame's `5m ago` / `3h ago` / `2d ago`, whereas French
 * `narrow` is the unusable `-5 min` and `short` is the frame's `il y a 5 min`.
 */
function relativeFormatter(locale: UiLocale): Intl.RelativeTimeFormat {
  const style = catalogueValue(locale, "Format.relativeStyle") as Intl.RelativeTimeFormatStyle;
  const resolved = RELATIVE_STYLES.has(style) ? style : "narrow";
  const cacheKey = `${locale}:${resolved}`;
  let formatter = relativeFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { style: resolved, numeric: "always" });
    relativeFormatters.set(cacheKey, formatter);
  }
  return formatter;
}

/**
 * `just now` · `5m ago` · `3h ago` · `2d ago` (en) — `à l'instant` ·
 * `il y a 5 min` · `il y a 3 h` · `il y a 2 j` (fr). Empty string when the
 * timestamp cannot be read: the caller decides between hiding the stamp and
 * printing an em dash, and neither is this function's business.
 *
 * Whole units, floored, never a negative age: a row stamped slightly in the
 * future (clock skew between a SQLite write and the browser) is "just now".
 */
export function formatRelative(
  value: Timestamp,
  { locale, now, precision = "minute" }: FormatRelativeOptions,
): string {
  const then = parseTimestamp(value);
  if (!Number.isFinite(then)) return "";

  const seconds = Math.max(0, Math.floor((nowMs(now) - then) / 1000));
  const rtf = relativeFormatter(locale);

  if (seconds < 60) {
    if (precision === "second" && seconds >= 5) return onMonoGrid(rtf.format(-seconds, "second"));
    return catalogueValue(locale, "Format.justNow");
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return onMonoGrid(rtf.format(-minutes, "minute"));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return onMonoGrid(rtf.format(-hours, "hour"));
  return onMonoGrid(rtf.format(-Math.floor(hours / 24), "day"));
}

/* ------------------------------------------------------------------ */
/* Dates and times                                                     */
/* ------------------------------------------------------------------ */

/**
 * The shapes the interface prints. Named, so a call site says what it means
 * and two screens cannot drift into two spellings of the same stamp.
 *
 *   dateTime         Jan 5, 2026, 3:07 PM      the default stamp
 *   dateTimeSeconds  Jan 5, 2026, 3:07:12 PM   audit rows (was toLocaleString)
 *   date             Jan 5, 2026               (was toLocaleDateString)
 *   time             3:07:12 PM                (was toLocaleTimeString)
 *   dayTime          Jan 5, 03:07 PM           comment/session stamps
 *   clock            16:00                     the usage header's wall clock
 */
export type DateTimeStyle =
  | "dateTime"
  | "dateTimeSeconds"
  | "date"
  | "time"
  | "dayTime"
  | "clock";

const DATE_TIME_STYLES: Record<DateTimeStyle, Intl.DateTimeFormatOptions> = {
  dateTime: { dateStyle: "medium", timeStyle: "short" },
  dateTimeSeconds: { dateStyle: "medium", timeStyle: "medium" },
  date: { dateStyle: "medium" },
  time: { timeStyle: "medium" },
  dayTime: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  clock: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};

export interface FormatDateTimeOptions {
  locale: UiLocale;
  style?: DateTimeStyle;
  /** An IANA zone, when the stamp belongs to another clock than the browser's. */
  timeZone?: string;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** A calendar stamp in one of the named shapes. Empty string when unreadable. */
export function formatDateTime(
  value: Timestamp,
  { locale, style = "dateTime", timeZone }: FormatDateTimeOptions,
): string {
  const ms = parseTimestamp(value);
  if (!Number.isFinite(ms)) return "";
  const cacheKey = `${locale}:${style}:${timeZone ?? ""}`;
  let formatter = dateTimeFormatters.get(cacheKey);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(locale, {
        ...DATE_TIME_STYLES[style],
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      // An unknown zone name (a server elsewhere reporting something exotic)
      // must not blank the row: fall back to the browser's own clock.
      formatter = new Intl.DateTimeFormat(locale, DATE_TIME_STYLES[style]);
    }
    dateTimeFormatters.set(cacheKey, formatter);
  }
  return formatter.format(ms);
}

/**
 * `Aug 18` for a `YYYY-MM-DD` calendar key that is already a LOCAL date.
 * Parsed by hand on purpose: `new Date("2026-08-18")` is UTC midnight and
 * renders the previous day west of Greenwich. An unreadable key is returned
 * as it came, never as a fabricated date.
 */
export function formatDayLabel(date: string, locale: UiLocale): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return date;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
    new Date(year, month - 1, day),
  );
}

/* ------------------------------------------------------------------ */
/* Numbers and plurals                                                 */
/* ------------------------------------------------------------------ */

export type FormatNumberOptions = { locale: UiLocale } & Intl.NumberFormatOptions;

const NO_BREAK_GROUP = /^[\u00A0\u202F]$/;

/**
 * `1,240` (en) · `1 240` (fr, PLAIN U+0020 — see the header). Empty string
 * for anything that is not a finite number: an unavailable numeral is the
 * caller's em dash, never a `0`.
 */
export function formatNumber(value: number, { locale, ...options }: FormatNumberOptions): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat(locale, options)
    .formatToParts(value)
    .map((part) => (part.type === "group" && NO_BREAK_GROUP.test(part.value) ? " " : part.value))
    .join("");
}

/**
 * The CLDR plural category of a count — `one` / `other` in English, where
 * French also says `one` for zero. Copy that varies by count belongs in an
 * ICU `{count, plural, …}` message (see lib/i18n/catalogue.ts); this is for
 * the logic that has to branch on the category itself.
 */
export function pluralCategory(
  count: number,
  locale: UiLocale,
  type: Intl.PluralRuleType = "cardinal",
): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale, { type }).select(count);
}
