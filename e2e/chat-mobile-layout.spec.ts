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
 *
 * ROUND 2 (review finding, same harness) moved the subject from the PAGE to
 * the COMPOSER, and found the same symptom twice more:
 *
 *   - a long agent name took the row and left the field at 0px at 640, 768,
 *     1024, 1280 AND 1440 — the review measured the tablet, the sweep below
 *     measures all of them;
 *   - the field was 41px wide at 1024 with an ordinary provider label, with no
 *     long name involved at all, because the three columns return at `lg` and
 *     the band is 372px there against 740px on a 768px phone layout.
 *
 * Both are the ticket's own third criterion, so both are asserted here rather
 * than left to a follow-up. Field widths, one probe, both trees, in px:
 *
 *                ORDINARY LABEL        107-CHAR AGENT NAME
 *    390x844      297 -> 297            297 -> 297
 *    768x1024     409 -> 409              0 -> 303
 *   1024x800       41 -> 307              0 -> 307
 *   1280x800      297 -> 297              0 -> 224
 *   1440x1000     457 -> 457              0 -> 336
 *
 * 640x900 is in the sweep but not in that table (the probe measured it
 * separately): with an ordinary label every rect there is equal to three
 * decimals across the two trees, and with the long name the field goes from
 * 0px to a value the sweep only asserts against its 160px floor.
 *
 * The unchanged column is a comparison, not a reading: the composer element
 * was captured on both trees. 390, 768, 1280 and 1440 are byte-identical PNGs
 * with an ordinary label; 640 differs by 36 pixels of at most 1/255 on the
 * attach glyph's antialiasing. Full-page captures are NOT usable evidence
 * here — two runs of the same tree disagree, in the thread rather than in the
 * composer.
 */

/**
 * The four viewports the ticket names, phone first — plus 1024, which it does
 * not.
 *
 * 1024 is the `lg` boundary: the three columns come back the moment it is
 * reached, so the thread column (and with it the composer band) is NARROWER
 * there than on a 768px phone layout — 372px against 740px, measured. It is
 * the worst case of the desktop frame and the widths the ticket names step
 * straight over it. Measured on the branch before this round: the composer
 * field was 41px wide at 1024 with an ordinary provider label, which is the
 * ticket's own "la saisie est masquée" symptom at a width nobody had looked
 * at. Swept here so the guarantee covers the band rather than five points.
 */
const VIEWPORTS = [
  { width: 390, height: 844, stacked: true },
  { width: 768, height: 1024, stacked: true },
  { width: 1024, height: 800, stacked: false },
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

/**
 * The widths the long-label sweep runs at: the phone, the two the review
 * measured (640 and 768), the `lg` boundary and the two desktop frames.
 *
 * 640 is `sm`, the width at which the band stopped wrapping — the review
 * measured a 18.22px field there with a 57-character name, and a 0px one at
 * 768 with the 107-character name below.
 */
const LONG_LABEL_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 640, height: 900 },
  { width: 768, height: 1024 },
  { width: 1024, height: 800 },
  { width: 1280, height: 800 },
  { width: 1440, height: 1000 },
] as const;

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
  /** The composer's own band — the box its controls have to stay inside. */
  band: Box | null;
  /**
   * How the band resolved its own row, and whether the stylesheet that decides
   * it arrived at all.
   *
   * `next dev` compiles CSS per route on first request, and under parallel
   * workers a cold route can paint before its stylesheet lands. Unstyled, the
   * band is a plain block whose flex-wrap is the CSS initial `nowrap` — which
   * squeezes the field exactly as a real regression would. Without these two
   * the failure reads "the field is 89px" and points at the fix rather than at
   * the server that had not finished compiling.
   */
  bandWrap: string;
  bandStyled: boolean;
  input: Box | null;
  /** `true` when the point at the composer input's centre belongs to it. */
  inputHittable: boolean;
  /**
   * Scroll and client heights of the composer input (textarea).
   * Used to assert that the empty placeholder does not wrap onto multiple lines
   * and overflow vertically (B-arij-180 regression finding / B-arij-245).
   */
  inputScrollHeight: number;
  inputClientHeight: number;
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

