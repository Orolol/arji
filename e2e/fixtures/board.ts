import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A 16×16 solid PNG, small enough to inline and real enough that the browser
 * decodes it — which is what lets a test tell "the thumbnail element rendered"
 * apart from "the bytes actually came back from the serve route".
 */
export const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4o6ZGEmIY1TCqYfhqAAATqigQ9kvG0QAAAABJRU5ErkJggg==";

/** Opens the header's New menu and selects one of its entries. */
export async function openNewMenu(page: Page, entryTestId: string): Promise<void> {
  await page.getByTestId("header-new-button").click();
  await page.getByTestId(entryTestId).click();
}

/**
 * The kanban card for a ticket, matched on the title it renders in its `h4`.
 *
 * Scoped to that tag on purpose: once the detail panel opens it shows the same
 * title in an editable field, and an unscoped text match would then resolve to
 * two elements and fail strict mode.
 */
export function ticketCard(page: Page, title: string): Locator {
  return page.locator("h4", { hasText: title });
}

/**
 * Clicks a ticket's card and returns the detail panel, already past its
 * loading state so callers can assert on real content.
 */
export async function openTicketDetail(page: Page, title: string): Promise<Locator> {
  const card = ticketCard(page, title);
  await expect(card).toBeVisible();
  await card.click();

  const panel = page.getByTestId("epic-detail-panel");
  await expect(panel).toBeVisible();
  /**
   * Past the suite's default expect timeout because opening a ticket fans out
   * into a dozen route handlers (comments, artifacts, grading, verify, stories,
   * dependencies, sessions…), each of which `next dev` may still be compiling,
   * against one server shared by every worker. The panel sitting on "Loading…"
   * for more than 15s is ordinary under that load and says nothing about the
   * behaviour under test.
   *
   * A panel that never loads still fails — this widens the window, it does not
   * remove the check.
   */
  await expect(panel.getByText("Loading...")).toHaveCount(0, { timeout: 45_000 });

  return panel;
}

/**
 * Pastes an image into `target` the way Ctrl/Cmd+V does.
 *
 * Playwright cannot put a file on the real system clipboard, so the event is
 * built in the page: a `DataTransfer` carrying a `File`, handed to a bubbling
 * `ClipboardEvent`. That is exactly the shape `imageFilesFromClipboard` reads,
 * and React's delegated `onPaste` picks it up like any user paste.
 */
export async function pasteImage(
  target: Locator,
  fileName = "screenshot.png",
  base64 = SAMPLE_PNG_BASE64
): Promise<void> {
  await target.evaluate(
    async (element, { name, data }) => {
      const response = await fetch(`data:image/png;base64,${data}`);
      const blob = await response.blob();

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([blob], name, { type: "image/png" }));

      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { name: fileName, data: base64 }
  );
}

/**
 * A column's droppable box.
 *
 * This is the node `useDroppable` measures in `components/kanban/Column.tsx`,
 * so it is also the rect dnd-kit's collision detection compares against —
 * aiming a drag anywhere else means guessing where the drop resolves.
 */
export function boardColumn(page: Page, status: string): Locator {
  return page.getByTestId(`column-${status}`);
}

/**
 * The draggable card element, as opposed to `ticketCard`'s `h4`.
 *
 * dnd-kit's pointer listeners sit on this node, and its box is what a drag
 * has to start inside. Matched through the title's `h4` so a card is still
 * addressed the way the rest of the suite addresses one, and never confused
 * with the DragOverlay copy — which renders the same epic and outlives the
 * drop animation, and therefore carries `drag-overlay-card-*` instead.
 */
export function ticketCardBody(page: Page, title: string): Locator {
  return page
    .locator("[data-testid^='epic-card-']")
    .filter({ has: page.locator("h4", { hasText: title }) });
}

/**
 * Re-derives the rendered board from the server.
 *
 * Needed because the board does not reliably converge on its own after a write
 * (B-arij-141: a board GET resolving late can overwrite a completed move with
 * the state before it, and nothing schedules another refetch). A reload is the
 * one resync that is guaranteed to reflect stored state, and it is also what
 * the next drag depends on — `handleDragEnd` derives the move from what the
 * board currently believes, so a stale render would post a transition out of a
 * column the ticket has already left.
 *
 * `domcontentloaded` rather than the default `load`: the board's data arrives
 * from its own fetches afterwards either way, so waiting on subresources adds
 * latency to every step of a multi-stage journey without making the following
 * assertion any safer — that assertion waits for the card on its own.
 */
