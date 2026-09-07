/**
 * How the interface locale is chosen: a stored `ui_locale` when it names a
 * catalogue, else the browser language negotiated against the locales whose
 * catalogue is complete, else English. See lib/i18n/locales.ts.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_UI_LOCALE,
  NEGOTIABLE_UI_LOCALES,
  UI_LOCALES,
  UI_LOCALE_SETTING_KEY,
  isUiLocale,
  negotiateUiLocale,
  resolveUiLocale,
} from "@/lib/i18n/locales";

describe("the locale set", () => {
  it("is en (source) and fr (seed), stored under ui_locale", () => {
    expect(UI_LOCALES).toEqual(["en", "fr"]);
    expect(DEFAULT_UI_LOCALE).toBe("en");
    expect(UI_LOCALE_SETTING_KEY).toBe("ui_locale");
  });

  it("only offers complete catalogues to the browser language", () => {
    // `fr` is a partial seed until the follow-up epic completes it; picking
    // it automatically would ship the mixed interface again.
    expect(NEGOTIABLE_UI_LOCALES).toEqual(["en"]);
    for (const locale of NEGOTIABLE_UI_LOCALES) expect(UI_LOCALES).toContain(locale);
  });

  it("recognises exactly the catalogue locales", () => {
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("fr")).toBe(true);
    expect(isUiLocale("de")).toBe(false);
    expect(isUiLocale("")).toBe(false);
    expect(isUiLocale(null)).toBe(false);
    expect(isUiLocale({ locale: "en" })).toBe(false);
  });
});

describe("negotiateUiLocale", () => {
  const both = ["en", "fr"] as const;

  it("matches a range on its base language", () => {
    expect(negotiateUiLocale("fr-CA,fr;q=0.9,en;q=0.8", both)).toBe("fr");
    expect(negotiateUiLocale("en-GB", both)).toBe("en");
  });

  it("orders ranges by q weight, then by position", () => {
    expect(negotiateUiLocale("en-GB;q=0.8, fr;q=0.9", both)).toBe("fr");
    expect(negotiateUiLocale("en, fr", both)).toBe("en");
    expect(negotiateUiLocale("fr;q=0, en;q=0.5", both)).toBe("en");
  });

  it("skips languages with no catalogue and falls back to English", () => {
    expect(negotiateUiLocale("de-DE,de;q=0.9,fr;q=0.8", both)).toBe("fr");
    expect(negotiateUiLocale("de-DE,ja", both)).toBe("en");
    expect(negotiateUiLocale("*", both)).toBe("en");
  });

  it("never picks a locale that is not offered, whatever the browser says", () => {
    expect(negotiateUiLocale("fr-FR,fr;q=0.9")).toBe("en");
    expect(negotiateUiLocale("fr", ["en"])).toBe("en");
  });

  it("survives garbage and absence", () => {
    expect(negotiateUiLocale(null)).toBe("en");
    expect(negotiateUiLocale(undefined)).toBe("en");
    expect(negotiateUiLocale("")).toBe("en");
    expect(negotiateUiLocale(";;;,,,q=", both)).toBe("en");
    expect(negotiateUiLocale("fr;q=abc", both)).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("lets a stored catalogue locale win over the browser", () => {
    expect(resolveUiLocale({ stored: "fr", acceptLanguage: "en-US" })).toBe("fr");
    expect(resolveUiLocale({ stored: "en", acceptLanguage: "fr-FR" })).toBe("en");
  });

  it("falls through to the browser language when nothing valid is stored", () => {
    expect(resolveUiLocale({ stored: null, acceptLanguage: "en-GB" })).toBe("en");
    expect(resolveUiLocale({ stored: "klingon", acceptLanguage: "en" })).toBe("en");
    expect(resolveUiLocale({ stored: undefined, acceptLanguage: null })).toBe("en");
  });
});