/**
 * The agent label the review measured with, character for character.
 *
 * `createNamedAgentSchema` puts NO length bound on `name` (it only refuses
 * blank), so this is an ordinary value the API accepts rather than an abusive
 * one — 107 characters, which is what a "Claude Code — <role> — <effort>"
 * naming convention produces on its own. The fix does not depend on the
 * number: the pill is capped and truncates, so a 1000-character name lands in
 * the same place. This one is here so the test reproduces the reported case.
 */
const LONG_AGENT_NAME =
  "Claude Code — Architecture, implementation et revue des interfaces du projet Arij — raisonnement approfondi";

/**
 * Points a conversation at a named agent whose name is that long.
 *
 * `named_agents` rows are GLOBAL — no project column, no cascade from the
 * project delete — and the table carries a UNIQUE index on `name`, so the row
 * is suffixed per project and dropped by the caller in a `finally`. Written
 * straight to the database for the same reason `seedConversations` is: the
 * arrange step is state, not a flow under test.
 */
function seedLongNamedAgent(projectId: string, conversationId: string): string {
  const agentId = `e2e-agent-${projectId}`;

  withDatabase((db) => {
    db.prepare(
      `INSERT INTO named_agents (id, name, provider, model, options, created_at)
       VALUES (?, ?, 'claude-code', 'opus', '{}', ?)`,
    ).run(agentId, `${LONG_AGENT_NAME} ${projectId}`, "2026-09-01T08:00:00.000Z");
    db.prepare(
      `UPDATE chat_conversations SET named_agent_id = ? WHERE id = ?`,
    ).run(agentId, conversationId);
  });

  return agentId;
}

function dropNamedAgent(agentId: string): void {
  withDatabase((db) =>
    db.prepare("DELETE FROM named_agents WHERE id = ?").run(agentId),
  );
}

async function readGeometry(page: Page): Promise<PageGeometry> {
  return page.evaluate(() => {
    /**
     * `next dev` paints its dev-tools badge into a `<nextjs-portal>` pinned to
     * the bottom-left corner, and at 390x844 that is exactly where the
     * composer's attach button is: every hit test on it returns the portal.
     * The badge is the DEV SERVER, not the product — `next start`, which is
     * what CI runs (playwright.config.ts, SERVER_MODE), never renders it — so
     * it is hidden for the length of the measurement rather than allowed to
     * report a working control as covered.
     */
    const overlays = Array.from(document.querySelectorAll("nextjs-portal"));
    const restore = overlays.map((node) => (node as HTMLElement).style.display);
    for (const node of overlays) (node as HTMLElement).style.display = "none";

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

    const geometry = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      threadPane: box(document.querySelector('[data-testid="chat-thread-pane"]')),
      composer: box(composer),
      band: box(band),
      bandWrap: band ? getComputedStyle(band).flexWrap : "no-band",
      // `display:flex` is the band's own base class. Resolving to `block`
      // means Tailwind's stylesheet is not applied to this document yet.
      bandStyled: !!band && getComputedStyle(band).display === "flex",
      input: box(input),
      inputHittable: hittable(input),
      inputScrollHeight: (input as HTMLElement | null)?.scrollHeight ?? 0,
      inputClientHeight: (input as HTMLElement | null)?.clientHeight ?? 0,
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

    overlays.forEach((node, index) => {
      (node as HTMLElement).style.display = restore[index];
    });

    return geometry;
  });
}

/** A box is on screen when both its edges are, within half a pixel. */
function withinViewport(box: Box | null, clientWidth: number): boolean {
  if (!box) return false;
  return box.x >= -0.5 && box.x + box.width <= clientWidth + 0.5;
}

