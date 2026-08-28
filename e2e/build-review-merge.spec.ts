import {
  commitSubjects,
  createEpic,
  epicFindings,
  epicSessions,
  expect,
  localBranches,
  pinProjectAgents,
  storedEpicBranch,
  storedEpicStatus,
  test,
  unpinProjectAgents,
} from "./fixtures/arij-project";
import {
  boardToast,
  cardInColumn,
  dragCardToColumn,
  openTicketDetail,
  syncBoard,
} from "./fixtures/board";
import {
  assertCliStubInstalled,
  cleanupScenarios,
  readInvocations,
  writeScenario,
} from "./fixtures/cli-stub";

/**
 * A ticket's whole journey: build, review, merge.
 *
 * Everything here is the real thing except the model. The build is dispatched
 * from the ticket's own "Send to Dev" button, which posts to
 * `POST /api/projects/:p/epics/:e/build` — so the worktree, the assembled
 * prompt, the session row, the scheduler, the MCP token and every workflow
 * transition the route drives are the product's. The review is dispatched from
 * "Agent Review" and its verdict arrives the way a reviewer's does: a real
 * `submit_findings` call over that session's own bearer token, which is what
 * `lib/pipeline/findings.ts` reads and what moves the ticket to To Merge. The
 * merge is the `git merge --no-ff` the merge route runs against the fixture's
 * scratch repository, and the closing assertions read that repository's git
 * history rather than the board's opinion of it.
 *
 * What is NOT executed is the CLI child process those two dispatches spawn. A
 * browser test cannot own one: it is slow, billed, and never twice the same —
 * the opposite of the stability this suite is held to. So the CLI, and only
 * the CLI, is replaced: `e2e/fixtures/cli-stub` is a scripted agent that Arij
 * spawns by name off the dev server's PATH, commits in the worktree it was
 * given, and files its verdict through the session's MCP channel. The script
 * is written before the dispatch and what the stub actually did is read back
 * afterwards, so a journey cannot pass on an agent that never ran.
 *
 * The gate is exercised from BOTH sides — To Merge is refused while no review
 * has recorded a verdict, and accepted once one has — so a gate that stopped
 * running fails this test instead of sailing through it.
 *
 * Each stage is judged on what the server stored, and the rendered board is
 * read only after a reload, for the reason set out at the top of
 * `kanban-drag.spec.ts`: a board GET that resolves late can currently overwrite
 * a completed move with the state before it (B-arij-141), so the drawn column
 * is not dependable evidence in the moments after a write.
 */
