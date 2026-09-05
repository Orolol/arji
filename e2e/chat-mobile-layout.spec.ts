import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-180 — the chat page, in Chrome, at four widths.
 *
 * This is the half of the fix that `__tests__/chat-page-responsive.test.tsx`
 * cannot do. jsdom has no layout engine, so the unit file can only pin the
 * markup that produced the defect (two flanks at `w-[300px] shrink-0` with no
 * breakpoint) and the pane machinery that replaces it. Whether the thread is
 * actually on screen, whether the composer is actually clickable and whether
 * the page actually scrolls sideways are visual claims and need a browser.
 *
 * WHAT WAS MEASURED HERE (2026-09-05, `PLAYWRIGHT_CHANNEL=chrome` against the
 * dev server, one project, two seeded conversations). Widths of
 * `chat-thread` / `chat-composer` / `chat-composer-input`, in px:
 *
 *              BEFORE                  AFTER
 *   390x844    0 / 0 / 0               362 / 362 / 297
 *   768x1024   116 / 116 / 0           740 / 740 / 402
 *   1280x800   628 / 628 / 290         628 / 628 / 290   (unchanged)
 *   1440x1000  788 / 788 / 450         788 / 788 / 450   (unchanged)
 *
 * SCROLLWIDTH NEVER CAUGHT THIS, and the ticket is right to say so. At 390 the
 * broken page measured `scrollWidth` 390 against `clientWidth` 390 — no
 * horizontal scroll at all, because `min-w-0` on the middle column let it be
 * crushed to zero instead of pushing the document wide. The roster held its
 * 300px, the context rail was clipped at the right edge, and the thread and
 * composer were a zero-width column at x=326: Playwright reports
 * `chat-composer` as *hidden* on the unfixed tree. So this file asserts boxes,
 * hit-testing and a usable field width, and keeps `scrollWidth` only as the
 * criterion's literal wording.
 *
 * THE HEIGHTS ARE THE TICKET'S. 390x844 and 768x1024 are the two viewports the
 * acceptance criteria name; 1280x800 and 1440x1000 are the two it forbids
 * regressing. They are swept in one test rather than four so a single run
 * proves the phone fix and the desktop non-regression against the same tree.
 */

/** The four viewports the ticket names, phone first. */
const VIEWPORTS = [
  { width: 390, height: 844, stacked: true },
  { width: 768, height: 1024, stacked: true },
  { width: 1280, height: 800, stacked: false },
  { width: 1440, height: 1000, stacked: false },
] as const;

/**
 * A text field narrower than this is on screen and useless. Before the fix the
 * composer measured 0px wide at 390 and 768, and 24px once the page layout
 * alone was corrected — a rect inside the viewport is not the same claim as a
 * field you can write in. Every viewport in the sweep clears this, the
 * narrowest (390) by ~137px.
 */
const MIN_INPUT_WIDTH_PX = 160;

const FIRST_LABEL = "Fil du matin";
const SECOND_LABEL = "Refonte mobile";
const FIRST_MESSAGE = "Est-ce que le fil tient sur un telephone ?";
const SECOND_MESSAGE = "Le composeur doit rester atteignable.";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageGeometry {
  scrollWidth: number;
  clientWidth: number;
  threadPane: Box | null;
  composer: Box | null;
  input: Box | null;
  /** `true` when the point at the composer input's centre belongs to it. */
  inputHittable: boolean;
  /** Every composer control, and whether its centre point reaches it. */
  controls: { label: string; box: Box | null; hittable: boolean }[];
  /** `display:none` panes have no offsetParent, so nothing in them can tab. */
  rosterCreateReachable: boolean;
}

