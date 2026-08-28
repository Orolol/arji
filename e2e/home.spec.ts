import { test, expect } from "@playwright/test";

test.describe("Control desk smoke", () => {
  test("home page loads with the Arij title", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle("Arij");
  });

  // "/" is the cross-project control desk now, not a project grid: the strata
  // are the page, and the project list lives in the header rail.
  test("renders the Now desk and its strata", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("now-desk")).toBeVisible();
    await expect(page.getByText("Working", { exact: true })).toBeVisible();
    await expect(page.getByTestId("desk-project-rail")).toBeVisible();
  });

  test("shows the New Project entry point in the project rail", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator('a[href="/projects/new"]').first()).toBeVisible();
  });
});
