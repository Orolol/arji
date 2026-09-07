import { expect, test, type Page } from "@playwright/test";

/**
 * The composite agent's workshop surface, measured where the claims live.
 *
 * Two of this story's acceptance criteria cannot be met in jsdom, and the
 * project's own history says why:
 *
 *  - A FOCUS RING IS A VISUAL CLAIM. A unit sweep that asserts a
 *    `focus-visible:` class is present proves the token was written, never
 *    that anything is painted — Tailwind v4's `outline-none` sets
 *    `--tw-outline-style: none`, and `outline-2` resolves `outline-style`
 *    through that same variable, so a control can match `:focus-visible` with
 *    the right colour and width and still draw nothing (measured on TopBar,
 *    2026-09-05). Only a real browser reading computed style can tell the
 *    difference, and it has to read it in BOTH themes: the ring's colour comes
 *    from `--ring` in app/globals.css, which has a `:root` value and a `.dark`
 *    value that fail independently.
 *
 *  - HORIZONTAL OVERFLOW AT 390px is a layout claim about the real cascade.
 *
 * KEYBOARD FOCUS, NOT `.focus()`: `:focus-visible` is a heuristic on HOW the
 * element took focus, and a scripted `focus()` on a button does not reliably
 * match it. This spec presses Tab.
 *
 * The agents this creates are GLOBAL rows, not project-scoped, so every name
 * is suffixed with a per-run token and every assertion is scoped to the
 * composite this spec made. A workspace-wide count would be a race against
 * every other spec and every agent session sharing the database.
 */

/** next-themes: `attribute="class"`, default storage key, `defaultTheme="dark"`. */
const THEMES = [
  { name: "night", stored: "dark" },
  { name: "day", stored: "light" },
] as const;

/** The controls this story added, all inside the composite's member band. */
interface Composite {
  id: string;
  name: string;
  memberIds: string[];
}

interface FocusReading {
  testId: string | null;
  matchesFocusVisible: boolean;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  outlineStyleVar: string;
}

async function readFocused(page: Page): Promise<FocusReading | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const style = getComputedStyle(active);
    return {
      testId: active.getAttribute("data-testid"),
      matchesFocusVisible: active.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineStyleVar: style.getPropertyValue("--tw-outline-style").trim(),
    };
  });
}

function expectPaintedRing(reading: FocusReading | null, where: string) {
  expect(reading, `${where}: never took focus`).not.toBeNull();

  // Guards the assertion below: without :focus-visible, "no ring" would be
  // correct behaviour rather than a defect.
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

  // A fully transparent ring still reports style `solid` and a 2px width, so
  // this is the assertion that catches a bad per-theme token value.
  expect(
    reading!.outlineColor,
    `${where}: outline-color is ${reading!.outlineColor}`,
  ).not.toMatch(/rgba\([^)]*,\s*0\)$/);
}

/**
 * Tab forward until `testId` takes focus, then read its computed outline.
 * Restarts from the document top so each control is reached the way a
 * keyboard user reaches it.
 */
async function tabTo(
  page: Page,
  testId: string,
  budget = 60,
): Promise<FocusReading | null> {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < budget; i++) {
    await page.keyboard.press("Tab");
    const reading = await readFocused(page);
    if (reading?.testId === testId) return reading;
  }
  return null;
}

/** Two simple agents and a composite over them, created through the real API. */
async function seedComposite(page: Page, token: string): Promise<Composite> {
  const memberIds: string[] = [];
  for (const member of [
    { name: `E2E First ${token}`, provider: "codex", model: "gpt-5.4" },
    { name: `E2E Second ${token}`, provider: "agy", model: "gemini-3-pro" },
  ]) {
    const response = await page.request.post("/api/agent-config/named-agents", {
      data: member,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    memberIds.push((await response.json()).data.id);
  }

  const name = `E2E Ladder ${token}`;
  const response = await page.request.post("/api/agent-config/named-agents", {
    data: { kind: "composite", name, memberIds },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { id: (await response.json()).data.id, name, memberIds };
}

/** Open /agents and select the composite this run created, by its own name. */
async function openComposite(page: Page, composite: Composite): Promise<void> {
  await page.goto("/agents");
  const card = page.getByTestId("agent-roster").getByRole("button", {
    name: composite.name,
    exact: true,
  });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("composite-member-list")).toBeVisible();
}

let runToken = "";
test.beforeEach(() => {
  runToken = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
});

for (const theme of THEMES) {
  test.describe(`composite member controls paint a focus ring — ${theme.name}`, () => {
    test("every control this story added draws its outline under :focus-visible", async ({
      page,
    }) => {
      await page.addInitScript((stored) => {
        window.localStorage.setItem("theme", stored);
      }, theme.stored);
      await page.setViewportSize({ width: 1440, height: 950 });

      const composite = await seedComposite(page, runToken);
      await openComposite(page, composite);

      // The whole point of running twice: prove the two runs are two different
      // grounds, not the same one measured twice.
      const isNight = await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      expect(isNight, `${theme.name} did not apply`).toBe(theme.stored === "dark");

      // Move-down and remove sit on the FIRST member (move-up is disabled
      // there and a disabled button is not tabbable); move-up sits on the
      // second. Between them every shape of control in the band is read.
      const controls = [
        `composite-member-down-${composite.memberIds[0]}`,
        `composite-member-remove-${composite.memberIds[0]}`,
        `composite-member-up-${composite.memberIds[1]}`,
        "composite-add-member",
        "composite-default-toggle",
      ];

      for (const testId of controls) {
        await expect(page.getByTestId(testId)).toBeVisible();
        const reading = await tabTo(page, testId);
        expectPaintedRing(reading, `${testId} (${theme.name})`);
      }

      await page.screenshot({
        path: `e2e/test-results/composite-members-${theme.name}.png`,
        fullPage: true,
      });
    });
  });
}

test.describe("the composite surface at a narrow viewport", () => {
  test("390px wide draws no horizontal overflow on the document element", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const composite = await seedComposite(page, runToken);
    await openComposite(page, composite);

    // The band's own controls have to be reachable, not merely present: a
    // surface that fits only because its controls were clipped away is not
    // "usable at 390px".
    for (const testId of [
      "composite-member-list",
      "composite-add-member",
      "composite-default-toggle",
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `documentElement scrolls ${overflow.scrollWidth}px inside ${overflow.clientWidth}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth);

    // The member row itself must not spill past the viewport either — the
    // document can be clean while a child overflows its own container.
    const row = page.getByTestId(`composite-member-${composite.memberIds[0]}`);
    const box = await row.boundingBox();
    expect(box, "the first member row has no box").not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    await page.screenshot({
      path: "e2e/test-results/composite-members-390.png",
      fullPage: true,
    });
  });
});