export async function syncBoard(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
}

/** Whether a card with this title is currently rendered inside a column. */
export function cardInColumn(page: Page, status: string, title: string): Locator {
  return boardColumn(page, status).locator("h4", { hasText: title });
}

/**
 * Drags a card onto a column, the way a pointer does.
 *
 * Every step here is load-bearing for dnd-kit rather than decoration:
 *
 * - The board's `PointerSensor` has `activationConstraint: { distance: 8 }`,
 *   so a press followed by a jump to the target never starts a drag at all —
 *   the first short move is what arms it.
 * - Collision detection (`closestCorners`) runs on pointer moves, so the
 *   travel is stepped: a single teleporting move gives dnd-kit one sample and
 *   an `over` that may still be the source column.
 * - The release waits for dnd-kit to SAY it is over the target, rather than
 *   for a duration. Under load the board can be slow enough that the last
 *   move is coalesced away, and a drop released on faith then resolves to
 *   whatever `over` was left over — silently, since `handleDragEnd` treats an
 *   unexpected `over` as a legitimate (different) drop.
 *
 * Aimed at the column's own droppable, which is what an EMPTY column offers;
 * dropping into a populated one resolves to a card instead, and
 * `dragCardOntoCard` is the helper for that.
 *
 * Returns the reorder route's status code once the write has answered — see
 * `awaitReorder`.
 */
export async function dragCardToColumn(
  page: Page,
  title: string,
  status: string
): Promise<number> {
  const card = ticketCardBody(page, title);
  const column = boardColumn(page, status);
  await expect(card).toBeVisible();
  await expect(column).toBeVisible();

  const reorder = awaitReorder(page);

  return performDrag(page, reorder, async () => {
    await beginDrag(page, card, title);

    const to = await column.boundingBox();
    if (!to) throw new Error(`no box for column "${status}"`);
    const endX = to.x + to.width / 2;
    // Below the column header, inside the card list — where a card would land.
    const endY = to.y + Math.min(to.height - 12, 90);

    await page.mouse.move(endX, endY, { steps: 24 });

    // The column renders its drop slot from `isOver`, so this element existing
    // IS dnd-kit reporting that the release will resolve here.
    await nudgeUntil(
      page,
      endX,
      endY,
      () =>
        page
          .getByTestId(`column-drop-target-${status}`)
          .count()
          .then((n) => n > 0),
      async () =>
        `dropping "${title}" never registered over the ${status} column; ` +
        `the board had the drop resolving to ${await currentDropColumn(page)}`
    );
  });
}

/**
 * Drags one card onto another — the same-column reorder gesture.
 *
 * Aimed at the target card's rect and released only once the board draws the
 * insertion preview: `verticalListSortingStrategy` displaces the target by a
 * whole card height while `over` is that card, so that DISPLACEMENT is
 * dnd-kit's own statement that the drop will land before it. Releasing on
 * arrival instead is what makes this gesture flaky under load — the collision
 * may still name the COLUMN, which `handleDragEnd` reads as "append", i.e. a
 * reorder request that writes the order back exactly as it was and reports
 * success. That failure is invisible in the response and only shows up as an
 * order that did not change.
 *
 * The displacement is measured, not merely detected. Asking whether the
 * transform is `none` does not work: the strategy's last branch returns
 * `{x: 0, y: 0}` for every card it is NOT displacing, which dnd-kit renders as
 * `translate3d(0px, 0px, 0)` and the browser computes as a matrix — so from
 * the first frame of any drag, every card in the column already has a
 * non-`none` transform and such a check passes before the pointer has gone
 * anywhere.
 *
 * Displacement on its own is still not enough, because it is ambiguous in
 * exactly the direction that matters. `SortableContext` derives `overIndex` as
 * `items.indexOf(over.id)`, so an `over` that is the COLUMN — whose id is not
 * in `items` — yields `-1`, and the strategy's `index >= overIndex` test is
 * then vacuously true for every card above the dragged one. A card displaces
 * identically whether the drop would land before it or append past the end of
 * the column, and appending is precisely the silent 200 this helper exists to
 * rule out. The column's drop slot is what separates the two: it is drawn from
 * that column's own `isOver`, so its ABSENCE is dnd-kit saying `over` is a
 * card. Both conditions together leave only one possibility.
 *
 * Returns the reorder route's status code — see `awaitReorder`.
 */
