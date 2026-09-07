import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";

/**
 * B-arij-JJ5FdaHpX7d6 — the keyboard focus ring, measured where it is painted.
 *
 * This is the half of the fix that `__tests__/focus-ring-paints.test.tsx`
 * cannot do. jsdom loads no CSS and has no cascade for custom properties, so
 * the unit file compiles the class lists with the real Tailwind engine and
 * resolves `outline-style` out of band. Whether Chrome then actually paints a
 * ring is a visual claim and needs Chrome.
 *
 * WHAT WAS MEASURED HERE BEFORE THE FIX (2026-09-05, viewport 1440×950, route
 * /tickets, Chrome via `channel: "chrome"`), tabbing off the Work pill:
 *
 *   {"id":"top-bar-bubble-chat","matchesFocusVisible":true,
 *    "outline":"rgb(111, 203, 180) none 2px","outlineOffset":"2px"}
 *
 * `:focus-visible` matched, the colour and the width were applied, and
 * `outline-style` was still `none` — Tailwind v4's `outline-none` sets
 * `--tw-outline-style: none`, and `outline-2` resolves `outline-style` through
 * that same variable. Nothing was drawn on any control of the bar:
 *
 *   top-bar-bubble-now / -work / -chat / -agents / top-bar-new / top-bar-inbox
 *   all reported outlineStyle=none, --tw-outline-style=none
 *
 * KEYBOARD FOCUS, NOT `.focus()`. `:focus-visible` is a heuristic on how the
 * element got focus: a script calling `element.focus()` on a button does not
 * necessarily match it, and a mouse click deliberately does not. Only real
 * `Tab` presses put the browser in the state the bug is about, so this spec
 * tabs through the bar rather than focusing by hand.
 *
 * THE BAR IS SHARED CHROME, so this is swept on more than one route: a
 * regression that only showed on `/agents` would still be on every screen.
 */

/** The bar is mounted by `app/layout.tsx`; these three prove "every screen". */
const ROUTES = ["/", "/agents", "/tickets"] as const;

/** The controls named in the bug report. */
const CONTROLS = [
  "top-bar-bubble-now",
  "top-bar-bubble-work",
  "top-bar-bubble-chat",
  "top-bar-bubble-agents",
  "top-bar-new",
  "top-bar-inbox",
] as const;

/** How many `Tab` presses to spend looking for the bar's controls. */
const TAB_BUDGET = 40;

interface FocusReading {
  testId: string;
  matchesFocusVisible: boolean;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  /** The Tailwind v4 variable `outline-<width>` resolves its style through. */
  outlineStyleVar: string;
}

/** Read the computed outline of whatever currently has focus. */
async function readFocused(page: Page): Promise<FocusReading | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const testId = active?.getAttribute("data-testid");
    if (!active || !testId) return null;

    const style = getComputedStyle(active);
    return {
      testId,
      matchesFocusVisible: active.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineStyleVar: style.getPropertyValue("--tw-outline-style").trim(),
    };
  });
}

/**
 * Tab forward from the top of the document, collecting a reading for each of
 * the bar's controls the first time it takes focus.
 */
async function tabThroughBar(page: Page): Promise<Map<string, FocusReading>> {
  const wanted = new Set<string>(CONTROLS);
  const seen = new Map<string, FocusReading>();

  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  for (let i = 0; i < TAB_BUDGET && seen.size < wanted.size; i++) {
    await page.keyboard.press("Tab");
    const reading = await readFocused(page);
    if (reading && wanted.has(reading.testId) && !seen.has(reading.testId)) {
      seen.set(reading.testId, reading);
    }
  }
  return seen;
}

test.describe("TopBar — keyboard focus paints a visible ring", () => {
  test("every control draws its outline under :focus-visible", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });

    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.getByTestId("top-bar")).toBeVisible();
      // Every control the sweep looks for has to be in the DOM before tabbing,
      // or a missing one reads as "never focused" rather than as a failure.
      for (const testId of CONTROLS) {
        await expect(page.getByTestId(testId)).toBeVisible();
      }

      const readings = await tabThroughBar(page);

      for (const testId of CONTROLS) {
        const reading = readings.get(testId);
        expect(
          reading,
          `${route}: ${testId} never took focus within ${TAB_BUDGET} Tab presses`,
        ).toBeDefined();

        const where = `${route}: ${testId}`;
        // Guards the assertion below: if the browser did not consider this a
        // keyboard focus, "no ring" would be correct rather than a defect.
        expect(
          reading!.matchesFocusVisible,
          `${where} did not match :focus-visible, so the ring assertion below ` +
            `would be vacuous`,
        ).toBe(true);

        // The defect, verbatim: style `none` while width and colour applied.
        expect(
          reading!.outlineStyle,
          `${where} matched :focus-visible with outline-color ` +
            `${reading!.outlineColor} and outline-width ${reading!.outlineWidth}, ` +
            `but outline-style is "${reading!.outlineStyle}" ` +
            `(--tw-outline-style: "${reading!.outlineStyleVar}"), so nothing is painted`,
        ).toBe("solid");
        expect(
          parseFloat(reading!.outlineWidth),
          `${where}: outline-width is ${reading!.outlineWidth}`,
        ).toBeGreaterThanOrEqual(2);

        // A ring the same colour as what it sits on is not a ring, and a fully
        // transparent one still reports style `solid` and a 2px width. The
        // unit sweep resolves this colour from app/globals.css in both themes
        // (__tests__/focus-ring-color.test.ts); this is the reading of it
        // against a real ground, in the default theme (night — see
        // e2e/focus-ring-inputs.spec.ts for both themes on two inputs).
        expect(
          reading!.outlineColor,
          `${where}: outline-color is ${reading!.outlineColor}`,
        ).not.toMatch(/rgba\([^)]*,\s*0\)$/);
      }
    }
  });
});
