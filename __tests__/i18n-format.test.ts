/**
 * The one formatting family (lib/i18n/format.ts): relative ages, calendar
 * stamps, numbers and plural categories, parameterised by locale.
 *
 * The English strings are the ones `timeAgo` and the desk/registry
 * `relativeAge` printed; the French ones are what `formatFrenchRelative` and
 * the chat roster printed. Both now come from one function.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatDateTime,
  formatDayLabel,
  formatNumber,
  formatRelative,
  parseTimestamp,
  pluralCategory,
} from "@/lib/i18n/format";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("parseTimestamp", () => {
  it("reads ISO, epoch, Date and SQLite's zone-less UTC stamps", () => {
    expect(parseTimestamp("2026-08-28T11:39:00.000Z")).toBe(NOW - 21 * MIN);
    expect(parseTimestamp(NOW)).toBe(NOW);
    expect(parseTimestamp(new Date(NOW))).toBe(NOW);
    expect(parseTimestamp("2026-08-28 11:39:00")).toBe(NOW - 21 * MIN);
    expect(parseTimestamp("2026-08-28 11:39:00.500")).toBe(NOW - 21 * MIN + 500);
  });

  it("is NaN for nothing, blanks and garbage", () => {
    for (const value of [null, undefined, "", "   ", "not a date"]) {
      expect(Number.isNaN(parseTimestamp(value))).toBe(true);
    }
  });
});

describe("formatRelative — en", () => {
  const en = (value: string | null, precision?: "minute" | "second") =>
    formatRelative(value, { locale: "en", now: NOW, precision });

  it("prints timeAgo's shapes: just now, Xm ago, Xh ago, Xd ago", () => {
    expect(en(ago(0))).toBe("just now");
    expect(en(ago(59_000))).toBe("just now");
    expect(en(ago(5 * MIN))).toBe("5m ago");
    expect(en(ago(1 * MIN))).toBe("1m ago");
    expect(en(ago(3 * HOUR))).toBe("3h ago");
    expect(en(ago(1 * HOUR))).toBe("1h ago");
    expect(en(ago(2 * DAY))).toBe("2d ago");
    expect(en(ago(1 * DAY))).toBe("1d ago");
    expect(en(ago(400 * DAY))).toBe("400d ago");
  });

  it("counts seconds at second precision, but never says 0s ago", () => {
    expect(en(ago(30_000), "second")).toBe("30s ago");
    expect(en(ago(5_000), "second")).toBe("5s ago");
    expect(en(ago(4_000), "second")).toBe("just now");
    expect(en(ago(21 * MIN), "second")).toBe("21m ago");
  });

  it("floors whole units, so 59m59s is still 59m ago and not 60m ago", () => {
    expect(en(ago(59 * MIN + 59_000))).toBe("59m ago");
    expect(en(ago(23 * HOUR + 59 * MIN))).toBe("23h ago");
  });

  it("reads SQLite stamps as UTC and clock skew as just now", () => {
    expect(en("2026-08-28 11:39:00")).toBe("21m ago");
    expect(en(new Date(NOW + 30_000).toISOString())).toBe("just now");
  });

  it("is empty for an unreadable timestamp — the caller owns the em dash", () => {
    expect(en(null)).toBe("");
    expect(en("not a date")).toBe("");
    expect(formatRelative(undefined, { locale: "en", now: NOW })).toBe("");
  });

  it("defaults now to the wall clock", () => {
    expect(formatRelative(new Date().toISOString(), { locale: "en" })).toBe("just now");
  });
});

describe("formatRelative — fr (the seed)", () => {
  const fr = (value: string | null, precision?: "minute" | "second") =>
    formatRelative(value, { locale: "fr", now: NOW, precision });

  it("prints formatFrenchRelative's shapes from Intl's short style", () => {
    expect(fr(ago(0))).toBe("à l'instant");
    expect(fr(ago(12_000), "second")).toBe("il y a 12 s");
    expect(fr(ago(90_000))).toBe("il y a 1 min");
    expect(fr(ago(4 * MIN))).toBe("il y a 4 min");
    expect(fr(ago(3 * HOUR))).toBe("il y a 3 h");
    expect(fr(ago(50 * HOUR))).toBe("il y a 2 j");
  });

  it("never prints the narrow style's unusable `-5 min`", () => {
    expect(fr(ago(5 * MIN))).not.toMatch(/^-/);
  });

  it("flattens Intl's no-break space before the unit to the frame's plain space", () => {
    // Node's ICU writes U+00A0 here (and U+202F in number grouping); either
    // one leaves the mono grid, so both are flattened.
    expect(new Intl.RelativeTimeFormat("fr", { style: "short" }).format(-12, "second")).toMatch(
      /[\u00a0\u202f]/,
    );
    expect(fr(ago(12_000), "second")).toBe("il y a 12 s");
    expect(fr(ago(12_000), "second")).not.toMatch(/[\u00a0\u202f]/);
  });
});

describe("formatDateTime", () => {
  const stamp = "2026-01-05T15:07:12.000Z";
  const opts = { locale: "en" as const, timeZone: "UTC" };

  it("prints the named shapes", () => {
    expect(formatDateTime(stamp, { ...opts })).toBe("Jan 5, 2026, 3:07 PM");
    expect(formatDateTime(stamp, { ...opts, style: "dateTimeSeconds" })).toBe("Jan 5, 2026, 3:07:12 PM");
    expect(formatDateTime(stamp, { ...opts, style: "date" })).toBe("Jan 5, 2026");
    expect(formatDateTime(stamp, { ...opts, style: "time" })).toBe("3:07:12 PM");
    expect(formatDateTime(stamp, { ...opts, style: "dayTime" })).toBe("Jan 5, 03:07 PM");
    expect(formatDateTime(stamp, { ...opts, style: "clock" })).toBe("15:07");
  });

  it("follows the locale", () => {
    expect(formatDateTime(stamp, { locale: "fr", timeZone: "UTC" })).toBe("5 janv. 2026, 15:07");
    expect(formatDateTime(stamp, { locale: "fr", timeZone: "UTC", style: "clock" })).toBe("15:07");
  });

  it("honours a zone and survives an unknown one", () => {
    expect(formatDateTime(stamp, { ...opts, style: "clock", timeZone: "Asia/Tokyo" })).toBe("00:07");
    expect(formatDateTime(stamp, { locale: "en", style: "clock", timeZone: "Mars/Olympus" })).toMatch(/^\d{2}:\d{2}$/);
  });

  it("reads SQLite stamps and is empty for garbage", () => {
    expect(formatDateTime("2026-01-05 15:07:12", { ...opts, style: "clock" })).toBe("15:07");
    expect(formatDateTime(null, opts)).toBe("");
    expect(formatDateTime("nope", opts)).toBe("");
  });
});

describe("formatDayLabel", () => {
  it("prints a local calendar key as a short day, per locale", () => {
    expect(formatDayLabel("2026-08-18", "en")).toBe("Aug 18");
    expect(formatDayLabel("2026-08-18", "fr")).toBe("18 août");
    expect(formatDayLabel("2026-01-01", "en")).toBe("Jan 1");
  });

  it("returns an unreadable key as it came", () => {
    expect(formatDayLabel("2026-13-01", "en")).toBe("2026-13-01");
    expect(formatDayLabel("yesterday", "en")).toBe("yesterday");
  });
});

describe("formatNumber", () => {
  it("groups English thousands with a comma", () => {
    expect(formatNumber(1240, { locale: "en" })).toBe("1,240");
    expect(formatNumber(1234567, { locale: "en" })).toBe("1,234,567");
    expect(formatNumber(999, { locale: "en" })).toBe("999");
  });

  it("rewrites the French narrow no-break group separator to a PLAIN space", () => {
    const grouped = formatNumber(1234567, { locale: "fr" });
    expect(grouped).toBe("1 234 567");
    expect(grouped).not.toContain("\u202f");
    expect(grouped).not.toContain("\u00a0");
    // Proof that the rewrite is needed at all: Intl itself emits U+202F.
    expect(new Intl.NumberFormat("fr").format(1234567)).toContain("\u202f");
  });

  it("passes Intl options through and keeps the decimal separator", () => {
    expect(formatNumber(1234.5, { locale: "fr", minimumFractionDigits: 1 })).toBe("1 234,5");
    expect(formatNumber(0.256, { locale: "en", style: "percent" })).toBe("26%");
  });

  it("is empty for a non-finite value — never a fabricated zero", () => {
    expect(formatNumber(Number.NaN, { locale: "en" })).toBe("");
    expect(formatNumber(Number.POSITIVE_INFINITY, { locale: "en" })).toBe("");
  });
});

describe("pluralCategory", () => {
  it("answers CLDR categories per locale", () => {
    expect(pluralCategory(1, "en")).toBe("one");
    expect(pluralCategory(0, "en")).toBe("other");
    expect(pluralCategory(2, "en")).toBe("other");
    expect(pluralCategory(0, "fr")).toBe("one");
    expect(pluralCategory(1, "fr")).toBe("one");
    expect(pluralCategory(2, "fr")).toBe("other");
    expect(pluralCategory(2, "en", "ordinal")).toBe("two");
  });
});

describe("the agent-facing sites stay pinned to en-US", () => {
  const ROOT = path.resolve(__dirname, "..");
  const PINNED = [
    "lib/providers/prompt-transport.ts",
    "lib/claude/prompt-sections.ts",
    "lib/agent-sessions/chunk-cap.ts",
    "lib/agent-sessions/chunk-retention.ts",
    "lib/agent-sessions/prompt-cap.ts",
  ];

  it.each(PINNED)("%s formats its numerals with an explicit en-US and says why", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    expect(source).toMatch(/toLocaleString\(\s*"en-US"/);
    expect(source).not.toContain("@/lib/i18n/format");
    expect(source).toMatch(/interface locale/i);
  });

  it("leaves no variant of the retired formatters behind", () => {
    const gone = [
      "lib/utils/format-date.ts",
      "components/chat-page/relative-age.ts",
    ];
    for (const file of gone) {
      expect(() => readFileSync(path.join(ROOT, file))).toThrow();
    }
    for (const file of [
      "components/desk/AttentionRow.tsx",
      "lib/tickets-registry/aggregate.ts",
      "components/spec/spec-format.ts",
      "components/piscine/TopBarMenu.tsx",
      "components/usage/formatters.ts",
    ]) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(/export function relativeAge\(/);
      expect(source, file).not.toMatch(/function plural\(/);
      expect(source, file).not.toMatch(/formatFrenchRelative|formatRelativeAge|toLocale(Date|Time)?String\(/);
    }
  });
});