test.describe("Build to review to merge", () => {
  test.afterEach(async ({ request, project }) => {
    cleanupScenarios();
    await unpinProjectAgents(request, project.id);
  });

  test("walks a ticket from Backlog to Done through a real build and review", async ({
    page,
    project,
    request,
    baseURL,
  }) => {
    /**
     * Well past the suite's 90s default, because this case is a different
     * shape from the rest: it runs two real agent sessions end to end, with a
     * guarded refusal, two board resyncs and a `git merge` between them.
     * Measured at 103s against a warm single-worker server (build delivered
     * 34s, merge gate refused 68s, verdict 89s, merged 103s) — the budget
     * below is that plus room for the route compilation of a cold `next dev`
     * and for the four workers that share it.
     *
     * Headroom, not blindness: every wait inside is on a named event, so a
     * stage that genuinely hangs still fails with what it was waiting for.
     */
    test.setTimeout(300_000);
    // Before anything is dispatched: prove this server spawns the stub. A
    // suite pointed at a dev server started without it would otherwise send a
    // build prompt to the developer's real CLI.
    await assertCliStubInstalled(request, baseURL!);
    await pinProjectAgents(request, project.id);

    const title = `Shipping epic ${project.id}`;
    const epic = await createEpic(
      request,
      project.id,
      title,
      "Goes all the way to the base branch."
    );

    const commitMessage = `Implement ${title}`;
    writeScenario(epic.id, [
      {
        kind: "build",
        file: "FEATURE.md",
        content: `# ${title}\n\nDelivered by the build stage.\n`,
        message: commitMessage,
        say: "Implemented the feature and committed it on the epic branch.",
      },
      {
        kind: "review",
        verdict: "approved",
        summary: "Read the diff; the change does what the ticket asks.",
        // One non-blocking finding: `review_comments` is the table the review
        // UI renders, and a verdict that files nothing would leave the write
        // path uncovered. `minor` on purpose — a critical or major one is an
        // open blocking finding and would (correctly) hold the ticket.
        findings: [
          {
            file_path: "FEATURE.md",
            line: 1,
            body: "The heading could name the ticket id.",
            severity: "minor",
          },
        ],
        say: "Reviewed the diff. One small remark, nothing that holds the merge.",
      },
    ]);

    await page.goto(project.boardUrl);
    await expect(cardInColumn(page, "backlog", title)).toBeVisible();

    // --- Build -------------------------------------------------------------
    // Dispatched the way a user does it, from the ticket's actions bar. The
    // route moves the epic to In Progress before the session row exists and
    // the terminal handler promotes it to Review once the agent delivers, so
    // the two transitions asserted below are the product's own.
    const panel = await openTicketDetail(page, title);
    const settingsLoaded = page.waitForResponse((response) =>
      response.url().includes("/api/settings")
    );
    await panel.getByRole("button", { name: "Send to Dev" }).click();

    const devDialog = page.getByRole("dialog");
    await expect(devDialog.getByText("Send Epic to Dev")).toBeVisible();
    // The checkbox is initialised from `pipeline_enabled` once that fetch
    // lands. This journey is about the plain dispatch, so the pipeline is
    // turned off explicitly rather than left to the developer's settings —
    // and the session count asserted at the end is what would catch a
    // pipeline that ran anyway.
    await settingsLoaded;
    const pipelineCheckbox = devDialog.getByTestId("pipeline-checkbox");
    await pipelineCheckbox.uncheck();
    await expect(pipelineCheckbox).not.toBeChecked();

    // Awaited on the dispatch RESPONSE, not just on the dialog closing: a
    // refused dispatch leaves the dialog open (AgentActionsBar's
    // `handleSendToDev` swallows the rejection into `onActionError`), so
    // without this it fails as an inscrutable "dialog is still visible"
    // instead of naming the status and body that caused it.
    const buildDispatched = page.waitForResponse(
      (response) =>
        response.url().includes(`/epics/${epic.id}/build`) &&
        response.request().method() === "POST"
    );
    await devDialog.getByRole("button", { name: "Dispatch Agent" }).click();
    const buildResponse = await buildDispatched;
    expect(
      buildResponse.ok(),
      `build dispatch was refused: ${buildResponse.status()} ${await buildResponse.text()}`
    ).toBeTruthy();
    /**
     * Generous on purpose. Both dispatch dialogs close only once
     * `useAgentDispatch`'s follow-up `/api/projects/:p/sessions/active` poll
     * has resolved — the dialog is gated on that poll, not on the dispatch
     * that already returned 200 above. Measured at 7.7s with the suite's four
     * workers sharing one `next dev`, which overruns the 15s default often
     * enough to matter.
     *
     * Still an assertion, not a shrug: a dialog that never closes — a
     * dispatch the UI silently swallowed — fails here.
     */
    await expect(devDialog).toBeHidden({ timeout: 45_000 });

    await expect
      .poll(() => storedEpicStatus(request, project.id, epic.id), {
        message: "the build never delivered the ticket to Review",
        timeout: 60_000,
      })
      .toBe("review");

    // The session the route created, as the product stored it.
    const afterBuild = await epicSessions(request, project.id, epic.id);
    expect(afterBuild.map((session) => session.agentType)).toEqual(["build"]);
    expect(afterBuild[0]).toMatchObject({
      status: "completed",
      provider: "claude-code",
      outcome: "answered",
    });

    // The build's own commit, on the branch the route cut for the epic. This
    // is what makes the merge below a real git operation rather than a status
    // write: nothing in this test manufactured it.
    const branch = afterBuild[0].branchName;
    expect(branch, "the build session recorded no branch").toBeTruthy();
    expect(await storedEpicBranch(request, project.id, epic.id)).toBe(branch);
    expect(commitSubjects(project.repoPath, branch!)).toContain(commitMessage);

    // --- The merge boundary, first from the closed side --------------------
    // No review has recorded a verdict yet. Asserted before the passing case
    // on purpose: it is what proves the gate below is a gate and not a
    // formality.
    await syncBoard(page);
    await expect(cardInColumn(page, "review", title)).toBeVisible();

    expect(await dragCardToColumn(page, title, "to_merge")).toBe(400);
    // Read from the refused response itself, so unlike the board it does not
    // depend on a refetch landing in order.
    await expect(boardToast(page, /no completed review/i)).toBeVisible();
    expect(await storedEpicStatus(request, project.id, epic.id)).toBe("review");

    await syncBoard(page);
    await expect(cardInColumn(page, "review", title)).toBeVisible();
    await expect(cardInColumn(page, "to_merge", title)).toHaveCount(0);

    // --- Review ------------------------------------------------------------
    const reviewPanel = await openTicketDetail(page, title);
    await reviewPanel.getByRole("button", { name: "Agent Review" }).click();

    const reviewDialog = page.getByRole("dialog");
    await expect(reviewDialog.getByText("Epic Agent Review")).toBeVisible();
    const reviewDispatched = page.waitForResponse(
      (response) =>
        response.url().includes(`/epics/${epic.id}/review`) &&
        response.request().method() === "POST"
    );
    await reviewDialog.getByRole("button", { name: "Run Review (1)" }).click();
    const reviewResponse = await reviewDispatched;
    expect(
      reviewResponse.ok(),
      `review dispatch was refused: ${reviewResponse.status()} ${await reviewResponse.text()}`
    ).toBeTruthy();
    // Same follow-up poll as the build dialog above.
    await expect(reviewDialog).toBeHidden({ timeout: 45_000 });

    // The promotion below can only come from the structured verdict: the
    // stub's final message carries no prose verdict for the fallback scan to
    // read, so a broken MCP channel leaves the ticket in Review.
    await expect
      .poll(() => storedEpicStatus(request, project.id, epic.id), {
        message: "an approving review verdict did not open the merge boundary",
        timeout: 60_000,
      })
      .toBe("to_merge");

    const afterReview = await epicSessions(request, project.id, epic.id);
    expect(afterReview.map((session) => session.agentType)).toEqual([
      "build",
      "review_feature",
    ]);
    expect(afterReview[1]).toMatchObject({
      status: "completed",
      provider: "claude-code",
      reviewVerdict: "approved",
    });

    // The finding the reviewer filed, attributed to the session that filed it.
    const findings = await epicFindings(request, project.id, epic.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      status: "open",
      filePath: "FEATURE.md",
      agentSessionId: afterReview[1].id,
    });
    expect(findings[0].body).toContain("[minor]");

    // --- Merge -------------------------------------------------------------
    // Driven from the card, so the board has to be re-read from the server
    // before the button can be trusted to be the right one.
    await syncBoard(page);
    await expect(cardInColumn(page, "to_merge", title)).toBeVisible();

    // The column splits into "Ready to merge" and "Blocked". A card with a
    // branch and a passing review belongs to the first, which is also the
    // only section that offers the action.
    const readySection = page.getByTestId("column-section-to_merge-ready");
    await expect(readySection.locator("h4", { hasText: title })).toBeVisible();

    const mergeButton = page.getByTestId(`epic-merge-${epic.id}`);
    await expect(mergeButton).toBeVisible();
    // Awaited on the merge RESPONSE before the toast, for the same reason the
    // dispatches are: a real `git merge --no-ff`, worktree removal and branch
    // delete can outlast a 15s assertion window on a loaded dev server, and
    // the toast auto-dismisses after 5s (`addToast`,
    // app/projects/[projectId]/page.tsx). Asserting the toast first would then
    // fail as "element not found" for a merge that was merely slow — and a
    // merge the route REFUSED would report the same thing.
    const merged = page.waitForResponse(
      (response) =>
        response.url().includes(`/epics/${epic.id}/merge`) &&
        response.request().method() === "POST",
      { timeout: 90_000 }
    );
    await mergeButton.click();
    const mergeResponse = await merged;
    expect(
      mergeResponse.ok(),
      `merge was refused: ${mergeResponse.status()} ${await mergeResponse.text()}`
    ).toBeTruthy();

    await expect(boardToast(page, /Merged into the base branch/i)).toBeVisible();
    await expect
      .poll(() => storedEpicStatus(request, project.id, epic.id), {
        message: "the merge did not close the ticket",
      })
      .toBe("done");

    await syncBoard(page);
    await expect(cardInColumn(page, "done", title)).toBeVisible();

    // The point of the whole walk: the work is on the base branch of a real
    // repository. A board showing Done without this would be lying.
    const subjects = commitSubjects(project.repoPath, "main");
    expect(subjects, "the epic's commit never reached main").toContain(
      commitMessage
    );
    expect(subjects, "no merge commit was recorded").toContain(
      `Merge ${branch}`
    );

    // `mergeWorktree` deletes the branch it landed and the route clears the
    // epic's pointer to it — a Done ticket has nothing left to merge.
    expect(localBranches(project.repoPath)).not.toContain(branch);
    expect(await storedEpicBranch(request, project.id, epic.id)).toBeNull();

    // --- What the agent boundary actually saw -------------------------------
    // Read last, and asserted rather than assumed: these records are the only
    // proof that the two promotions above came from agent runs the product
    // dispatched, and not from something that moved the ticket on its own.
    const invocations = readInvocations(epic.id);
    expect(
      invocations.map((invocation) => invocation.kind),
      "the journey did not spawn exactly one build agent and one review agent"
    ).toEqual(["build", "review"]);
    expect(invocations.every((invocation) => invocation.ok)).toBe(true);
    // Both stages are spawned with the Arij tool channel; the review needs it
    // to file anything at all.
    expect(invocations.map((invocation) => invocation.hasMcpChannel)).toEqual([
      true,
      true,
    ]);
    expect(invocations[1].submitFindings).toMatchObject({
      status: 200,
      verdict: "approved",
    });
    // Each agent was spawned in the epic's own worktree, with a prompt
    // carrying the ticket it was dispatched for.
    for (const invocation of invocations) {
      expect(invocation.cwd).toContain(".arij-worktrees");
      expect(invocation.prompt).toContain(title);
    }
  });
});
