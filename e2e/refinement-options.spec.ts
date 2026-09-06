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
