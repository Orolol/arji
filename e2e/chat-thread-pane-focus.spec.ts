import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-231 — the chat thread pane, in Chrome, when the keyboard hands it
 * focus.
 *
 * This is the half of the fix that `__tests__/chat-thread-pane-focus-ring.test.tsx`
 * cannot do. jsdom loads no CSS and has no `:focus-visible` heuristic, so the
 * unit file resolves the class list out of band and pins the mechanism. That a
 * ring is DRAWN, and drawn only for the keyboard, is a visual claim about a
 * browser state, and needs the browser.
 *
 * WHAT WAS MEASURED HERE ON THE UNFIXED TREE (2026-09-06, `channel: chrome`,
 * viewport 390x844, one project, two seeded conversations), tabbing to a
 * conversation card and pressing Enter:
 *
 *   {"testId":"chat-thread-pane","matchesFocusVisible":true,
 *    "outlineStyle":"none","outlineStyleVar":"none"}
 *
 * `:focus-visible` matched and nothing was painted — Tailwind v4's
 * `outline-none` sets `--tw-outline-style: none`, and there was no
 * `focus-visible:outline-*` on the pane to state a style back. A keyboard user
 * pressed Enter, the pane holding the card they were on was destroyed, focus
 * moved here, and the screen said nothing about where it had gone.
 *
 * THE SAME MEASUREMENT ON THE TAP PATH READ `false`, which is the reason this
 * is a `focus-visible:` ring and not an unconditional one: clicking or tapping
 * a card focuses the pane too, and a box drawn around the whole column then
 * would be noise nobody asked for.
 *
 * WHY THE PANE IS NOT A TAB STOP, and why that is not the same as "no
 * affordance to lose". Measured on the same tree: 30 Tab presses at 390 and 40
 * at 1440 never reach it (`tabIndex={-1}`), and it is not a scroll container
 * either — `overflow: visible`, `scrollHeight === clientHeight`, since the
 * transcript scrolls inside a Radix viewport further down. No browser tabs to
 * it on its own, including the Firefox behaviour that makes scrollable regions
 * focusable. It is reached only by the hand-off, and the hand-off is a
 * keyboard event.
 */

const FIRST_LABEL = "Fil du matin";
const SECOND_LABEL = "Refonte mobile";

/** The phone layout: the only one where the hand-off runs (`lg:hidden` switcher). */
const PHONE = { width: 390, height: 844 } as const;
/** The desktop frame, where all three columns are up and nothing hands focus. */
const DESKTOP = { width: 1440, height: 950 } as const;

/** How many Tab presses to spend proving the pane is not in the tab order. */
const TAB_BUDGET = 30;

/** Two conversations with a message each, written straight into the database. */
function seedConversations(projectId: string): { first: string; second: string } {
  const first = `e2e-focus-conv-a-${projectId}`;
  const second = `e2e-focus-conv-b-${projectId}`;

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
      "Est-ce que le fil tient sur un telephone ?",
      "2026-09-01T08:01:00.000Z",
    );
    message.run(
      `${second}-m1`,
      projectId,
      second,
      "user",
      "Le composeur doit rester atteignable.",
      "2026-09-02T08:01:00.000Z",
    );
  });

  return { first, second };
}

