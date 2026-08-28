import {
  attachBranch,
  commitOnBranch,
  commitSubjects,
  createEpic,
  expect,
  localBranches,
  seedCompletedReview,
  storedEpicBranch,
  storedEpicStatus,
  test,
} from "./fixtures/arij-project";
import {
  boardToast,
  cardInColumn,
  dragCardToColumn,
  syncBoard,
} from "./fixtures/board";

/**
 * A ticket's whole journey: build, review, merge.
 *
 * Everything here is the real thing except the agent. The transitions run
 * through `lib/workflow/transition-service.ts`, the review gate is the
 * workflow engine's, the merge is the `git merge --no-ff` that
 * `POST /api/projects/:p/epics/:e/merge` runs against the fixture's scratch
 * repository, and the closing assertions read that repository's git history
 * rather than the board's opinion of it.
 *
 * What is NOT executed is the CLI child process a build or a review spawns.
 * A browser test cannot own one: it is slow, billed, and never twice the
 * same — the opposite of the stability this suite is held to. So the two
 * facts an agent run leaves behind are supplied directly: the branch it would
 * have committed (a real commit on a real branch) and the verdict it would
 * have filed through `submit_findings` (a real `agent_sessions` row, see
 * `seedCompletedReview`). Every guard that reads them is live, and the review
 * gate is exercised from BOTH sides — the drag to To Merge is refused before
 * the verdict exists and accepted after — so a gate that stopped running
 * fails this test instead of sailing through it.
 *
 * Each stage is judged on what the server stored, and the rendered board is
 * read only after a reload, for the reason set out at the top of
 * `kanban-drag.spec.ts`: a board GET that resolves late can currently overwrite
 * a completed move with the state before it (B-arij-141), so the drawn column
 * is not dependable evidence in the moments after a write.
 */
test.describe("Build to review to merge", () => {
  test("walks a ticket from Backlog to Done and lands its branch", async ({
    page,
    project,
    request,
  }) => {
    const title = `Shipping epic ${project.id}`;
    const epic = await createEpic(
      request,
      project.id,
      title,
      "Goes all the way to the base branch."
    );

    // The branch a build would have left behind. `mergeWorktree` refuses an
    // epic whose branch is absent from the repository, so this is what makes
    // the merge step a real git operation rather than a status write.
    const branch = `epic/${epic.readableId ?? epic.id}`.toLowerCase();
    const commitMessage = `Implement ${title}`;
    commitOnBranch({
      repoPath: project.repoPath,
      branch,
      filePath: "FEATURE.md",
      content: `# ${title}\n\nDelivered by the build stage.\n`,
      message: commitMessage,
    });
    await attachBranch(request, project.id, epic.id, branch);

    await page.goto(project.boardUrl);
    await expect(cardInColumn(page, "backlog", title)).toBeVisible();

    // --- Build ------------------------------------------------------------
    // Queued, picked up, delivered: the three columns a build moves its
    // target through.
    for (const status of ["todo", "in_progress", "review"] as const) {
      expect(
        await dragCardToColumn(page, title, status),
        `the build stage was refused entry to ${status}`
      ).toBe(200);
      expect(await storedEpicStatus(request, project.id, epic.id)).toBe(status);
      // The next leg drags out of this column, so the board has to be showing
      // the ticket where the server now has it.
      await syncBoard(page);
    }
    await expect(cardInColumn(page, "review", title)).toBeVisible();

    // --- Review, first from the closed side -------------------------------
    // No review has recorded a verdict yet, so the merge boundary is shut.
    // Asserted before the passing case on purpose: it is what proves the gate
    // below is a gate and not a formality.
    expect(await dragCardToColumn(page, title, "to_merge")).toBe(400);
    // Read from the refused response itself, so unlike the board it does not
    // depend on a refetch landing in order.
    await expect(boardToast(page, /no completed review/i)).toBeVisible();
    expect(await storedEpicStatus(request, project.id, epic.id)).toBe("review");

    await syncBoard(page);
    await expect(cardInColumn(page, "review", title)).toBeVisible();
    await expect(cardInColumn(page, "to_merge", title)).toHaveCount(0);

    // --- Review, now passed -----------------------------------------------
    seedCompletedReview({ projectId: project.id, epicId: epic.id });

    expect(
      await dragCardToColumn(page, title, "to_merge"),
      "an approved review did not open the merge boundary"
    ).toBe(200);
    expect(await storedEpicStatus(request, project.id, epic.id)).toBe("to_merge");

    // The merge is driven from the card, so the board has to be re-read from
    // the server before the button can be trusted to be the right one.
    await syncBoard(page);
    await expect(cardInColumn(page, "to_merge", title)).toBeVisible();

    // The column splits into "Ready to merge" and "Blocked". A card with a
    // branch and a passing review belongs to the first, which is also the
    // only section that offers the action.
    const readySection = page.getByTestId("column-section-to_merge-ready");
    await expect(readySection.locator("h4", { hasText: title })).toBeVisible();

    // --- Merge ------------------------------------------------------------
    const mergeButton = page.getByTestId(`epic-merge-${epic.id}`);
    await expect(mergeButton).toBeVisible();
    await mergeButton.click();

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
  });
});
