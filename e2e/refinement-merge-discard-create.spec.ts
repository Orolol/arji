import {
  expect, pinProjectAgents, test, unpinProjectAgents,
} from "./fixtures/arij-project";
import { openRegistry, openTicketDetail } from "./fixtures/board";
import { assertCliStubInstalled, cleanupScenarios, readInvocations, writeScenario } from "./fixtures/cli-stub";

/**
 * A board refinement pass that merges, discards and creates.
 *
 * Only the model's judgement is scripted: the scenario says which tools the
 * pass calls and with what, and everything else is Arij — the dispatch, the
 * session row, the prompt, the MCP token, the routes, their guards, the
 * permanent deletes, the end-of-run report and the board the user is left
 * looking at.
 *
 * The scenario is keyed on a ticket id like every other journey, but this
 * spawn has NO worktree (a planning pass runs in the project checkout), so it
 * resolves through the board snapshot in the prompt instead of the cwd.
 */
test.describe("Board refinement — merge, discard, create", () => {
  test.afterEach(async ({ request, project }) => {
    cleanupScenarios();
    await unpinProjectAgents(request, project.id);
  });

  test("folds two tickets into one, deletes an obsolete one and adds the missing one", async ({
    page, project, request, baseURL,
  }) => {
    test.setTimeout(300_000);
    await assertCliStubInstalled(request, baseURL!);
    await pinProjectAgents(request, project.id);

    const seed = async (data: Record<string, unknown>) => {
      const response = await request.post(`/api/projects/${project.id}/epics`, { data });
      expect(response.ok(), `seed failed: ${response.status()} ${await response.text()}`).toBeTruthy();
      return (await response.json()).data as { id: string; readableId: string | null };
    };

    const search = await seed({
      title: `Search the board ${project.id}`,
      description: "A search box over every ticket.",
      status: "backlog",
      priority: 1,
      userStories: [{ title: "Search by title", acceptanceCriteria: "Typing filters the list as you type" }],
    });
    const filters = await seed({
      title: `Search filters ${project.id}`,
      description: "Filter the search results by status and owner.",
      status: "backlog",
      userStories: [
        { title: "Filter by status", acceptanceCriteria: "Given a status filter, only matching rows show" },
        { title: "Filter by owner" },
      ],
    });
    const exporter = await seed({
      title: `Legacy CSV exporter ${project.id}`,
      description: "Export the board to the old CSV shape used by the 0.2 importer.",
      status: "backlog",
    });

    const mergedTitle = `Search the board, with filters ${project.id}`;
    const createdTitle = `Backfill the search index ${project.id}`;
    writeScenario(search.id, [
      {
        kind: "refinement",
        calls: [
          {
            tool: "merge_tickets",
            body: {
              ticket_id: search.id,
              source_ticket_ids: [filters.id],
              reason: "Filters are part of the same search screen — one ticket, one build.",
              title: mergedTitle,
              description: "A search box over every ticket, with status and owner filters on the results.",
            },
          },
          {
            tool: "discard_ticket",
            body: {
              ticket_id: exporter.id,
              reason: "The 0.2 importer is gone, so nothing reads the old CSV shape any more.",
            },
          },
          {
            tool: "create_planning_ticket",
            body: {
              title: createdTitle,
              description: "Search only covers rows written after the index landed.",
              priority: 2,
              reason: "The search epic covers new rows only — pre-existing tickets would never be findable.",
              user_stories: [
                { title: "Backfill job", acceptance_criteria: "Every ticket created before the index exists is searchable" },
              ],
            },
          },
        ],
        say: "Merged the two search tickets, dropped the exporter and filed the backfill.",
      },
    ]);

    // Dispatch through the board's own control, not the API.
    await openRegistry(page, project.id);
    const button = page.getByTestId("refinement-button");
    await expect(button).toBeEnabled({ timeout: 45_000 });
    const dispatched = page.waitForResponse(
      (r) => r.url().includes(`/projects/${project.id}/refinement`) && r.request().method() === "POST",
    );
    await button.click();
    await page.getByRole("button", { name: "Start refinement" }).click();
    const started = await dispatched;
    expect(started.ok(), await started.text()).toBeTruthy();
    expect((await started.json()).data.started).toBe(true);

    // The pass is done when the board stops carrying the two retired tickets.
    const boardTitles = async (): Promise<string[]> => {
      const response = await request.get(`/api/projects/${project.id}/epics`);
      if (!response.ok()) return ["<unreadable>"];
      return ((await response.json()).data as { title: string }[]).map((e) => e.title);
    };
    await expect
      .poll(boardTitles, { timeout: 120_000 })
      .toEqual(expect.arrayContaining([mergedTitle, createdTitle]));

    const titles = await boardTitles();
    expect(titles).not.toContain(filters.readableId ?? `Search filters ${project.id}`);
    expect(titles).not.toContain(`Search filters ${project.id}`);
    expect(titles).not.toContain(`Legacy CSV exporter ${project.id}`);

    // The stub stayed on script: three tool calls, every one accepted.
    const invocations = readInvocations(search.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].hasMcpChannel).toBe(true);
    expect(invocations[0].refinementCalls).toEqual([
      { tool: "merge_tickets", status: 200 },
      { tool: "discard_ticket", status: 200 },
      { tool: "create_planning_ticket", status: 201 },
    ]);

    // The merged ticket carries the absorbed scope, not just the absorbed title.
    const storiesResponse = await request.get(
      `/api/projects/${project.id}/user-stories?epicId=${search.id}`,
    );
    expect(
      storiesResponse.ok(),
      `stories read failed: ${storiesResponse.status()} ${await storiesResponse.text()}`,
    ).toBeTruthy();
    const stories = ((await storiesResponse.json()).data as { title: string; acceptanceCriteria: string | null }[]);
    expect(stories.map((s) => s.title)).toEqual([
      "Search by title",
      "Filter by status",
      "Filter by owner",
    ]);
    // The absorbed rubric came with the story — a merge that dropped it would
    // silently narrow the scope it claims to have preserved.
    expect(stories[1].acceptanceCriteria).toBe(
      "Given a status filter, only matching rows show",
    );

    // And what the user is left looking at.
    await openRegistry(page, project.id);
    const rows = page.getByTestId("tickets-row");
    await expect(rows.filter({ hasText: mergedTitle })).toHaveCount(1);
    await expect(rows.filter({ hasText: createdTitle })).toHaveCount(1);
    await expect(rows.filter({ hasText: `Search filters ${project.id}` })).toHaveCount(0);
    await expect(rows.filter({ hasText: `Legacy CSV exporter ${project.id}` })).toHaveCount(0);

    // The absorbed ticket's own text survives on the survivor's feed.
    const panel = await openTicketDetail(page, mergedTitle);
    await expect(panel).toContainText("Filters are part of the same search screen");
    await expect(panel).toContainText(filters.readableId ?? "Search filters");
  });
});