interface FocusReading {
  testId: string | null;
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
    if (!active || active === document.body) return null;

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

async function capture(page: Page, info: TestInfo, name: string) {
  await info.attach(name, {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
}

/**
 * Open the chat page on the roster pane, with both conversation cards mounted.
 *
 * Waiting on the SECOND card and not on the composer is load-bearing: the
 * roster arrives from its own fetch, and a tab sweep started before it lands
 * walks a page whose cards do not exist yet and reports "never focused" for a
 * control that is simply not there. That is how the first run of this probe
 * concluded the cards were unreachable by keyboard.
 */
async function openRoster(page: Page, projectId: string, conversationId: string) {
  await page.goto(`/chat?project=${projectId}&conversation=${conversationId}`);
  await expect(page.getByTestId("chat-composer")).toBeVisible();
  await page.getByRole("button", { name: "Conversations" }).click();
  await expect(page.getByTestId("chat-roster")).toBeVisible();
  await expect(
    page.getByTestId("chat-roster-card").filter({ hasText: SECOND_LABEL }),
  ).toBeVisible();
}

/** Tab forward until the card labelled `label` has focus. Returns the hops. */
async function tabToCard(page: Page, label: string): Promise<number> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  for (let i = 1; i <= TAB_BUDGET; i++) {
    await page.keyboard.press("Tab");
    const onCard = await page.evaluate((wanted) => {
      const active = document.activeElement;
      return (
        active?.getAttribute("data-testid") === "chat-roster-card" &&
        (active.textContent ?? "").includes(wanted)
      );
    }, label);
    if (onCard) return i;
  }

  throw new Error(
    `the "${label}" conversation card never took focus within ${TAB_BUDGET} ` +
      `Tab presses — the keyboard path this spec measures does not exist`,
  );
}

test.describe("Chat thread pane — the keyboard hand-off draws a ring", () => {
  test("paints the pane's outline when Enter on a card moves focus there", async ({
    page,
    project,
  }, testInfo) => {
    const { first } = seedConversations(project.id);

    await page.setViewportSize(PHONE);
    await openRoster(page, project.id, first);

    const hops = await tabToCard(page, SECOND_LABEL);
    await capture(page, testInfo, "thread-pane-card-focused.png");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("chat-thread-pane")).toBeVisible();
    const reading = await readFocused(page);

    // The hand-off itself. Without it there is no ring to argue about — and
    // `__tests__/chat-page-responsive.test.tsx` pins the same move in jsdom.
    expect(
      reading?.testId,
      `after ${hops} Tab presses and Enter, focus is on ` +
        `${reading?.testId ?? "<body>"} rather than on the thread pane`,
    ).toBe("chat-thread-pane");

    // Guards the assertion below: if Chrome did not treat this as a keyboard
    // focus, "nothing painted" would be correct rather than the defect.
    expect(
      reading!.matchesFocusVisible,
      "the pane did not match :focus-visible after a keyboard hand-off, so " +
        "the ring assertion below would be vacuous",
    ).toBe(true);

    // The defect, verbatim: `:focus-visible` matched and outline-style was
    // "none", because `outline-none` sets --tw-outline-style and nothing
    // stated a style back.
    expect(
      reading!.outlineStyle,
      `the pane matched :focus-visible with outline-color ` +
        `${reading!.outlineColor} and outline-width ${reading!.outlineWidth}, ` +
        `but outline-style is "${reading!.outlineStyle}" ` +
        `(--tw-outline-style: ${reading!.outlineStyleVar}) — nothing is drawn, ` +
        `so a keyboard user cannot see where focus went`,
    ).toBe("solid");
    expect(reading!.outlineWidth).toBe("2px");

    await capture(page, testInfo, "thread-pane-keyboard-focus.png");
  });

  test("leaves the ring off when a tap moves focus to the same pane", async ({
    page,
    project,
  }, testInfo) => {
    const { first } = seedConversations(project.id);

    await page.setViewportSize(PHONE);
    await openRoster(page, project.id, first);

    await page
      .getByTestId("chat-roster-card")
      .filter({ hasText: SECOND_LABEL })
      .click();

    await expect(page.getByTestId("chat-thread-pane")).toBeVisible();
    const reading = await readFocused(page);

    expect(reading?.testId).toBe("chat-thread-pane");
    // The reason the ring is `focus-visible:` and not unconditional: the same
    // hand-off runs on the tap path, and a 2px box around the whole column
    // would be drawn on every conversation a phone user picks.
    expect(
      reading!.matchesFocusVisible,
      "Chrome treated a tap as a keyboard focus; the ring would then be " +
        "painted on the touch path too",
    ).toBe(false);
    expect(reading!.outlineStyle).toBe("none");

    await capture(page, testInfo, "thread-pane-tap-focus.png");
  });

  test("is never reached by Tab, and is not a scrollable region", async ({
    page,
    project,
  }) => {
    const { first } = seedConversations(project.id);

    for (const viewport of [PHONE, DESKTOP]) {
      await page.setViewportSize(viewport);
      await page.goto(`/chat?project=${project.id}&conversation=${first}`);
      await expect(page.getByTestId("chat-thread-pane")).toBeVisible();
      await expect(page.getByTestId("chat-composer")).toBeVisible();

      const where = `${viewport.width}x${viewport.height}`;

      // The other exit the rule offers — a documented `NO_AFFORDANCE_NEEDED`
      // entry — rests on this being true AND on nothing else focusing the
      // pane. The first half holds; the test above is the second half.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      for (let i = 0; i < TAB_BUDGET; i++) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() =>
          document.activeElement?.getAttribute("data-testid"),
        );
        expect(
          focused,
          `${where}: the pane took focus on Tab press ${i + 1}; it is a ` +
            `tabIndex={-1} hand-off target, and a tab stop needs a real ` +
            `control rather than a column`,
        ).not.toBe("chat-thread-pane");
      }

      // Firefox (and Chrome under some configurations) puts a SCROLLABLE
      // region in the tab order on its own. This one is not scrollable: the
      // transcript scrolls in a Radix viewport further down.
      const scroll = await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="chat-thread-pane"]');
        if (!pane) return null;
        const style = getComputedStyle(pane);
        return {
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrolls:
            pane.scrollHeight > pane.clientHeight ||
            pane.scrollWidth > pane.clientWidth,
        };
      });

      expect(scroll, `${where}: the pane is not in the DOM`).not.toBeNull();
      expect(
        scroll!.scrolls,
        `${where}: the pane became a scroll container (overflow ` +
          `${scroll!.overflowX}/${scroll!.overflowY}), which browsers put in ` +
          `the tab order on their own — the ring is then a tab stop's ring ` +
          `and this spec's premise needs rewriting`,
      ).toBe(false);
    }
  });
});
