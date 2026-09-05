import { createEpic, expect, storedEpicStatus, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";
import { assertCliStubInstalled, cleanupScenarios, readInvocations, writeScenario } from "./fixtures/cli-stub";

// This case changes workspace defaults: keep it off a reused personal server.
test("persists Full Auto agents, resolves project overrides and dispatches the selected roles", async ({
  page, request, project, baseURL,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await assertCliStubInstalled(request, baseURL!);
  const agentIds: string[] = [];
  const original = (await (await request.get("/api/settings")).json()).data;
  const keys = ["auto_mode_build_agent", "auto_mode_review_agent"];
  try {
    for (const role of ["workspace build", "workspace review", "project build"]) {
      const res = await request.post("/api/agent-config/named-agents", {
        data: { name: `${project.id} ${role}`, provider: "claude-code", model: "sonnet" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      agentIds.push((await res.json()).data.id);
    }
    await page.goto("/settings");
    const enabled = page.getByTestId("full-auto-master");
    // Enable only the draft while choosing defaults. Save with its original
    // value so other projects are never armed by this test.
    const wasEnabled = await enabled.getAttribute("aria-checked") === "true";
    if (!wasEnabled) await enabled.click();
    for (const [testId, role] of [["auto-build-agent", "workspace build"], ["auto-review-agent", "workspace review"]]) {
      await page.getByTestId(testId).getByRole("button").click();
      await page.getByRole("menuitem", { name: `${project.id} ${role}`, exact: true }).click();
    }
    if (!wasEnabled) await enabled.click();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await page.reload();
    await expect(page.getByTestId("auto-build-agent")).toContainText(`${project.id} workspace build`);
    await expect(page.getByTestId("auto-review-agent")).toContainText(`${project.id} workspace review`);
    const global = (await (await request.get("/api/settings")).json()).data;
    expect(global.auto_mode_build_agent).toBe(agentIds[0]);
    expect(global.auto_mode_review_agent).toBe(agentIds[1]);
    expect(global[`auto_mode_build_agent:${project.id}`]).toBeUndefined();

    // No tickets are ready yet, so arming the project cannot dispatch.
    await page.goto("/");
    await page.getByTestId("desk-full-auto").click();
    const row = page.getByTestId(`full-auto-row-${project.id}`);
    await row.getByRole("checkbox").click();
    await expect(row.getByRole("checkbox")).toBeChecked();
    await row.getByRole("button", { name: `${project.id} workspace build`, exact: true }).click();
    await page.getByRole("menuitem", { name: `${project.id} project build`, exact: true }).click();
    const config = async () => (await (await request.get(`/api/projects/${project.id}/auto-mode`)).json()).data;
    await expect.poll(async () => (await config()).buildAgent).toBe(agentIds[2]);
    await expect(row.getByRole("button", { name: `${project.id} project build`, exact: true })).toBeVisible();
    await row.getByRole("button", { name: `${project.id} project build`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Default", exact: true }).click();
    await expect.poll(async () => (await config()).buildAgent).toBe(agentIds[0]);
    // Choose the override again; the ensuing real dispatch proves precedence.
    await row.getByRole("button", { name: `${project.id} workspace build`, exact: true }).click();
    await page.getByRole("menuitem", { name: `${project.id} project build`, exact: true }).click();
    await expect.poll(async () => (await config()).buildAgent).toBe(agentIds[2]);
    await page.keyboard.press("Escape");

    const epic = await createEpic(request, project.id, `Auto delivery ${project.id}`);
    writeScenario(epic.id, [
      { kind: "build", file: "AUTO.md", content: "# Automatically delivered\n",
        message: "Deliver Full Auto fixture", say: "Implemented and committed the requested feature." },
      { kind: "review", verdict: "approved", findings: [], summary: "The requested feature is implemented.",
        say: "Finished checking the change." },
    ]);
    const ready = await request.patch(`/api/projects/${project.id}/epics/${epic.id}`, { data: { status: "todo" } });
    expect(ready.ok(), await ready.text()).toBeTruthy();
    // A settings write kicks the supervisor immediately.
    const armed = await request.put(`/api/projects/${project.id}/auto-mode`, {
      data: { enabled: true, secondOpinion: false },
    });
    expect(armed.ok(), await armed.text()).toBeTruthy();
    await expect.poll(() => storedEpicStatus(request, project.id, epic.id), { timeout: 120_000 }).toBe("done");
    const sessions = withDatabase(db => db.prepare(
      "SELECT named_agent_id AS agent, agent_type AS role, status FROM agent_sessions WHERE epic_id = ? ORDER BY created_at, rowid"
    ).all(epic.id)) as { agent: string; role: string; status: string }[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ agent: agentIds[2], status: "completed" });
    expect(sessions[1]).toMatchObject({ agent: agentIds[1], status: "completed" });
    expect(readInvocations(epic.id).map(i => i.kind)).toEqual(["build", "review"]);
  } finally {
    await request.put(`/api/projects/${project.id}/auto-mode`, { data: { enabled: false, buildAgent: null, reviewAgent: null } });
    await request.patch("/api/settings", { data: Object.fromEntries(keys.map(key => [key, original[key] ?? ""])) });
    for (const id of agentIds) await request.delete(`/api/agent-config/named-agents/${id}`);
    withDatabase(db => {
      for (const key of keys) {
        if (!(key in original)) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      }
      db.prepare("DELETE FROM settings WHERE substr(key, -?) = ?").run(project.id.length + 1, `:${project.id}`);
    });
    cleanupScenarios();
  }
});

/**
 * The band's master switch is the BARE `auto_mode_enabled`; arming one project
 * from the desk writes `auto_mode_enabled:<projectId>`, which the supervisor
 * reads FIRST. The two workspace-default pills therefore keep deciding which
 * agent runs that project's unattended work while this screen's switch is off,
 * and they must stay operable.
 *
 * A REAL BROWSER IS THE POINT. The bug had two halves — `disabled` on the
 * button, and `pointer-events-none` on the dimmed body around it. jsdom loads
 * no stylesheet, so it can only see the first; Playwright's actionability
 * check ("receives pointer events") is what covers the second. The click here
 * is the exact one that timed out on the report.
 */
test("keeps the workspace default agents editable while the bare master is off", async ({
  page, request, project,
}) => {
  page.setDefaultTimeout(15_000);
  const original = (await (await request.get("/api/settings")).json()).data;
  const keys = ["auto_mode_enabled", "auto_mode_build_agent"];
  let agentId: string | null = null;
  try {
    const created = await request.post("/api/agent-config/named-agents", {
      data: { name: `${project.id} bare-off build`, provider: "claude-code", model: "sonnet" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    agentId = (await created.json()).data.id;

    // The workspace master OFF, one project armed on its own — the state the
    // desk popover produces, and the one the band used to lock the user out of.
    await request.patch("/api/settings", { data: { auto_mode_enabled: false } });
    const armed = await request.put(`/api/projects/${project.id}/auto-mode`, {
      data: { enabled: true, secondOpinion: false },
    });
    expect(armed.ok(), await armed.text()).toBeTruthy();
    const stored = (await (await request.get("/api/settings")).json()).data;
    expect(stored[`auto_mode_enabled:${project.id}`]).toBe(true);

    await page.goto("/settings");
    await expect(page.getByTestId("full-auto-master")).toHaveAttribute("aria-checked", "false");
    // Dim stays: the band still says Full Auto is not armed workspace-wide.
    await expect(page.getByTestId("full-auto-body")).toHaveAttribute("aria-disabled", "true");
    // …and so does the disable, for every control the master really suspends.
    await expect(page.getByTestId("auto-smart-dispatch")).toBeDisabled();

    await page.getByTestId("auto-build-agent").getByRole("button").click();
    await page.getByRole("menuitem", { name: `${project.id} bare-off build`, exact: true }).click();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-save")).toBeDisabled();

    await page.reload();
    await expect(page.getByTestId("auto-build-agent")).toContainText(`${project.id} bare-off build`);
    // The BARE key, still — a bare-off master does not turn this screen into
    // an editor of the armed project's override.
    const after = (await (await request.get("/api/settings")).json()).data;
    expect(after.auto_mode_build_agent).toBe(agentId);
    expect(after[`auto_mode_build_agent:${project.id}`]).toBeUndefined();
  } finally {
    await request.put(`/api/projects/${project.id}/auto-mode`, { data: { enabled: false } });
    await request.patch("/api/settings", {
      data: Object.fromEntries(keys.map(key => [key, original[key] ?? ""])),
    });
    if (agentId) await request.delete(`/api/agent-config/named-agents/${agentId}`);
    withDatabase(db => {
      for (const key of keys) {
        if (!(key in original)) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      }
      db.prepare("DELETE FROM settings WHERE substr(key, -?) = ?").run(project.id.length + 1, `:${project.id}`);
    });
  }
});