export async function dragCardOntoCard(
  page: Page,
  sourceTitle: string,
  targetTitle: string
): Promise<number> {
  const source = ticketCardBody(page, sourceTitle);
  const target = ticketCardBody(page, targetTitle);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();

  const reorder = awaitReorder(page);

  return performDrag(page, reorder, async () => {
    const from = await beginDrag(page, source, sourceTitle);

    const to = await target.boundingBox();
    if (!to) throw new Error(`no box for "${targetTitle}"`);
    const endX = to.x + to.width / 2;
    const endY = to.y + to.height / 2;

    await page.mouse.move(endX, endY, { steps: 20 });

    // Displaced by the dragged card's own height plus the list gap, so half of
    // that height is comfortably clear of zero while still tolerating the
    // 200ms transition dnd-kit animates the shift over.
    const minimumShift = Math.max(12, from.height / 2);

    await nudgeUntil(
      page,
      endX,
      endY,
      async () =>
        (await verticalShift(target)) >= minimumShift &&
        (await currentDropColumn(page)) === NO_COLUMN,
      async () =>
        `dropping "${sourceTitle}" never displaced "${targetTitle}", so the ` +
        `drop would have appended instead; the board had the drop resolving ` +
        `to ${await currentDropColumn(page)}`
    );
  });
}

/**
 * How far a card is currently shifted vertically by dnd-kit, in pixels.
 *
 * Read through `DOMMatrix` rather than by parsing the string: the computed
 * value is `matrix(...)` or `matrix3d(...)` depending on the browser and on
 * whether the transform was composited, and `m42` is the vertical translation
 * in both. `none` is the one value it cannot parse, and also the one that
 * means no transform at all — a resting board, before any drag.
 */
function verticalShift(card: Locator): Promise<number> {
  return card.evaluate((element) => {
    const { transform } = getComputedStyle(element);
    if (!transform || transform === "none") return 0;
    return Math.abs(new DOMMatrix(transform).m42);
  });
}

/**
 * Jiggles the pointer around a spot until the board agrees it is there.
 *
 * A pointer that has stopped moving produces no further collision passes, so
 * a board that was busy when the travel arrived would never recompute `over`
 * — polling alone cannot fix that, and a fixed sleep only hides it on a quiet
 * machine. Each iteration therefore emits a fresh move (alternating by a
 * pixel so the browser does not discard it as a no-op) and then re-reads the
 * board's own indication of where the drop would land.
 *
 * Throws rather than releasing anyway: a drop resolved somewhere else is a
 * different, plausible-looking gesture, and a test that let it through would
 * report on a move nobody asked for.
 */
async function nudgeUntil(
  page: Page,
  x: number,
  y: number,
  isOverTarget: () => Promise<boolean>,
  failure: () => Promise<string>,
  attempts = 60
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.mouse.move(x, y - (attempt % 2));
    if (await isOverTarget()) return;
  }
  // Built only once the gesture has actually failed: it interrogates the live
  // board for where the drop WOULD have landed, which is the one thing the
  // bare "it never arrived" message cannot say.
  throw new Error(await failure());
}

/**
 * Presses on a card and arms dnd-kit's drag, answering with the card's box.
 *
 * `hover()` rather than a bare move to a previously measured centre. Raw
 * `page.mouse` calls bypass every actionability check Playwright puts in front
 * of a normal action, and this board re-renders on its own — an SSE ticket
 * event, the refetch that follows the previous drag's write. A box measured
 * before such a re-render and pressed after it puts the pointer wherever the
 * layout has since moved, so no drag starts at all; the run then fails much
 * later and somewhere else, as a drop that "never registered over the column".
 * `hover()` waits for the card to be stable and hit-testable first, which is
 * exactly the guarantee the rest of this gesture assumes.
 *
 * Activation is then confirmed rather than trusted: the board renders a
 * `DragOverlay` copy for as long as a gesture is live, so that copy appearing
 * IS dnd-kit reporting the press cleared the `PointerSensor`'s 8px distance
 * constraint. Checking it here means a press that missed is reported as a
 * press that missed.
 */
