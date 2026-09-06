/**
 * The `next-intl` stand-in every vitest file gets (wired in vitest.setup.ts).
 *
 * WHY A MOCK. `useTranslations` and friends read React context that only
 * `NextIntlClientProvider` provides, and the provider is mounted once by
 * `app/layout.tsx` — a component test renders below it, never through it.
 * Wrapping ~150 render() calls would be the honest alternative; instead the
 * hooks here resolve against the REAL catalogue with next-intl's own
 * `createTranslator`, so a rendered component shows the English copy the app
 * shows, a missing key throws instead of printing its dotted path, and ICU
 * plurals/arguments format exactly as in the browser.
 *
 * WHAT IT DOES NOT PROVE: that the provider is mounted and the request config
 * resolves. `__tests__/i18n-root-layout.test.tsx` and the Playwright suite
 * cover that path against the real modules.
 *
 * Locale is a mutable test state, `"en"` by default. A test that wants the
 * French seed calls `setTestUiLocale("fr")` and resets in `afterEach`.
 */
import { Fragment, createElement, type ReactNode } from "react";

import { messagesFor } from "@/lib/i18n/catalogue";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";

type ActualNextIntl = typeof import("next-intl");

export const intlTestState: { locale: UiLocale } = { locale: DEFAULT_UI_LOCALE };

export function setTestUiLocale(locale: UiLocale): void {
  intlTestState.locale = locale;
}

export function resetTestUiLocale(): void {
  intlTestState.locale = DEFAULT_UI_LOCALE;
}

/**
 * The overrides laid over the real module. `actual` supplies
 * `createTranslator` / `createFormatter`, which are pure and context-free.
 */
export function buildNextIntlMock(actual: ActualNextIntl) {
  const translator = (namespace?: string) =>
    actual.createTranslator({
      locale: intlTestState.locale,
      messages: messagesFor(intlTestState.locale),
      // A missing key is a test failure, not a console line: the catalogue is
      // the contract and a component asking for a key it lacks is the bug.
      onError: (error) => {
        throw error;
      },
      ...(namespace ? { namespace: namespace as never } : {}),
    });

  const formatter = () => actual.createFormatter({ locale: intlTestState.locale });

  return {
    useTranslations: (namespace?: string) => translator(namespace),
    useLocale: () => intlTestState.locale,
    useMessages: () => messagesFor(intlTestState.locale),
    useFormatter: () => formatter(),
    useNow: () => new Date(),
    useTimeZone: () => undefined,
    NextIntlClientProvider: ({ children }: { children?: ReactNode }) =>
      createElement(Fragment, null, children),
  };
}

/** The `next-intl/server` half — the same translator, behind promises. */
export function buildNextIntlServerMock(actual: ActualNextIntl) {
  const client = buildNextIntlMock(actual);
  return {
    getTranslations: async (
      arg?: string | { locale?: UiLocale; namespace?: string },
    ) => {
      const namespace = typeof arg === "string" ? arg : arg?.namespace;
      return client.useTranslations(namespace);
    },
    getLocale: async () => intlTestState.locale,
    getMessages: async () => messagesFor(intlTestState.locale),
    getFormatter: async () => client.useFormatter(),
    getNow: async () => new Date(),
    getTimeZone: async () => undefined,
    getRequestConfig: <T>(create: T) => create,
    setRequestLocale: () => undefined,
  };
}
