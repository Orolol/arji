import { test, expect } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

// Uses only rows owned by its project fixture; never changes workspace settings.
test("release captions remain uppercase and old agents keep year ages", async ({ page, project }, info) => {
  test.setTimeout(90_000);
  const agentId = `i18n-age-${project.id}`;
  const releaseId = `i18n-release-${project.id}`;
  const oldDate = new Date(Date.now() - 425 * 86400000).toISOString();
  withDatabase((db) => {
    db.prepare("INSERT INTO named_agents (id, name, provider, model, created_at) VALUES (?, ?, 'claude-code', '', ?)").run(agentId, agentId, oldDate);
    db.prepare("INSERT INTO releases (id, project_id, version, created_at) VALUES (?, ?, '1.2.3', ?)").run(releaseId, project.id, new Date(Date.now() - 4 * 86400000).toISOString());
  });
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/projects/${project.id}/releases`);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      const tile = page.getByTestId("release-stat-current");
      await expect(tile).toContainText("4D AGO");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const screenshot = info.outputPath(`release-en-${width}.png`);
      await tile.screenshot({ path: screenshot });
      await info.attach(`release-en-${width}`, { path: screenshot, contentType: "image/png" });
    }
    withDatabase((db) => db.prepare("UPDATE releases SET created_at = ? WHERE id = ?").run(new Date().toISOString(), releaseId));
    await page.reload();
    await expect(page.getByTestId("release-stat-current")).toContainText("JUST NOW");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/agents");
    await page.getByTestId("agent-roster").getByText(agentId, { exact: true }).click();
    await expect(page.getByText("created 1y ago", { exact: true })).toBeVisible();
    const screenshot = info.outputPath("agent-year.png");
    await page.screenshot({ path: screenshot });
    await info.attach("agent-year", { path: screenshot, contentType: "image/png" });
  } finally {
    withDatabase((db) => {
      db.prepare("DELETE FROM named_agents WHERE id = ?").run(agentId);
    });
  }
});
