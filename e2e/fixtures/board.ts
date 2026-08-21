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
  await expect(panel.getByText("Loading...")).toHaveCount(0);

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
