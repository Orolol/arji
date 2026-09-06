import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-OZUKyqpxmKaT — the desk composer's field under a long agent name, in
 * a real browser.
 *
 * The same defect B-arij-180 fixed on `/chat`, on the other surface that puts
 * a text field and an agent pill on one row. `__tests__/desk-composer-agent-name.test.tsx`
 * pins the mechanism; jsdom has no layout engine, so whether the field is a
 * box you can write in is a visual claim and lives here.
 *
 * MEASURED IN CHROME ON THE UNFIXED DESK (see the commit message for the
 * table): the pill took its max-content width and the field was left at 0px at
 * every one of the ticket's three widths, `scrollWidth` staying equal to
 * `clientWidth` throughout — the page never scrolled sideways, the field
 * simply collapsed.
 */

/** The ticket's three widths, plus the two frames the fix must not move. */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 900 },
  { width: 1440, height: 1000 },
] as const;

/**
 * A field narrower than this is not a composer, whatever its rect says. Same
 * number as `e2e/chat-mobile-layout.spec.ts`, and for the same reason: it is
 * the width at which the placeholder stops being a hint and starts being a
 * sliver.
 */
const MIN_INPUT_WIDTH_PX = 160;

/**
 * The agent label B-arij-180 measured with, character for character.
 *
 * `createNamedAgentSchema` (lib/validation/schemas.ts) puts NO length bound on
 * `name` — it only refuses a blank one — so this is an ordinary value the API
 * accepts, 107 characters, which a "Claude Code — <role> — <effort>" naming
 * convention produces on its own. The fix does not depend on the number: the
 * pill is capped and truncates, so a 1000-character name lands in the same
 * place.
 */
const LONG_AGENT_NAME =
  "Claude Code — Architecture, implementation et revue des interfaces du projet Arij — raisonnement approfondi";

/**
 * A named agent with that name.
 *
 * `named_agents` rows are GLOBAL — no project column, no cascade from the
 * project delete — and the table carries a UNIQUE index on `name`, so the row
 * is suffixed per project and dropped by the caller in a `finally`. Written
 * straight to the database because the arrange step is state, not a flow under
 * test; the SELECTION below goes through the real dropdown.
 */
function seedLongNamedAgent(projectId: string): string {
  const agentId = `e2e-desk-agent-${projectId}`;
  withDatabase((db) =>
    db
      .prepare(
        `INSERT INTO named_agents (id, name, provider, model, options, created_at)
         VALUES (?, ?, 'claude-code', 'opus', '{}', ?)`,
      )
      .run(agentId, `${LONG_AGENT_NAME} ${projectId}`, "2026-09-01T08:00:00.000Z"),
  );
  return agentId;
}

function dropNamedAgent(agentId: string): void {
  withDatabase((db) =>
    db.prepare("DELETE FROM named_agents WHERE id = ?").run(agentId),
  );
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
}

interface ComposerGeometry {
  scrollWidth: number;
  clientWidth: number;
  band: Box | null;
  bandWrap: string;
  bandStyled: boolean;
  input: Box | null;
  inputHittable: boolean;
  controls: { label: string; box: Box; hittable: boolean }[];
}

async function readGeometry(page: Page): Promise<ComposerGeometry> {
  return page.evaluate(() => {
    /**
     * `next dev` paints its dev-tools badge into a `<nextjs-portal>` pinned to
     * the bottom-left corner — which at 390x844 is exactly where the
     * composer's pills are. The badge is the DEV SERVER, not the product
     * (`next start`, what CI runs, never renders it), so it is hidden for the
     * length of the measurement rather than allowed to report a working
     * control as covered.
     */
    const overlays = Array.from(document.querySelectorAll("nextjs-portal"));
    const restore = overlays.map((node) => (node as HTMLElement).style.display);
    for (const node of overlays) (node as HTMLElement).style.display = "none";

    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return {
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        width: +r.width.toFixed(1),
        height: +r.height.toFixed(1),
        right: +r.right.toFixed(1),
      };
    };

    /**
     * Is the element the thing you would actually touch at its own centre? A
     * box inside the viewport that another box paints over is still an
     * unusable control, and a bounding rect alone cannot tell you which.
     */
    const hittable = (element: Element | null | undefined): boolean => {
      if (!element) return false;
      const r = element.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && (top === element || element.contains(top) || top.contains(element));
    };

    const input = document.querySelector('[data-testid="desk-composer-input"]');
    // The band is the composer's own `feed` stratum — the desk has exactly one.
    const band = document.querySelector('[data-stratum="feed"]');
    const controls = Array.from(band?.querySelectorAll("button") ?? []).map(
      (element) => ({
        label: (element.textContent || element.getAttribute("aria-label") || "?")
          .trim()
          .slice(0, 40),
        box: box(element)!,
        hittable: hittable(element),
      }),
    );

    const geometry = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      band: box(band),
      bandWrap: band ? getComputedStyle(band).flexWrap : "no-band",
      // `display:flex` is the band's own base class. Resolving to anything
      // else means Tailwind has not reached this document, and an unstyled
      // band squeezes the field exactly as a regression does.
      bandStyled: !!band && getComputedStyle(band).display === "flex",
      input: box(input),
      inputHittable: hittable(input),
      controls,
    };

    overlays.forEach((node, i) => ((node as HTMLElement).style.display = restore[i]));
    return geometry;
  });
}

