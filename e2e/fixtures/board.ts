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
  return page.getByTestId("tickets-row").filter({ hasText: title });
}

/** The registry includes Backlog and Done, which are absent from the desk. */
export async function openRegistry(page: Page, projectId?: string): Promise<void> {
  const currentProject = projectId ?? new URL(page.url()).pathname.match(/^\/projects\/([^/]+)/)?.[1];
  await page.goto(currentProject ? `/tickets?project=${currentProject}` : "/tickets");
}

/**
 * Clicks a ticket's card and returns the detail panel, already past its
 * loading state so callers can assert on real content.
 */
export async function openTicketDetail(page: Page, title: string): Promise<Locator> {
  if (new URL(page.url()).pathname !== "/tickets") await openRegistry(page);
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
  await expect(panel.getByTestId("ticket-status-control")).toBeVisible({ timeout: 45_000 });

  return panel;
}

/** Select a workflow edge through the same menu a user operates. */
export async function changeTicketStatus(page: Page, label: string): Promise<number> {
  await page.getByTestId("ticket-status-control").getByRole("button").click();
  const changed = page.waitForResponse(response =>
    /\/epics\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === "PATCH"
  );
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  return (await changed).status();
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
 * The two `Locator` members {@link naturalWidthOfLazyImage} touches.
 *
 * Narrower than `Locator` on purpose: `__tests__/lazy-image-assertion.test.ts`
 * drives the helper with a stub that reproduces the deferral, which is the only
 * way to pin this behaviour without a browser in the loop.
 */
export interface LazyImage {
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  evaluate<R>(pageFunction: (element: HTMLImageElement) => R): Promise<R>;
}

/**
 * `naturalWidth` of an image, after making sure the browser has actually been
 * asked to fetch it.
 *
 * Thumbnails render with `loading="lazy"`, so Chrome starts the request only
 * once the element comes near the viewport — and `Locator.evaluate()` runs no
 * actionability checks, so it never scrolls. Polling `evaluate` alone
 * therefore measures a race between the panel's layout and Chrome's lazy
 * threshold. Measured here on the suite's Chrome, with a lazy image 3000px
 * down a scroll container: fifteen `evaluate` ticks over three seconds left
 * `naturalWidth` at 0 having issued *zero* network requests, and the first
 * `scrollIntoViewIfNeeded()` fetched it. That failure mode is not slow, it is
 * stuck — no poll timeout can rescue a request that was never made.
 *
 * The scroll belongs inside the poll body rather than before it. It is
 * idempotent (a no-op once the element is in view), the detail panel can still
 * be settling when the first tick runs, and putting it there drops the
 * assumption that one scroll before the loop is enough. What is left to wait
 * for afterwards is the honest part: the serve round-trip, measured at ~1.4s
 * on a cold dev server compiling routes concurrently.
 *
 * Returns the width rather than asserting it, so the caller keeps the
 * assertion — bytes that come back broken still decode to 0 and still fail.
 */
export async function naturalWidthOfLazyImage(image: LazyImage): Promise<number> {
  await image.scrollIntoViewIfNeeded();
  return image.evaluate((element: HTMLImageElement) => element.naturalWidth);
}
