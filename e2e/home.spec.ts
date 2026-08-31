import { test, expect } from "./fixtures/arij-project";

test.describe("Control desk smoke", () => {
  test("home page loads with the Arij title", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle("Arij");
  });

  // "/" is the cross-project control desk now, not a project grid: the strata
  // are the page, and the project list lives in the global bar's chips — the
  // desk draws no header of its own any more.
  test("renders the Now desk and its strata under one header", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("now-desk")).toBeVisible();
    await expect(page.getByText("Working", { exact: true })).toBeVisible();
    await expect(page.getByTestId("top-bar")).toBeVisible();
    await expect(page.getByTestId("top-bar-project-chips")).toBeVisible();
    await expect(page.locator('[data-slot="desk-header"]')).toHaveCount(0);
  });

  test("shows the New Project entry point in the bar's chips", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator('a[href="/projects/new"]').first()).toBeVisible();
  });

  test("opens Spec & Memory from the global desk", async ({ page, project }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Project pages" }).click();
    await page
      .getByTestId(`desk-project-pages-${project.id}`)
      .locator("..")
      .getByRole("menuitem", { name: "Spec & Memory" })
      .click();

    await expect(page).toHaveURL(`/projects/${project.id}/spec`);
    await expect(page.getByRole("link", { name: "Spec & Memory" })).toBeVisible();
  });
});
