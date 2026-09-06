import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";

/**
 * B-arij-203 — the two inputs that stripped the focus outline and declared
 * nothing, measured where a ring is either painted or is not: Chrome.
 *
 *   the ⌘K command-palette search field   components/desk/DeskCommandPalette.tsx
 *   the sessions "Filter by ticket" field app/projects/[projectId]/sessions/page.tsx
 *
 * A DIFFERENT DEFECT from `e2e/focus-ring.spec.ts`, which measures the TopBar's
 * controls: those declared a ring that Tailwind v4's `outline-none` stopped
 * painting. These declared no ring at all. `outline-none` (and, on the sessions
 * field, `focus:outline-none`) removed the browser's own default focus ring and
 * put nothing in its place, so a keyboard user landing on either field saw no
 * indication whatsoever of where they were.
 *
 * WHAT WAS MEASURED HERE BEFORE THE FIX (2026-09-05, Chrome via
 * `channel: "chrome"`, viewport 1440×950):
 *
 *   {"testId":"desk-command-input","matchesFocusVisible":true,
 *    "outlineStyle":"none","outlineWidth":"0px"}
 *   {"label":"Filter by ticket","matchesFocusVisible":true,
 *    "outlineStyle":"none","outlineWidth":"0px"}
 *
 * WHY BOTH THEMES. The ring's colour is `--color-ring`, and day and night give
 * it different values; a ring that resolves against the wrong ground is
 * invisible in exactly one of them. The unit files resolve that colour from
 * `app/globals.css` per theme too (`__tests__/focus-ring-color.test.ts`), but
 * only as a literal — that it is not `transparent` and not a token one theme
 * forgot. Whether it is visible against the ground the field actually sits on
 * is a claim about a rendered page, and that claim is this spec's alone.
 *
 * KEYBOARD FOCUS, NOT `.focus()`. `:focus-visible` is a heuristic on how the
 * element took focus. Only real `Tab` presses put Chrome in the state the bug
 * is about, so this spec tabs.
 */

/** next-themes: `attribute="class"`, default storage key, `defaultTheme="dark"`. */
const THEMES = [
  { name: "night", stored: "dark" },
  { name: "day", stored: "light" },
] as const;

interface FocusReading {
  testId: string | null;
  label: string | null;
  matchesFocusVisible: boolean;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  outlineOffset: string;
  /** The Tailwind v4 variable `outline-<width>` resolves its style through. */
  outlineStyleVar: string;
}

async function readFocused(page: Page): Promise<FocusReading | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;

    const style = getComputedStyle(active);
    return {
      testId: active.getAttribute("data-testid"),
      label: active.getAttribute("aria-label") ?? active.getAttribute("placeholder"),
      matchesFocusVisible: active.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyleVar: style.getPropertyValue("--tw-outline-style").trim(),
    };
  });
}

/** Tab until `predicate` holds for the focused element, or give up. */
async function tabUntil(
  page: Page,
  predicate: (reading: FocusReading) => boolean,
  budget = 40,
): Promise<FocusReading | null> {
  for (let i = 0; i < budget; i++) {
    await page.keyboard.press("Tab");
    const reading = await readFocused(page);
    if (reading && predicate(reading)) return reading;
  }
  return null;
}

/**
 * The defect, verbatim: `:focus-visible` matched and `outline-style` stayed
 * `none`, so nothing was drawn.
 */
function expectPaintedRing(reading: FocusReading | null, where: string) {
  expect(reading, `${where}: the field never took focus`).not.toBeNull();

  // Guards the assertion below: without :focus-visible, "no ring" would be
  // correct behaviour rather than the defect.
  expect(
    reading!.matchesFocusVisible,
    `${where} did not match :focus-visible, so the ring assertion would be vacuous`,
  ).toBe(true);

  expect(
    reading!.outlineStyle,
    `${where} matched :focus-visible with outline-width ${reading!.outlineWidth} ` +
      `and outline-color ${reading!.outlineColor}, but outline-style is ` +
      `"${reading!.outlineStyle}" (--tw-outline-style: "${reading!.outlineStyleVar}") ` +
      `— nothing is painted`,
  ).toBe("solid");

  expect(
    parseFloat(reading!.outlineWidth),
    `${where}: outline-width is ${reading!.outlineWidth}`,
  ).toBeGreaterThanOrEqual(2);

  // A ring the same colour as what it sits on is not a ring. `--color-ring`
  // is opaque in both themes; a fully transparent outline would still report
  // style `solid`, so this is the assertion that catches a bad theme value.
  expect(
    reading!.outlineColor,
    `${where}: outline-color is ${reading!.outlineColor}`,
  ).not.toMatch(/rgba\([^)]*,\s*0\)$/);
}

for (const theme of THEMES) {
  test.describe(`focus rings on the two undeclared inputs — ${theme.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((stored) => {
        window.localStorage.setItem("theme", stored);
      }, theme.stored);
      await page.setViewportSize({ width: 1440, height: 950 });
    });

    test("the ⌘K search field paints a ring", async ({ page, project }) => {
      await page.goto(project.boardUrl);
      await expect(page.getByTestId("top-bar")).toBeVisible();
      // The whole point of running twice: prove the two runs really are two
      // different grounds, not the same one measured twice.
      const isNight = await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      expect(isNight, `${theme.name} did not apply`).toBe(
        theme.stored === "dark",
      );

      await page.getByTestId("top-bar-search").click();
      const input = page.getByTestId("desk-command-input");
      await expect(input).toBeVisible();

      // The palette autofocuses its input, but a focus the page moved is not
      // the keyboard focus the bug is about. Leave, then tab back in.
      await page.keyboard.press("Escape");
      await page.getByTestId("top-bar-search").click();
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );

      const reading = await tabUntil(
        page,
        (r) => r.testId === "desk-command-input",
      );
      expectPaintedRing(reading, `⌘K search field (${theme.name})`);

      await page.screenshot({
        path: `e2e/test-results/focus-ring-command-palette-${theme.name}.png`,
      });
    });

    test("the sessions ticket filter paints a ring", async ({
      page,
      project,
    }) => {
      await page.goto(`/projects/${project.id}/sessions`);
      const input = page.getByTestId("sessions-ticket-filter");
      await expect(input).toBeVisible();

      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );

      const reading = await tabUntil(
        page,
        (r) => r.testId === "sessions-ticket-filter",
        60,
      );
      expectPaintedRing(reading, `sessions ticket filter (${theme.name})`);

      await page.screenshot({
        path: `e2e/test-results/focus-ring-sessions-filter-${theme.name}.png`,
      });
    });
  });
}
