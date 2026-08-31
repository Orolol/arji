import { test, expect } from "@playwright/test";

/**
 * The keyboard/accessibility audit that filed this reported the form as fully
 * tabbable but entirely unnamed: `getByLabel` resolved 0 elements for all three
 * fields, because each visual `<label>` had no `htmlFor` and did not wrap its
 * control. These specs assert the criterion in the audit's own terms — a real
 * accessible-name computation in a browser, not a query helper's approximation.
 */
test.describe("New Project form accessibility", () => {
  test("resolves every field by its visible label", async ({ page }) => {
    await page.goto("/projects/new");

    await expect(page.getByLabel("Project Name *")).toHaveCount(1);
    await expect(page.getByLabel("Description")).toHaveCount(1);
    await expect(page.getByLabel("Git Repository Path")).toHaveCount(1);

    await page.getByLabel("Project Name *").fill("Labelled by name");
    await expect(page.getByPlaceholder("My Awesome Project")).toHaveValue(
      "Labelled by name"
    );
  });

  test("names the required field's validation message to assistive technology", async ({
    page,
  }) => {
    await page.goto("/projects/new");

    const name = page.getByLabel("Project Name *");
    // Next mounts its own empty `role="alert"` route announcer on every page,
    // so scope the query to the form rather than to the document.
    const formAlert = page.locator("form").getByRole("alert");
    await expect(
      page.getByRole("button", { name: "Create Project" })
    ).toBeDisabled();

    await name.click();
    await page.getByLabel("Description").click();

    await expect(formAlert).toHaveText("Project name is required.");
    await expect(name).toHaveAttribute("aria-invalid", "true");

    await name.fill("Arij");
    await expect(formAlert).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create Project" })
    ).toBeEnabled();
  });
});