/** Two conversations with a message each, written straight into the database. */
function seedConversations(projectId: string): { first: string; second: string } {
  const first = `e2e-conv-a-${projectId}`;
  const second = `e2e-conv-b-${projectId}`;

  withDatabase((db) => {
    const conversation = db.prepare(
      `INSERT INTO chat_conversations
         (id, project_id, type, label, status, provider, created_at)
       VALUES (?, ?, 'brainstorm', ?, 'active', 'claude-code', ?)`,
    );
    const message = db.prepare(
      `INSERT INTO chat_messages
         (id, project_id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    conversation.run(first, projectId, FIRST_LABEL, "2026-09-01T08:00:00.000Z");
    conversation.run(second, projectId, SECOND_LABEL, "2026-09-02T08:00:00.000Z");
    message.run(
      `${first}-m1`,
      projectId,
      first,
      "user",
      FIRST_MESSAGE,
      "2026-09-01T08:01:00.000Z",
    );
    message.run(
      `${second}-m1`,
      projectId,
      second,
      "user",
      SECOND_MESSAGE,
      "2026-09-02T08:01:00.000Z",
    );
  });

  return { first, second };
}

async function readGeometry(page: Page): Promise<PageGeometry> {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    /**
     * Is the element the thing you would actually touch at its own centre?
     * A box inside the viewport that another box paints over is still an
     * unusable control, and a bounding rect alone cannot tell you which.
     */
    const hittable = (element: Element | null | undefined): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const top = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return !!top && (top === element || element.contains(top) || top.contains(element));
    };

    const composer = document.querySelector('[data-testid="chat-composer"]');
    const input = document.querySelector('[data-testid="chat-composer-input"]');
    const create = document.querySelector('[data-testid="chat-new-conversation"]');

    // The composer's own controls: the attach button and the two pills. They
    // carry no test ids, so they are read positionally from the composer's
    // band — which is exactly the set the ticket calls "les actions utiles".
    const band = composer?.querySelector('[data-slot="strata-band"]') ?? composer;
    const buttons = Array.from(band?.querySelectorAll("button") ?? []);

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      threadPane: box(document.querySelector('[data-testid="chat-thread-pane"]')),
      composer: box(composer),
      input: box(input),
      inputHittable: hittable(input),
      controls: buttons.map((button, index) => ({
        label:
          button.getAttribute("aria-label") ||
          button.textContent?.trim() ||
          `composer control ${index}`,
        box: box(button),
        hittable: hittable(button),
      })),
      // `offsetParent === null` for anything under `display:none`, so this is
      // also the proof that a hidden pane is out of the tab order.
      rosterCreateReachable:
        !!create && (create as HTMLElement).offsetParent !== null,
    };
  });
}

/** A box is on screen when both its edges are, within half a pixel. */
function withinViewport(box: Box | null, clientWidth: number): boolean {
  if (!box) return false;
  return box.x >= -0.5 && box.x + box.width <= clientWidth + 0.5;
}

async function capture(page: Page, info: TestInfo, name: string) {
  await info.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
}

test.describe("Chat — the thread and the composer on a narrow viewport", () => {
  test("keeps the thread, its messages and the composer on screen at every width", async ({
    page,
    project,
  }, testInfo) => {
    const { first } = seedConversations(project.id);

    for (const { width, height, stacked } of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await page.goto(`/chat?project=${project.id}&conversation=${first}`);

      await expect(page.getByTestId("chat-page")).toBeVisible();
      // The composer is the last thing the workspace mounts, and the one the
      // ticket says was off screen — waiting on it means the page is settled
      // AND that the thing under measurement exists.
      await expect(page.getByTestId("chat-composer")).toBeVisible();
      await expect(page.getByTestId("chat-thread")).toBeVisible();

      const where = `${width}x${height}`;
      const geometry = await readGeometry(page);
      await capture(page, testInfo, `chat-${where}.png`);

      // The ticket's pass condition, verbatim: no horizontal page scroll.
      expect(
        geometry.scrollWidth,
        `${where}: the page scrolls horizontally ` +
          `(scrollWidth ${geometry.scrollWidth} > clientWidth ${geometry.clientWidth})`,
      ).toBeLessThanOrEqual(geometry.clientWidth);

      // "la conversation active, ses messages et le composeur sont accessibles"
      expect(
        withinViewport(geometry.threadPane, geometry.clientWidth),
        `${where}: the thread pane is off screen (${JSON.stringify(geometry.threadPane)})`,
      ).toBe(true);
      expect(
        withinViewport(geometry.composer, geometry.clientWidth),
        `${where}: the composer is off screen (${JSON.stringify(geometry.composer)})`,
      ).toBe(true);
      await expect(
        page.getByTestId("chat-thread").getByText(FIRST_MESSAGE),
      ).toBeVisible();

      // "La saisie, le bouton d'envoi et les actions utiles ne sont ni masqués
      // ni recouverts." A rect inside the viewport is not enough — every one
      // of these has to be the element you hit at its own centre.
      expect(
        withinViewport(geometry.input, geometry.clientWidth),
        `${where}: the composer input is off screen (${JSON.stringify(geometry.input)})`,
      ).toBe(true);
      expect(
        geometry.inputHittable,
        `${where}: something covers the composer input`,
      ).toBe(true);
      expect(
        geometry.input!.width,
        `${where}: the composer input was squeezed to ${geometry.input!.width}px ` +
          `by the controls beside it`,
      ).toBeGreaterThanOrEqual(MIN_INPUT_WIDTH_PX);
      expect(
        geometry.controls.length,
        `${where}: the composer rendered no controls to check`,
      ).toBeGreaterThan(0);
      for (const control of geometry.controls) {
        expect(
          withinViewport(control.box, geometry.clientWidth),
          `${where}: composer control "${control.label}" is off screen ` +
            `(${JSON.stringify(control.box)})`,
        ).toBe(true);
        expect(
          control.hittable,
          `${where}: composer control "${control.label}" is covered`,
        ).toBe(true);
      }

      // Typing is the end of the chain: an on-screen, uncovered field that
      // does not take a keystroke is still a broken composer.
      const input = page.getByTestId("chat-composer-input");
      await input.click();
      await input.fill("bonjour");
      await expect(input).toHaveValue("bonjour");
      await input.fill("");

      // The switcher exists ONLY below `lg`, and the flanks follow it: on a
      // phone the roster is `display:none` (so nothing in it can be tabbed
      // to), on a desktop it is a column and the switcher is gone.
      const switcher = page.getByTestId("chat-pane-switcher");
      if (stacked) {
        await expect(switcher, `${where}: no pane switcher`).toBeVisible();
        await expect(page.getByTestId("chat-roster")).toBeHidden();
        expect(
          geometry.rosterCreateReachable,
          `${where}: a hidden pane still exposes a focusable control`,
        ).toBe(false);
      } else {
        await expect(switcher, `${where}: the switcher leaked onto the desktop frame`).toBeHidden();
        await expect(page.getByTestId("chat-roster")).toBeVisible();
        await expect(page.getByTestId("chat-context")).toBeVisible();
      }
    }
  });

  test("reaches the roster and the context rail, and switches conversation, at 390px", async ({
    page,
    project,
  }, testInfo) => {
    const { first } = seedConversations(project.id);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/chat?project=${project.id}&conversation=${first}`);
    await expect(page.getByTestId("chat-composer")).toBeVisible();
    await expect(
      page.getByTestId("chat-thread").getByText(FIRST_MESSAGE),
    ).toBeVisible();

    // "La liste des conversations et le contexte restent accessibles". Both by
    // KEYBOARD — `press` focuses the control first, so this is the tab path
    // and the click path at once.
    await page.getByRole("button", { name: "Contexte" }).press("Enter");
    await expect(page.getByTestId("chat-context")).toBeVisible();
    await expect(page.getByTestId("chat-thread-pane")).toBeHidden();
    await capture(page, testInfo, "chat-390-context.png");

    await page.getByRole("button", { name: "Conversations" }).press("Enter");
    const roster = page.getByTestId("chat-roster");
    await expect(roster).toBeVisible();
    await expect(roster.getByText(FIRST_LABEL)).toBeVisible();
    await expect(roster.getByText(SECOND_LABEL)).toBeVisible();
    await capture(page, testInfo, "chat-390-roster.png");

    // "sélectionner une autre conversation fonctionne" — and lands you on the
    // conversation you picked rather than on the list you picked it from.
    await roster
      .getByTestId("chat-roster-card")
      .filter({ hasText: SECOND_LABEL })
      .click();

    const threadPane = page.getByTestId("chat-thread-pane");
    await expect(threadPane).toBeVisible();
    await expect(
      page.getByTestId("chat-thread").getByText(SECOND_MESSAGE),
    ).toBeVisible();
    await expect(page.getByTestId("chat-composer")).toBeVisible();

    // "Navigation clavier et focus préservés": the card you tapped went away
    // with its pane, so focus has to be handed somewhere real — otherwise the
    // next Tab restarts at the top of the document.
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(
      focused,
      "focus was dropped when the roster pane closed",
    ).toBe("chat-thread-pane");

    // And the page is still not sideways after all that.
    const geometry = await readGeometry(page);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await capture(page, testInfo, "chat-390-after-switch.png");
  });
});
