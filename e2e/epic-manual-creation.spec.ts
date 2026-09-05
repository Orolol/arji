import { expect, test } from "./fixtures/arij-project";
import { openNewMenu, openRegistry, openTicketDetail, ticketCard } from "./fixtures/board";

/**
 * The direct epic path end to end: New → New Epic (manual) → a filled form →
 * a card on the board carrying the stories that were typed into the modal.
 *
 * Deliberately drives the real routes rather than mocking `/epics`. The unit
 * tests already pin the draft rules, the payload shape and the "no agent call"
 * guarantee; what is left worth proving is that a form the user fills reaches
 * the database and comes back rendered.
 */
test.describe("Manual epic creation", () => {
  test("creates an epic with two user stories and shows them in the detail", async ({
    page,
    project,
  }) => {
    await page.goto(project.boardUrl);

    await openNewMenu(page, "header-new-epic-manual");

    const dialog = page.getByTestId("epic-create-dialog");
    await expect(dialog).toBeVisible();

    const epicTitle = `Manual epic ${project.id}`;
    await dialog.getByTestId("epic-title-input").fill(epicTitle);
    await dialog
      .getByTestId("epic-description-input")
      .fill("Written by hand — no agent involved.");

    await dialog.getByTestId("add-user-story").click();
    await dialog.getByTestId("add-user-story").click();

    const storyTitles = dialog.getByTestId("user-story-title-input");
    await expect(storyTitles).toHaveCount(2);

    const firstStory = `First story ${project.id}`;
    const secondStory = `Second story ${project.id}`;
    await storyTitles.nth(0).fill(firstStory);
    await storyTitles.nth(1).fill(secondStory);
    await dialog
      .getByTestId("user-story-criteria-input")
      .nth(0)
      .fill("- [ ] the criterion survives the round trip");

    await dialog.getByTestId("epic-create-submit").click();

    // The dialog only closes on a successful write, so this is also the
    // assertion that the route accepted what the form built.
    await expect(dialog).toBeHidden();

    await openRegistry(page, project.id);
    await expect(ticketCard(page, epicTitle)).toBeVisible();

    const panel = await openTicketDetail(page, epicTitle);
    await expect(
      panel.getByTestId("ticket-story-row")
    ).toHaveCount(2);
    await expect(panel.getByText(firstStory)).toBeVisible();
    await expect(panel.getByText(secondStory)).toBeVisible();
  });
});
