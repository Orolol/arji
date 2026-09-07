import { test, expect, createEpic } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";
import { en } from "../lib/i18n/messages";
import type { Page, TestInfo } from "@playwright/test";

const keyLeak = new RegExp(`\\b(?:${Object.keys(en).join("|")})\\.[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)*`);

async function checkScreen(page: Page, url: string, text: string, info: TestInfo) {
  const errors: string[] = [];
  const record = (error: Error) => errors.push(error.message);
  page.on("pageerror", record);
  try {
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    await expect(page.locator("main .animate-spin")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Loading...");
    // Project SSE streams deliberately stay open; visible content is the load signal.
    await expect(page.locator("body")).not.toContainText(keyLeak);
    await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error/);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const name = url.replaceAll("/", "_").replaceAll("?", "_");
    const screenshotPath = info.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshotPath });
    await info.attach(name, { path: screenshotPath, contentType: "image/png" });
  } finally {
    page.off("pageerror", record);
  }
}

for (const width of [1280, 390]) {
  test(`English global surfaces and server settings tabs at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    for (const [url, copy] of [
      ["/", "Working"], ["/tickets", "Tickets"], ["/qa", "QA"],
      ["/chat", "Chat"], ["/agents", "Add agent"],
      ["/agents/assignments", "Assignments"], ["/agents/prompts", "Prompts"],
      ["/agents/limits", "Limits"], ["/usage", "Refresh"], ["/inbox", "Inbox"],
      ["/settings", "Workspace"], ["/settings/pipeline", "Pipeline"],
      ["/settings/integrations", "Integrations"], ["/settings/appearance", "Appearance"],
      ["/projects/new", "project"], ["/projects/import", "Import"], ["/tickets/new", "New"],
    ]) await checkScreen(page, url, copy, info);
  });

  test(`English project surfaces, ticket and session at ${width}px`, async ({ page, project, request }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const epic = await createEpic(request, project.id, "Localization browser evidence");
    const sessionId = `i18n-session-${project.id}`;
    const reportId = `i18n-report-${project.id}`;
    withDatabase((db) => {
      db.prepare("INSERT INTO agent_sessions (id, project_id, epic_id, status, outcome, agent_type, provider, created_at, ended_at) VALUES (?, ?, ?, 'completed', 'success', 'ticket_build', 'claude-code', ?, ?)")
        .run(sessionId, project.id, epic.id, "2026-09-01T10:00:00Z", "2026-09-01T10:01:00Z");
      db.prepare("INSERT INTO qa_reports (id, project_id, status, report_content, summary, check_type, created_at, completed_at) VALUES (?, ?, 'completed', 'Evidence from a deterministic browser fixture.', 'Browser evidence', 'tech_check', ?, ?)")
        .run(reportId, project.id, "2026-09-01T10:00:00Z", "2026-09-01T10:01:00Z");
    });
    const base = `/projects/${project.id}`;
    for (const [suffix, copy] of [
      ["", "Working"], ["/spec", "Spec"], ["/qa", "QA"],
      ["/releases", "Next release"], ["/sessions", "Sessions"],
      ["/documents", "Documents"], ["/frictions", "Frictions"],
      ["/github-issues", "GitHub Issue Triage"], ["/git-sync", "Git"], ["/settings", "Settings"],
      [`/sessions/${sessionId}`, "Prompt"], [`?ticket=${epic.id}`, "Conversation"],
    ]) await checkScreen(page, `${base}${suffix}`, copy, info);
    // The existing mobile header can squeeze its title to zero width (B-arij-270).
    // Pin the dialog identity and the translated conversation surface independently.
    await expect(page.getByRole("dialog", { name: epic.title })).toBeVisible();
  });
}
