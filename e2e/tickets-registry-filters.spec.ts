import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

// Real routes and database; no agent dispatch is needed for this read-only view.
test("filters tickets by project and exact state and sorts from headers", async ({ page, project }) => {
  const otherId = `${project.id}-other`;
  withDatabase((db) => {
    db.prepare("INSERT INTO projects (id, name, git_repo_path) VALUES (?, ?, ?)").run(otherId, "Other registry project", project.repoPath);
    const insert = db.prepare("INSERT INTO epics (id, project_id, title, status, priority, position) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(`${project.id}-a`, project.id, "Alpha registry ticket", "todo", 1, 1);
    insert.run(`${project.id}-z`, project.id, "Zulu registry ticket", "todo", 3, 0);
    insert.run(`${project.id}-r`, project.id, "Review registry ticket", "review", 2, 2);
    insert.run(`${project.id}-x`, otherId, "Other registry ticket", "todo", 0, 0);
  });
  try {
    await page.goto(`/tickets?project=${project.id}`);
    const rows = page.getByTestId("tickets-row");
    await expect(rows).toHaveCount(3);
    await page.getByRole("button", { name: /^État :/ }).click();
    await page.getByRole("menuitem", { name: "To Do", exact: true }).click();
    await expect(rows).toHaveCount(2);
    const titleHeader = page.getByRole("columnheader", { name: "Titre" });
    await titleHeader.getByRole("button").click();
    await expect(rows.first()).toContainText("Alpha registry ticket");
    await expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
    await titleHeader.getByRole("button").press("Enter");
    await expect(rows.first()).toContainText("Zulu registry ticket");
    await expect(titleHeader).toHaveAttribute("aria-sort", "descending");
    await page.getByRole("button", { name: /^Projet :/ }).click();
    await page.getByRole("menuitem", { name: "Other registry project", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Other registry ticket");
    await page.getByRole("button", { name: /^État :/ }).click();
    await page.getByRole("menuitem", { name: "Review", exact: true }).click();
    await expect(rows).toHaveCount(0);
    await page.getByRole("button", { name: /^Projet :/ }).click();
    await page.getByRole("menuitem", { name: "Tous les projets", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Review registry ticket");
    await page.getByRole("button", { name: /^État :/ }).click();
    await page.getByRole("menuitem", { name: "Tous les états", exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.screenshot({ path: "data/tickets-registry-filters.png", fullPage: true });
  } finally {
    withDatabase((db) => {
      db.prepare("DELETE FROM epics WHERE project_id = ?").run(otherId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(otherId);
    });
  }
});