async function beginDrag(
  page: Page,
  card: Locator,
  title: string
): Promise<{ height: number }> {
  await card.hover();
  const box = await card.boundingBox();
  if (!box) throw new Error(`no box to grab for "${title}"`);

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  // Past `activationConstraint: { distance: 8 }` — a press followed by a jump
  // straight to the target never arms a drag at all.
  await page.mouse.move(x + 12, y + 6, { steps: 4 });

  await expect(
    page.locator("[data-testid^='drag-overlay-card-']"),
    `pressing "${title}" never armed a drag`
  ).toHaveCount(1);

  return { height: box.height };
}

/**
 * Runs a drag gesture and guarantees the pointer is released afterwards.
 *
 * A failure mid-gesture would otherwise leave the mouse button down and dnd-kit
 * mid-drag: the next action in the test drags instead of clicking, and the
 * armed `awaitReorder` never settles, so the real error arrives buried under a
 * "Test ended" rejection from a promise nobody is waiting on any more. On the
 * failure path the drag is CANCELLED (Escape, which the board handles) rather
 * than dropped, so a gesture that went wrong cannot also write a move nobody
 * asked for.
 */
async function performDrag(
  page: Page,
  reorder: Promise<number>,
  gesture: () => Promise<void>
): Promise<number> {
  try {
    await gesture();
  } catch (error) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.up().catch(() => {});
    // Nothing will answer it now; swallow it so the gesture's error is what
    // the test reports.
    reorder.catch(() => {});
    throw error;
  }

  await page.mouse.up();
  await page.mouse.move(4, 4);
  return reorder;
}

/**
 * Which column the board is currently offering a drop slot in, for diagnostics.
 *
 * Exactly one column renders `column-drop-target-*` at a time (it is drawn from
 * that column's `isOver`), so this reads back dnd-kit's live answer to the
 * question a failed gesture got wrong.
 */
async function currentDropColumn(page: Page): Promise<string> {
  const slot = page.locator("[data-testid^='column-drop-target-']").first();
  if ((await slot.count()) === 0) return NO_COLUMN;
  const testId = await slot.getAttribute("data-testid");
  return testId?.replace("column-drop-target-", "") ?? NO_COLUMN;
}

/** No column is offering a slot — so dnd-kit's `over` is a card, or nothing. */
const NO_COLUMN = "no column at all";

/**
 * Waits for the write a drag triggers, and answers with its status code.
 *
 * Armed BEFORE the gesture, and awaited after it, because `postReorder` is
 * fire-and-forget: the board splices the card optimistically and only learns
 * the verdict when the response lands. A test that read the server — or
 * reloaded the page — on the strength of the rendered column alone would be
 * racing that request, and `page.reload()` would simply cancel it. This is
 * the only synchronisation point the board offers, so every drag goes
 * through it rather than through a poll with a guessed timeout.
 *
 * A refused move answers too (400 from the workflow guard), so this is not a
 * happy-path-only wait.
 */
function awaitReorder(page: Page): Promise<number> {
  return page
    .waitForResponse(
      (response) =>
        response.url().includes("/epics/reorder") &&
        response.request().method() === "POST",
      { timeout: 30_000 }
    )
    .then((response) => response.status());
}

/**
 * The board toast carrying `message` — move refusals and merge results.
 *
 * Toasts STACK: each lives five seconds of its own
 * (`app/projects/[projectId]/page.tsx`), so a board that has just refused a
 * move is often still showing that refusal when the next action succeeds.
 * Filtering is what makes an assertion about one of them well-defined —
 * addressing the stack as a whole is a strict-mode violation the moment a
 * second toast is up, and `toContainText` against it would equally be
 * satisfied by ANY toast on screen, including the stale one. Naming the
 * message means a lingering neighbour can neither break the check nor stand
 * in for the toast it was meant to prove.
 */
export function boardToast(page: Page, message: RegExp | string): Locator {
  return page.getByTestId("board-toast").filter({ hasText: message });
}
