import { createEpic, expect, storedEpicStatus, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

test("keeps the Piscine desk balanced and re-arms dismissed signals on a new failure", async ({
  page, request, project,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(project.boardUrl);
  const desk = page.getByTestId("now-desk");
  const band = desk.locator('[data-slot="strata-band"][data-stratum="you"]');
  await expect(band).toBeVisible();
  const emptyHeight = (await band.boundingBox())!.height;
  expect(emptyHeight).toBeLessThan(75);
  const ids: string[] = [];
  const at = new Date().toISOString();
  for (let i = 0; i < 6; i++) {
    const epic = await createEpic(request, project.id, `Failure ${i} ${project.id}`);
    ids.push(epic.id);
    withDatabase(db => db.prepare(
      "INSERT INTO agent_sessions (id, project_id, epic_id, status, agent_type, error, created_at, ended_at) VALUES (?, ?, ?, 'failed', 'build', ?, ?, ?)"
    ).run(`failure-${epic.id}`, project.id, epic.id, `Fixture failure ${i}`, at, at));
    if (i === 0) {
      await page.reload();
      await expect(page.getByTestId("desk-failed-row")).toHaveCount(1);
      const oneHeight = (await band.boundingBox())!.height;
      expect(oneHeight).toBeGreaterThan(emptyHeight);
      expect(oneHeight).toBeLessThan(180);
    }
  }
  await page.reload();
  await expect(page.getByTestId("desk-failed-row")).toHaveCount(6);
  expect((await band.boundingBox())!.height).toBeLessThanOrEqual(286);
  const list = page.getByTestId("desk-your-turn-rows");
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.getByTestId("desk-your-turn-overflow")).toBeVisible();
  expect((await desk.locator('[data-stratum="live"]').first().boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect((await desk.locator('[data-slot="strata-band"][data-stratum="land"]').locator("..").boundingBox())!.height).toBeGreaterThanOrEqual(168);
  await page.screenshot({ path: testInfo.outputPath("desk-six-failures.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1300 });
  await expect.poll(async () => {
    const measuredHidden = await list.evaluate(el => {
      const fold = el.getBoundingClientRect().bottom;
      return Array.from(el.children).filter(child => child.getBoundingClientRect().bottom > fold + 1).length;
    });
    return page.getByTestId("desk-your-turn-overflow").innerText().then(text => text.includes(`+${measuredHidden}`));
  }).toBe(true);

  const first = page.getByTestId("desk-failed-row").filter({ hasText: "Fixture failure 0" });
  const dismissed = page.waitForResponse(r => r.url().endsWith("/api/desk/dismiss") && r.request().method() === "POST");
  await first.getByTestId("desk-dismiss").focus();
  await page.keyboard.press("Enter");
  expect((await dismissed).ok()).toBe(true);
  await expect(first).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("desk-failed-row")).toHaveCount(5);
  expect(await storedEpicStatus(request, project.id, ids[0])).toBe("backlog");
  const nextAt = new Date(Date.now() + 1000).toISOString();
  withDatabase(db => db.prepare("UPDATE agent_sessions SET ended_at = ? WHERE id = ?").run(nextAt, `failure-${ids[0]}`));
  await expect(first).toHaveCount(1, { timeout: 10_000 });

  // A running session + a configured local repository reproduce both old
  // conditional mounts. The desk now owns the live session alone.
  withDatabase(db => db.prepare(
    "INSERT INTO agent_sessions (id, project_id, epic_id, status, agent_type, started_at, created_at) VALUES (?, ?, ?, 'running', 'build', ?, ?)"
  ).run(`live-${ids[0]}`, project.id, ids[0], nextAt, nextAt));
  await page.reload();
  await expect(page.getByTestId("agent-monitor")).toHaveCount(0);
  await expect(page.getByTestId("repo-status-bar")).toHaveCount(0);
  await expect(desk.locator('[data-stratum="live"]').first()).toContainText(`Failure 0 ${project.id}`);
  await page.goto(`/projects/${project.id}/git-sync`);
  await expect(page.getByTestId("repo-ahead")).toBeVisible();
  await expect(page.getByTestId("repo-fetch-button")).toBeVisible();
  await expect(page.getByTestId("repo-push-button")).toBeVisible();
});

test("centres Now and keeps eight project chips clear of the navigation island", async ({
  page, request, project,
}, testInfo) => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 7; i++) {
      const res = await request.post("/api/projects", { data: { name: `Navigation ${i} ${project.id}` } });
      expect(res.ok()).toBeTruthy();
      ids.push((await res.json()).data.id);
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto("/");
    const now = page.getByTestId("top-bar-bubble-now");
    await expect(now).toHaveAttribute("aria-current", "page");
    expect(await now.getAttribute("aria-haspopup")).toBeNull();
    await expect(page.getByTestId("top-bar-home")).toHaveText("A");
    const chips = page.getByTestId("top-bar-project-chips");
    await expect(chips.getByRole("link")).toHaveCount(9);
    const islandBox = (await page.getByTestId("top-bar-island").boundingBox())!;
    const chipsBox = (await chips.boundingBox())!;
    expect(chipsBox.x + chipsBox.width).toBeLessThan(islandBox.x);
    expect(await chips.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await now.hover();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await now.evaluate(el => getComputedStyle(el).cursor)).toBe("pointer");
    await page.screenshot({ path: testInfo.outputPath("navigation-eight-projects.png"), fullPage: true });
    await page.goto("/tickets");
    expect(await now.getAttribute("aria-current")).toBeNull();
    await now.click();
    await expect(page).toHaveURL(/\/$/);
  } finally {
    for (const id of ids) await request.delete(`/api/projects/${id}`);
  }
});
