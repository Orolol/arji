/**
 * `app/settings/layout.tsx` proves the server-component half of the copy
 * pattern: `SETTINGS_TABS` is a module-scope table of catalogue KEY
 * REFERENCES, and the layout resolves them with `getTranslations()` while
 * staying a server component — no "use client".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { resetTestUiLocale, setTestUiLocale } from "@/__tests__/support/next-intl-mock";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/integrations",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const SOURCE = readFileSync(
  path.resolve(__dirname, "..", "app", "settings", "layout.tsx"),
  "utf8",
);

async function renderSettingsLayout() {
  const { default: SettingsLayout } = await import("@/app/settings/layout");
  const tree = await SettingsLayout({ children: <p>body</p> });
  return render(tree);
}

describe("app/settings/layout.tsx", () => {
  afterEach(() => {
    resetTestUiLocale();
  });

  it("stays a server component and holds key references, not copy", () => {
    expect(SOURCE).not.toMatch(/^"use client"/m);
    expect(SOURCE).toContain("getTranslations");
    expect(SOURCE).toContain('labelKey: "Settings.tabs.integrations"');
    expect(SOURCE).not.toContain("Intégrations");
    expect(SOURCE).not.toContain("Apparence");
  });

  it("draws the five tabs from the English catalogue", async () => {
    await renderSettingsLayout();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Workspace",
      "Agents",
      "Pipeline",
      "Integrations",
      "Appearance",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/settings",
      "/agents",
      "/settings/pipeline",
      "/settings/integrations",
      "/settings/appearance",
    ]);
    expect(screen.getByText("Integrations")).toHaveAttribute("aria-current", "page");
  });

  it("renders the French seed under fr, falling back to English where the seed is silent", async () => {
    setTestUiLocale("fr");
    await renderSettingsLayout();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Workspace",
      "Agents",
      "Pipeline",
      "Intégrations",
      "Apparence",
    ]);
  });
});