/**
 * A box is inside another when neither of its horizontal edges escapes it.
 *
 * The viewport is not a strict enough frame for the composer's controls. With
 * a long agent name the pill measured 663px inside a 628px band at 1280 — it
 * spilled 214px past the band's right edge and was CLIPPED by the thread
 * column, while its rect still sat comfortably inside a 1280px viewport. So a
 * viewport check alone reports a half-drawn control as fine.
 */
function withinBox(box: Box | null, frame: Box | null): boolean {
  if (!box || !frame) return false;
  return box.x >= frame.x - 0.5 && box.x + box.width <= frame.x + frame.width + 0.5;
}

/**
 * Everything the ticket's third criterion asks of the composer, at one width:
 * the field is on screen, uncovered, wide enough to write in, and every
 * control beside it is drawn whole inside the band.
 */
function expectComposerUsable(geometry: PageGeometry, where: string) {
  expect(
    withinViewport(geometry.input, geometry.clientWidth),
    `${where}: the composer input is off screen (${JSON.stringify(geometry.input)})`,
  ).toBe(true);
  expect(
    geometry.inputHittable,
    `${where}: something covers the composer input`,
  ).toBe(true);
  // The stylesheet first: an unstyled band squeezes the field exactly as a
  // regression does, and saying so is the difference between a bug report and
  // a re-run.
  expect(
    geometry.bandStyled,
    `${where}: the composer band is unstyled (display is not flex) — the page ` +
      `was measured before its stylesheet landed, so nothing below this is ` +
      `evidence about the layout`,
  ).toBe(true);
  expect(
    geometry.input!.width,
    `${where}: the composer input was squeezed to ${geometry.input!.width}px ` +
      `by the controls beside it (band ${geometry.band?.width}px, ` +
      `flex-wrap ${geometry.bandWrap})`,
  ).toBeGreaterThanOrEqual(MIN_INPUT_WIDTH_PX);
  // The placeholder must stay on a single line and not wrap/overflow vertically.
  // Before placeholder:truncate, the 51-char placeholder wrapped to 2 lines on
  // narrow widths (e.g. 1280x800 desktop frame), causing scrollHeight (66px) > clientHeight (50px).
  expect(
    geometry.inputScrollHeight,
    `${where}: composer input placeholder wraps to multiple lines and overflows vertically ` +
      `(scrollHeight ${geometry.inputScrollHeight} > clientHeight ${geometry.inputClientHeight})`,
  ).toBeLessThanOrEqual(geometry.inputClientHeight);
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
      withinBox(control.box, geometry.band),
      `${where}: composer control "${control.label}" spills out of the band ` +
        `(${JSON.stringify(control.box)} in ${JSON.stringify(geometry.band)})`,
    ).toBe(true);
    expect(
      control.hittable,
      `${where}: composer control "${control.label}" is covered`,
    ).toBe(true);
  }
}

/**
 * Waits until the composer's row is the one the user ends up looking at.
 *
 * Two things settle late and both widen the pills beside the field, so
 * measuring early reports a ROOMIER composer than anyone gets. The labels:
 * both pills render "—" until `/api/control-desk` and `/api/agents` answer,
 * which alone was worth 136px of field at 1024 against the 41px it ends at.
 * And the webfont: Instrument Sans replacing its fallback moved the same
 * measurement by another ~48px. The project pill losing its dash and
 * `document.fonts.ready` are the two markers for those two waits.
 */
