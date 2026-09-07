import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

for (const scope of ["global", "project"] as const) {
  test(`${scope} composer confirms a real creation and opens its ticket`, async ({ page, project }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(scope === "global" ? "/" : project.boardUrl);
    const input = page.getByRole("textbox", { name: "Describe a feature" });
    await expect(input).toBeEnabled();
    // The cross-project desk has no project of its own, so the composer falls
    // back to `projects[0]` (DeskComposer.tsx) — under `fullyParallel` that is
    // whichever project another worker happened to seed first, and the ticket
    // would be written there while the toast still appeared here. Target this
    // fixture's project by name, which the worker index keeps unique.
    // NOT done for the `project` scope: that run's subject IS the route's own
    // project being the default.
    if (scope === "global") {
      await page.getByTestId("desk-project-select").click();
      await page.getByRole("menuitem", { name: project.name, exact: true }).click();
    }
    const title = `Notification ${scope} ${project.id}`;
    await input.fill(title);
    await input.press("Enter");
    const toast = page.getByRole("status").filter({ hasText: title });
    await expect(toast).toBeVisible();
    const ticket = withDatabase((db) => db.prepare("SELECT id FROM epics WHERE project_id = ? AND title = ?").get(project.id, title)) as { id: string };
    expect(ticket).toBeTruthy();
    const link = toast.getByRole("link", { name: "View the ticket" });
    await expect(link).toHaveAttribute("href", `/projects/${project.id}?ticket=${ticket.id}`);
    await expect(input).toHaveValue("");
    await toast.hover();
    await page.screenshot({ path: `data/toast-${scope}.png` });
    await link.click();
    await expect(page.getByTestId("ticket-overlay")).toBeVisible();
    await expect(page.getByTestId("ticket-overlay")).toContainText(title);
    expect(browserErrors).toEqual([]);
  });
}

test("creation errors stay visible and preserve the draft on a narrow screen", async ({ page, project }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/projects/${project.id}/epics`, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 400, json: { error: "Création refusée pour ce test" } });
    } else await route.continue();
  });
  await page.goto(project.boardUrl);
  const input = page.getByRole("textbox", { name: "Describe a feature" });
  await expect(input).toBeEnabled();
  await input.fill("Mon brouillon");
  await input.press("Enter");
  const toast = page.getByRole("alert").filter({ hasText: "Création refusée" });
  await expect(toast).toBeVisible();
  await expect(input).toHaveValue("Mon brouillon");
  const bounds = await toast.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "data/toast-mobile.png" });
  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toBeHidden();
});
