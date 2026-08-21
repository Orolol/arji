import { expect, test } from "./fixtures/arij-project";
import { openNewMenu, openTicketDetail, pasteImage, ticketCard } from "./fixtures/board";

/**
 * The screenshot path end to end: New → New Bug → Ctrl/Cmd+V → a bug whose
 * thumbnail is still there in the ticket detail afterwards.
 *
 * This is the one scenario the unit tests cannot stand in for. They mock
 * `/chat/upload` and never touch disk, so nothing else proves the pasted bytes
 * survive upload → `epics.images` → the serve route the thumbnail points at.
 */
test.describe("Bug creation with a pasted screenshot", () => {
  test("keeps a pasted screenshot visible in the ticket detail", async ({
    page,
    project,
  }) => {
    await page.goto(project.boardUrl);

    await openNewMenu(page, "header-new-bug");

    const dialog = page.getByTestId("bug-create-drop-zone");
    await expect(dialog).toBeVisible();

    const bugTitle = `Pasted screenshot bug ${project.id}`;
    await dialog.getByPlaceholder("Bug title...").fill(bugTitle);

    // Pasted onto the modal itself, which is the whole drop/paste target —
    // not just the description field.
    await pasteImage(dialog, "clipboard-shot.png");

    const staged = dialog.getByTestId("image-attachment-strip").locator("img");
    await expect(staged).toHaveCount(1);

    await dialog.getByRole("button", { name: "Create Bug" }).click();
    await expect(dialog).toBeHidden();

    await expect(ticketCard(page, bugTitle)).toBeVisible();

    const panel = await openTicketDetail(page, bugTitle);
    const thumbnails = panel.getByTestId("ticket-images").locator("img");
    await expect(thumbnails).toHaveCount(1);

    // The element rendering is not enough: assert the browser actually decoded
    // bytes served back for that path, so a broken src fails here.
    await expect
      .poll(() => thumbnails.first().evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    // Clicking it opens the full-size view.
    await thumbnails.first().click();
    const lightbox = page.getByTestId("image-lightbox");
    await expect(lightbox.locator("img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
  });
});