async function settleComposer(page: Page) {
  await expect(
    page.locator(
      '[data-testid="chat-composer"] [data-slot="select-pill"][data-tone="project"]',
    ),
  ).not.toHaveText("—");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  /*
    AND the stylesheet that decides the band's row.

    `next dev` compiles CSS per route on first request. Observed once: the
    first run of this spec against a cold server with two workers reported an
    89px field at 1024 and a covered input at 640, and six consecutive runs
    once the route was warm were green — as were the same widths measured one
    at a time on the cold tree. An unstyled band is a plain block whose
    flex-wrap is the CSS initial `nowrap`, which squeezes the field exactly as
    a real regression would, so a page measured before its stylesheet landed
    fits those numbers.

    NOT PROVEN: this wait was added after that run, so `bandStyled` was never
    captured at the moment it failed, and concurrent load from a second session
    on the same dev server is an equally good fit. The wait closes the styling
    race specifically; the assertion below names it if it ever recurs.

    `display: flex` is the band's own base class, so it resolving to `block`
    means Tailwind has not reached this document. WAITING on it rather than
    asserting it is what keeps a cold route from reading as a layout defect;
    `expectComposerUsable` still asserts it, for the case where it never
    arrives at all. CI runs `next start` (playwright.config.ts, SERVER_MODE),
    which compiles nothing and never takes this path.
  */
  await page.waitForFunction(() => {
    const band = document
      .querySelector('[data-testid="chat-composer"]')
      ?.querySelector('[data-slot="strata-band"]');
    return !!band && getComputedStyle(band).display === "flex";
  });
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
      await settleComposer(page);

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
      expectComposerUsable(geometry, where);

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
    await page.getByRole("button", { name: "Context" }).press("Enter");
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

  /**
   * The second round's finding, and the width band the first round missed.
   *
   * The composer's row is a glyph, a field and three controls, and the agent
   * pill's label is a user-chosen string of any length. Measured in Chrome on
   * the previous commit, with the 107-character name below:
   *
   *     viewport   band   agent pill   field
   *       390       362      116        297   (band wrapped — the field is safe)
   *       640       612      663          0
   *       768       740      663          0
   *      1024       372      663          0
   *      1280       628      663          0
   *      1440       788      663          0
   *
   * The pill took its own max-content width at every width where the band was
   * a single row and left the field at ZERO — not just on the tablet the
   * review measured. `scrollWidth` equalled `clientWidth` throughout, exactly
   * as it did for the original defect, because the field collapses instead of
   * pushing the document wide. The pill itself overflowed the band and was
   * clipped by the thread column, which is why `expectComposerUsable` frames
   * the controls by the BAND and not by the viewport.
   */
  test("keeps a usable field when the conversation's agent has a very long name", async ({
    page,
    project,
  }, testInfo) => {
    const { first } = seedConversations(project.id);
    const agentId = seedLongNamedAgent(project.id, first);

    try {
      for (const { width, height } of LONG_LABEL_VIEWPORTS) {
        await page.setViewportSize({ width, height });
        await page.goto(`/chat?project=${project.id}&conversation=${first}`);

        await expect(page.getByTestId("chat-composer")).toBeVisible();
        await expect(page.getByTestId("chat-thread")).toBeVisible();

        const where = `${width}x${height} (long agent name)`;
        // The label is what makes this case: waiting on it means the pill has
        // the long string in it before anything is measured, rather than the
        // provider fallback the conversation renders until /api/agents lands.
        const pill = page.locator(
          '[data-testid="chat-composer"] [data-slot="select-pill"][data-tone="ink"]',
        );
        await expect(pill).toContainText(LONG_AGENT_NAME);
        await settleComposer(page);

        const geometry = await readGeometry(page);
        await capture(page, testInfo, `chat-long-agent-${width}.png`);

        expect(
          geometry.scrollWidth,
          `${where}: the page scrolls horizontally ` +
            `(scrollWidth ${geometry.scrollWidth} > clientWidth ${geometry.clientWidth})`,
        ).toBeLessThanOrEqual(geometry.clientWidth);
        expectComposerUsable(geometry, where);

        // The interaction, not a rect: a field that measures well and refuses
        // a click is the failure the review actually hit.
        const input = page.getByTestId("chat-composer-input");
        await input.click();
        await input.fill("bonjour");
        await expect(input).toHaveValue("bonjour");
        await input.fill("");

        // Truncation has to be VISUAL. The pill is clipped by CSS, so the
        // name stays whole in the accessibility tree and in the DOM — a fix
        // that shortened the string would take the value with it.
        await expect(pill).toContainText(LONG_AGENT_NAME);
      }
    } finally {
      dropNamedAgent(agentId);
    }
  });
});
