import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

// Real routes and database; no agent dispatch is needed for this read-only view.
test("filters tickets by project and exact state and sorts from headers", async ({ page, project }, testInfo) => {
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
    await page.getByRole("button", { name: /^State:/ }).click();
    await page.getByRole("menuitem", { name: "To Do", exact: true }).click();
    await expect(rows).toHaveCount(2);
    const titleHeader = page.getByRole("columnheader", { name: "Title" });
    await titleHeader.getByRole("button").click();
    await expect(rows.first()).toContainText("Alpha registry ticket");
    await expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
    await titleHeader.getByRole("button").press("Enter");
    await expect(rows.first()).toContainText("Zulu registry ticket");
    await expect(titleHeader).toHaveAttribute("aria-sort", "descending");
    await page.getByRole("button", { name: /^Project:/ }).click();
    await page.getByRole("menuitem", { name: "Other registry project", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Other registry ticket");
    await page.getByRole("button", { name: /^State:/ }).click();
    await page.getByRole("menuitem", { name: "Review", exact: true }).click();
    await expect(rows).toHaveCount(0);
    await page.getByRole("button", { name: /^Project:/ }).click();
    await page.getByRole("menuitem", { name: "All projects", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Review registry ticket");
    await page.getByRole("button", { name: /^State:/ }).click();
    await page.getByRole("menuitem", { name: "All states", exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("tickets-registry-filters.png"), fullPage: true });
  } finally {
    withDatabase((db) => {
      db.prepare("DELETE FROM epics WHERE project_id = ?").run(otherId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(otherId);
    });
  }
});


test("filtering keeps shipped prerequisites satisfied and real blockers readable", async ({ page, project }, testInfo) => {
  withDatabase((db) => {
    const insert = db.prepare("INSERT INTO epics (id, project_id, title, readable_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(`${project.id}-dep`, project.id, "Old shipped prerequisite", "ARJ-001", "done", "2020-01-01 00:00:00");
    for (let index = 0; index < 40; index++) {
      insert.run(`${project.id}-done-${index}`, project.id, `Recent shipped ${index}`, null, "done", "2026-09-05T08:00:00Z");
    }
    insert.run(`${project.id}-ready`, project.id, "Ready dependent", null, "todo", "2026-09-05T08:00:00Z");
    insert.run(`${project.id}-blocked`, project.id, "Blocked dependent", null, "todo", "2026-09-05T08:00:00Z");
    insert.run(`${project.id}-review`, project.id, "Review prerequisite", "ARJ-002", "review", "2026-09-05T08:00:00Z");
    const edge = db.prepare("INSERT INTO ticket_dependencies (id, project_id, scope_id, ticket_id, depends_on_ticket_id) VALUES (?, ?, ?, ?, ?)");
    edge.run(`${project.id}-edge1`, project.id, project.id, `${project.id}-ready`, `${project.id}-dep`);
    edge.run(`${project.id}-edge2`, project.id, project.id, `${project.id}-blocked`, `${project.id}-review`);
  });
  await page.goto(`/tickets?project=${project.id}`);
  await page.getByRole("button", { name: /^State:/ }).click();
  await page.getByRole("menuitem", { name: "To Do", exact: true }).click();
  const rows = page.getByTestId("tickets-row");
  await expect(rows).toHaveCount(2);
  const ready = rows.filter({ hasText: "Ready dependent" });
  const blocked = rows.filter({ hasText: "Blocked dependent" });
  await expect(ready).toContainText("#1");
  await expect(ready).not.toContainText("blocked");
  await expect(blocked).toContainText("ARJ-002");
  await expect(blocked).not.toContainText(`${project.id}-review`);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("tickets-registry-dependencies.png"), fullPage: true, animations: "disabled" });
});


/**
 * The filters ARE the URL (epic 5sCe4w0bxRYl).
 *
 * The unit coverage in `__tests__/tickets-registry-url-state.test.tsx` drives a
 * stand-in address bar; this is the real one — a real reload, a real Back and a
 * real Forward through Chrome's session history, against the real route.
 */
test("keeps the filters in the URL across a reload and browser history", async ({ page, project }, testInfo) => {
  const otherId = `${project.id}-url`;
  withDatabase((db) => {
    db.prepare("INSERT INTO projects (id, name, git_repo_path) VALUES (?, ?, ?)").run(otherId, "Other URL project", project.repoPath);
    const insert = db.prepare("INSERT INTO epics (id, project_id, title, status, priority, position) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(`${project.id}-scoped`, project.id, "Scoped registry ticket", "todo", 1, 0);
    insert.run(`${project.id}-other`, otherId, "Other URL ticket", "todo", 1, 0);
  });
  try {
    await page.goto(`/tickets?project=${project.id}`);
    const rows = page.getByTestId("tickets-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Scoped registry ticket");

    // Selecting another project moves the parameter with it, synchronously.
    await page.getByRole("button", { name: /^Project:/ }).click();
    await page.getByRole("menuitem", { name: "Other URL project", exact: true }).click();
    await expect(page).toHaveURL(`/tickets?project=${otherId}`);
    await expect(rows.first()).toContainText("Other URL ticket");

    // A sort and a state pill join it rather than replacing it.
    await page.getByRole("columnheader", { name: "Title" }).getByRole("button").click();
    await expect(page).toHaveURL(`/tickets?project=${otherId}&sort=titre`);
    await page.getByTestId("tickets-filter-done").click();
    await expect(page).toHaveURL(`/tickets?project=${otherId}&state=done&sort=titre`);
    await expect(rows).toHaveCount(0);

    // THE RELOAD the ticket is about: the screen comes back as it was left.
    await page.reload();
    await expect(page.getByTestId("tickets-filter-done")).toHaveAttribute("data-active", "true");
    await expect(page.getByRole("button", { name: /^Project:/ })).toContainText("Other URL project");
    await expect(page.getByRole("button", { name: /^sort:/ })).toContainText("title ↑");
    await expect(rows).toHaveCount(0);

    // Back walks the filters one gesture at a time; Forward replays them.
    await page.goBack();
    await expect(page).toHaveURL(`/tickets?project=${otherId}&sort=titre`);
    await expect(rows.first()).toContainText("Other URL ticket");
    await page.goBack();
    await expect(page).toHaveURL(`/tickets?project=${otherId}`);
    await page.goBack();
    await expect(page).toHaveURL(`/tickets?project=${project.id}`);
    await expect(rows.first()).toContainText("Scoped registry ticket");
    await page.goForward();
    await expect(page).toHaveURL(`/tickets?project=${otherId}`);
    await expect(rows.first()).toContainText("Other URL ticket");

    await page.screenshot({ path: testInfo.outputPath("tickets-registry-url-filters.png"), fullPage: true });
  } finally {
    withDatabase((db) => {
      db.prepare("DELETE FROM epics WHERE project_id = ?").run(otherId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(otherId);
    });
  }
});
