/**
 * `app/layout.tsx` mounts the translation provider next to `ThemeProvider`
 * and writes the RESOLVED locale on `<html lang>` — no more hardcoded "en".
 *
 * The layout is an async server component, so it is called as a function
 * and its element tree rendered to static markup. `next-intl/server` is the
 * test stand-in (vitest.setup.ts), whose locale a test can set; the chrome
 * below the provider is stubbed because the subject here is the shell.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { resetTestUiLocale, setTestUiLocale } from "@/__tests__/support/next-intl-mock";

vi.mock("next/font/google", () => {
  const font = (name: string) => () => ({ variable: `--font-${name}` });
  return {
    Bricolage_Grotesque: font("bricolage"),
    Instrument_Sans: font("instrument"),
    Space_Mono: font("space-mono"),
  };
});

vi.mock("@/components/piscine", () => ({
  TopBar: () => <header data-testid="top-bar-stub" />,
}));

vi.mock("@/components/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
}));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="intl-provider">{children}</div>
    ),
  };
});

async function renderLayout() {
  const { default: RootLayout } = await import("@/app/layout");
  const tree = await RootLayout({ children: <main data-testid="page" /> });
  return renderToStaticMarkup(tree);
}

describe("app/layout.tsx", () => {
  afterEach(() => {
    resetTestUiLocale();
  });

  it("writes the resolved locale on <html lang>", async () => {
    expect(await renderLayout()).toMatch(/^<html lang="en"/);
    setTestUiLocale("fr");
    expect(await renderLayout()).toMatch(/^<html lang="fr"/);
  });

  it("mounts the translation provider around ThemeProvider, on every route", async () => {
    const html = await renderLayout();
    const provider = html.indexOf('data-testid="intl-provider"');
    const theme = html.indexOf('data-testid="theme-provider"');
    const page = html.indexOf('data-testid="page"');
    expect(provider).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(provider);
    expect(page).toBeGreaterThan(theme);
  });
});
