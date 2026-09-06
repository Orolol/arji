import { test, expect } from "./fixtures/arij-project";
import { openRegistry } from "./fixtures/board";

// Real rendered registry and dialog; dispatch is intercepted so this visual
// configuration journey never starts a paid agent. The separate refinement
// journey exercises dispatch and MCP writes with the CLI stub.
for (const width of [390, 768, 1280]) {
  test(`configures refinement at ${width}px`, async ({ page, project }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/agent-config/named-agents", (route) => route.fulfill({
      json: { data: [{ id: "chosen-refiner", name: "Planning agent", provider: "codex", model: "custom-model" }] },
    }));
    let submitted: unknown;
    await page.route(`**/api/projects/${project.id}/refinement`, async (route) => {
      if (route.request().method() === "POST") {
        submitted = route.request().postDataJSON();
        await route.fulfill({ json: { data: { started: false, reason: "Nothing to refine" } } });
      } else {
        await route.fulfill({ json: { data: { running: false, sessionId: null, ticketCount: 0 } } });
      }
    });
    await openRegistry(page, project.id);
    await page.getByTestId("refinement-button").click();
    const dialog = page.getByRole("dialog", { name: "Configure board refinement" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ animations: "disabled", path: `data/refinement-options-${width}-top.png` });
    await page.getByRole("combobox", { name: "Agent", exact: true }).click();
    await page.getByRole("option", { name: "Planning agent" }).click();
    for (const box of await dialog.getByRole("checkbox").all()) await box.uncheck();
    await expect(dialog.getByRole("button", { name: "Start refinement" })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: /Priorities and deprioritization/ }).check();
    await dialog.getByLabel("Additional instructions (optional)").fill("Deprioritize optional onboarding polish.");
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await dialog.getByRole("checkbox", { name: /Priorities and deprioritization/ }).focus();
    await page.keyboard.press("Tab");
    await page.screenshot({ animations: "disabled", path: `data/refinement-options-${width}.png` });
    await dialog.getByRole("button", { name: "Start refinement" }).focus();
    await page.screenshot({ animations: "disabled", path: `data/refinement-options-${width}-footer.png` });
    await dialog.getByRole("button", { name: "Start refinement" }).click();
    await expect(dialog).not.toBeVisible();
    expect(submitted).toEqual({ namedAgentId: "chosen-refiner", actions: ["priorities"], instructions: "Deprioritize optional onboarding polish." });
  });
}


for (const exit of ["Cancel", "Close", "Escape", "overlay"]) {
  test(`can exit with ${exit} after a conflicting refinement starts elsewhere`, async ({ page, project }) => {
    let running = false;
    await page.route(`**/api/projects/${project.id}/refinement`, async (route) => {
      if (route.request().method() === "POST") {
        running = true;
        await route.fulfill({ status: 409, json: {
          error: "A board refinement pass is already running for this project.",
          code: "REFINEMENT_ALREADY_RUNNING",
        } });
      } else {
        await route.fulfill({ json: { data: {
          running, sessionId: running ? "other-pass" : null, ticketCount: 1,
        } } });
      }
    });
    await openRegistry(page, project.id);
    await page.clock.install();
    await page.getByTestId("refinement-button").click();
    const dialog = page.getByRole("dialog", { name: "Configure board refinement" });
    await dialog.getByRole("button", { name: "Start refinement" }).click();
    await expect(page.getByText("A board refinement pass is already running for this project.")).toBeVisible();
    await page.clock.fastForward(31000);
    await expect(page.getByTestId("refinement-button-badge")).toHaveText("running");
    await expect(dialog.getByRole("button", { name: "Start refinement" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    if (exit === "Cancel") {
      await dialog.getByRole("button", { name: "Cancel" }).focus();
      await page.screenshot({ path: "data/refinement-concurrent-pass.png", animations: "disabled" });
    }
    if (exit === "Escape") await page.keyboard.press("Escape");
    else if (exit === "overlay") await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 5, y: 5 } });
    else await dialog.getByRole("button", { name: exit, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("refinement-button")).toBeDisabled();
  });
}
