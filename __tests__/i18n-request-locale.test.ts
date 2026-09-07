/**
 * The per-request locale: the stored `ui_locale` row first, the browser's
 * `Accept-Language` second — and headers are read BEFORE the database so a
 * build-time prerender never opens the database to ask.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dbMockState,
  getDbChainMock,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

const requestState = vi.hoisted(() => ({
  acceptLanguage: null as string | null,
  headerReads: 0,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    requestState.headerReads += 1;
    return new Headers(
      requestState.acceptLanguage ? { "accept-language": requestState.acceptLanguage } : {},
    );
  },
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

describe("resolveRequestUiLocale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    requestState.acceptLanguage = null;
    requestState.headerReads = 0;
  });

  it("renders the stored ui_locale when one is set", async () => {
    dbMockState.getQueue = [{ value: JSON.stringify("fr") }];
    requestState.acceptLanguage = "en-US";
    const { resolveRequestUiLocale } = await import("@/lib/i18n/resolve-request-locale");
    expect(await resolveRequestUiLocale()).toBe("fr");
  });

  it("falls back to the browser language when nothing is stored", async () => {
    dbMockState.getQueue = [null];
    requestState.acceptLanguage = "en-GB,en;q=0.9";
    const { resolveRequestUiLocale } = await import("@/lib/i18n/resolve-request-locale");
    expect(await resolveRequestUiLocale()).toBe("en");
    expect(requestState.headerReads).toBe(1);
  });

  it("ignores a stored value that names no catalogue", async () => {
    dbMockState.getQueue = [{ value: JSON.stringify("tlh") }];
    requestState.acceptLanguage = "en";
    const { resolveRequestUiLocale } = await import("@/lib/i18n/resolve-request-locale");
    expect(await resolveRequestUiLocale()).toBe("en");
  });

  it("reads a row stored as a bare (non-JSON) string too", async () => {
    dbMockState.getQueue = [{ value: "fr" }];
    const { readStoredUiLocale } = await import("@/lib/i18n/resolve-request-locale");
    expect(readStoredUiLocale()).toBe("fr");
  });

  it("treats a failed database read as nothing stored, never as a 500", async () => {
    getDbChainMock().select.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    requestState.acceptLanguage = "en";
    const { resolveRequestUiLocale } = await import("@/lib/i18n/resolve-request-locale");
    expect(await resolveRequestUiLocale()).toBe("en");
  });
});