function withinBox(inner: Box | null, outer: Box | null): boolean {
  if (!inner || !outer) return false;
  return inner.x >= outer.x - 0.5 && inner.right <= outer.right + 0.5;
}

async function capture(page: Page, info: TestInfo, name: string) {
  await info.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
}

/**
 * Waits until the composer's row is the one the user ends up looking at.
 *
 * Both pills render a placeholder until `/api/control-desk` and `/api/agents`
 * answer, and the webfont replacing its fallback moves the pills' width again
 * — measuring before either lands reports a roomier composer than anyone gets.
 */
async function settleComposer(page: Page) {
  await expect(
    page.locator('[data-stratum="feed"] [data-slot="select-pill"][data-tone="project"]'),
  ).not.toHaveText("—");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => {
    const band = document.querySelector('[data-stratum="feed"]');
    return !!band && getComputedStyle(band).display === "flex";
  });
}

test.describe("the desk composer under a long agent name", () => {
  test("keeps a usable field when the chosen agent has a very long name", async ({
    page,
    project,
  }, testInfo) => {
    const agentId = seedLongNamedAgent(project.id);

    try {
      for (const { width, height } of VIEWPORTS) {
        await page.setViewportSize({ width, height });
        await page.goto("/");
        await expect(page.getByTestId("now-desk")).toBeVisible();
        await expect(page.getByTestId("desk-composer-input")).toBeVisible();
        await settleComposer(page);

        const where = `${width}x${height} (long agent name)`;

        // THE REAL CONTROL, not a state write: open the pill's menu and pick
        // the agent, which is the only way a user gets that label into the bar.
        await page.getByTestId("desk-agent-select").click();
        await page.getByTestId(`chat-option-agent-${agentId}`).click();
        // The Radix menu is portalled OVER the band it belongs to, and at 390
        // it covers the field exactly. Measuring while it is still mounted
        // reports the composer as covered by its own picker, which is a true
        // statement about a menu that is open and says nothing about the row.
        await expect(page.getByTestId(`chat-option-agent-${agentId}`)).toHaveCount(0);

        const pill = page.locator(
          '[data-stratum="feed"] [data-slot="select-pill"][data-tone="ink"]',
        );
        // Waiting on the label means the pill holds the long string before
        // anything is measured, rather than the "Default agent" it starts on.
        await expect(pill).toContainText(LONG_AGENT_NAME);
        await settleComposer(page);

        // The desk owns its own scroll below `lg` (B-arij-M9zsQujUTCoR), so at
        // 390 the composer is the band past the fold. `elementFromPoint` only
        // answers about the viewport, so the coverage check below is about
        // nothing at all until the band is actually on screen.
        await page.getByTestId("desk-composer-input").scrollIntoViewIfNeeded();
        await expect(page.getByTestId("desk-composer-input")).toBeInViewport();

        const geometry = await readGeometry(page);
        await capture(page, testInfo, `desk-long-agent-${width}.png`);

        // Necessary and nowhere near sufficient: this already held on the
        // unfixed desk, because the field collapses instead of pushing the
        // document wide.
        expect(
          geometry.scrollWidth,
          `${where}: the page scrolls horizontally ` +
            `(scrollWidth ${geometry.scrollWidth} > clientWidth ${geometry.clientWidth})`,
        ).toBeLessThanOrEqual(geometry.clientWidth);

        expect(
          geometry.bandStyled,
          `${where}: the composer band is unstyled (display is not flex) — the ` +
            `page was measured before its stylesheet landed, so nothing below ` +
            `this is evidence about the layout`,
        ).toBe(true);

        // The defect, in one number.
        expect(
          geometry.input!.width,
          `${where}: the composer field was squeezed to ${geometry.input!.width}px ` +
            `by the pills beside it (band ${geometry.band?.width}px, ` +
            `flex-wrap ${geometry.bandWrap})`,
        ).toBeGreaterThanOrEqual(MIN_INPUT_WIDTH_PX);
        expect(
          geometry.inputHittable,
          `${where}: something covers the composer field`,
        ).toBe(true);

        // And the pill stays inside the band it belongs to: on `/chat` it
        // overflowed and was clipped by the neighbouring column.
        for (const control of geometry.controls) {
          expect(
            withinBox(control.box, geometry.band),
            `${where}: composer control "${control.label}" spills out of the band ` +
              `(${JSON.stringify(control.box)} in ${JSON.stringify(geometry.band)})`,
          ).toBe(true);
          expect(
            control.hittable,
            `${where}: composer control "${control.label}" is covered`,
          ).toBe(true);
        }

        // A field that measures well and refuses a keystroke is still broken.
        const input = page.getByTestId("desk-composer-input");
        await input.click();
        await input.fill("une feature");
        await expect(input).toHaveValue("une feature");
        await input.fill("");

        // Truncation has to be VISUAL: the pill is clipped by CSS, so the name
        // stays whole in the DOM and in the accessibility tree. A fix that
        // shortened the string would take the value with it.
        await expect(pill).toContainText(LONG_AGENT_NAME);
      }
    } finally {
      dropNamedAgent(agentId);
    }
  });
});
