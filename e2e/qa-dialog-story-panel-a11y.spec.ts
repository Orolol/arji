import { test, expect, createEpic } from "./fixtures/arij-project";

/**
 * The browser half of the QA-dialog / story-panel label fix, in the same shape
 * as `new-project-form-a11y.spec.ts`: every field had a visual `<label>` with
 * no `htmlFor` that wrapped no control, so `getByLabel` resolved 0 elements
 * and the field was unnamed to assistive technology.
 *
 * These assertions run against Chrome's own accessible-name computation rather
 * than a query helper's approximation of it, which is what the unit files
 * (`__tests__/qa-check-dialog-labels.test.tsx`,
 * `__tests__/story-detail-panel-labels.test.tsx`) can only model in jsdom.
 */
test.describe("QA check dialog accessibility", () => {
  test("resolves every field by its visible label", async ({ page, project }) => {
    await page.goto(`/projects/${project.id}/qa`);
    await page.getByRole("button", { name: "New Check" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await expect(dialog.getByLabel("Check Type")).toHaveCount(1);
    // Named on every branch of NamedAgentSelect: with no named agent
    // configured the picker renders its "No agents configured" trigger, and a
    // picker only named once its agents arrive is still an unlabeled combobox.
    await expect(dialog.getByLabel("Named Agent (optional)")).toHaveCount(1);
    await expect(dialog.getByLabel("Saved Prompt")).toHaveCount(1);
    await expect(dialog.getByLabel("Custom Prompt (optional)")).toHaveCount(1);

    await dialog
      .getByLabel("Custom Prompt (optional)")
      .fill("Audit the label associations.");
    await expect(
      dialog.getByPlaceholder("Add custom QA instructions..."),
    ).toHaveValue("Audit the label associations.");
  });
});

test.describe("Story detail panel accessibility", () => {
  test("resolves every field by its visible label, in both edit states", async ({
    page,
    project,
    request,
  }) => {
    const epic = await createEpic(request, project.id, "Labelled story epic");
    const created = await request.post(
      `/api/projects/${project.id}/user-stories`,
      {
        data: {
          epicId: epic.id,
          title: "Name the story fields",
          description: "The panel must name its fields.",
          acceptanceCriteria: "Given a screen reader, the fields are named.",
        },
      },
    );
    expect(
      created.ok(),
      `story creation failed: ${created.status()} ${await created.text()}`,
    ).toBeTruthy();
    const { data: story } = (await created.json()) as { data: { id: string } };

    await page.goto(`/projects/${project.id}/stories/${story.id}`);

    await expect(page.getByLabel("Status")).toHaveCount(1);

    // Read state: the click-to-edit region is announced as a button carrying
    // the field's name, not as anonymous text.
    const description = page.getByRole("button", { name: "Description" });
    await expect(description).toBeVisible();
    await expect(page.getByLabel("Description")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Acceptance Criteria" }),
    ).toBeVisible();
    await expect(page.getByLabel("Acceptance Criteria")).toHaveCount(1);

    // The keyboard reaches it, and the name survives into the edit state.
    await description.press("Enter");
    const editor = page.getByLabel("Description");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveJSProperty("tagName", "TEXTAREA");
    await expect(editor).toHaveValue("The panel must name its fields.");

    // Leaving edit mode unmounts the focused textarea. Focus must land back on
    // the field rather than on <body>, or the next Tab restarts at the top of
    // the document and the keyboard user has to re-traverse the whole page
    // (WCAG 2.4.3). Measured in Chrome, not modelled in jsdom.
    await editor.press("Escape");
    await expect(description).toBeFocused();
    await expect(
      page.locator("body:focus"),
      "focus fell to <body> after Escape",
    ).toHaveCount(0);
  });

  test("does not pull focus back when the user leaves the editor deliberately", async ({
    page,
    project,
    request,
  }) => {
    const epic = await createEpic(request, project.id, "Focus boundary epic");
    const created = await request.post(
      `/api/projects/${project.id}/user-stories`,
      {
        data: {
          epicId: epic.id,
          title: "Respect a deliberate blur",
          description: "Focus belongs where the user put it.",
          acceptanceCriteria: "Given a blur, focus is not yanked back.",
        },
      },
    );
    const { data: story } = (await created.json()) as { data: { id: string } };

    await page.goto(`/projects/${project.id}/stories/${story.id}`);

    const description = page.getByRole("button", { name: "Description" });
    await description.press("Enter");
    await expect(page.getByLabel("Description")).toBeFocused();

    // Tabbing out is the user aiming somewhere else. The restore must not
    // fight that — the field is the one place focus may NOT end up.
    await page.keyboard.press("Tab");
    await expect(description).not.toBeFocused();
  });
});
