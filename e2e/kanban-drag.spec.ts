import {
  createEpic,
  expect,
  storedColumnOrder,
  storedEpicStatus,
  test,
} from "./fixtures/arij-project";
import {
  boardColumn,
  boardToast,
  cardInColumn,
  dragCardOntoCard,
  dragCardToColumn,
  syncBoard,
} from "./fixtures/board";

/**
 * Kanban drag-and-drop, driven by a real pointer.
 *
 * dnd-kit is the part of the board no unit test reaches: `handleDragEnd`'s
 * inputs are an `active`/`over` pair that a sensor, a collision-detection pass
 * and a set of measured rects produce together, and jsdom lays nothing out —
 * so every column, card and drop index resolved there is decided by geometry a
 * component test does not have. What the assertions below are about is
 * therefore the OUTCOME of a drag: what the server stored, and what the board
 * draws once it re-reads it.
 *
 * Each accepted move is paired with the refusal on the other side of the same
 * boundary. A suite that only proved the permitted drag works could not tell a
 * live workflow guard from one that has quietly stopped running: the board
 * splices the card optimistically either way, and only the server's answer
 * says which of the two happened — which is why every drag here waits for that
 * answer rather than for the card to look as if it moved.
 *
 * ## Why the rendered board is only read after a reload
 *
 * The state the board shows in the moments after a write is not currently
 * trustworthy, and that is a product bug rather than a property of these
 * tests: `loadEpics` applies every board GET unconditionally, so a refresh
 * issued before a reorder commits but resolving after the optimistic splice
 * overwrites the board with the pre-move order — and nothing schedules another
 * refetch, so the stale render survives. Filed as B-arij-141, with the probe
 * output that separates the two sides.
 *
 * So each drag is judged on what the server STORED, and the rendered column is
 * asserted after an explicit `syncBoard`, which re-derives it from that
 * same stored state. Reloading between the legs of a multi-step drag is not
 * bookkeeping either: `handleDragEnd` computes the move from what the board
 * currently believes, so dragging from a stale render would post a transition
 * out of a column the ticket is no longer in. When B-arij-141 is fixed these
 * can tighten to assert the optimistic render directly, and would then double
 * as its regression test.
 */
test.describe("Kanban drag-and-drop", () => {
  test("moves an epic between columns and persists the transition", async ({
    page,
    project,
    request,
  }) => {
    const title = `Draggable epic ${project.id}`;
    const epic = await createEpic(request, project.id, title);

    await page.goto(project.boardUrl);
    await expect(cardInColumn(page, "backlog", title)).toBeVisible();

    expect(await dragCardToColumn(page, title, "todo")).toBe(200);

    // The server's answer is what separates "the board moved the card" from
    // "the move was accepted": the rendered column is an optimistic splice,
    // and it looks identical for a move the reorder route went on to reject.
    expect(await storedEpicStatus(request, project.id, epic.id)).toBe("todo");

    await syncBoard(page);
    await expect(cardInColumn(page, "todo", title)).toBeVisible();
    await expect(cardInColumn(page, "backlog", title)).toHaveCount(0);
  });

  test("carries a ticket forward one column at a time", async ({
    page,
    project,
    request,
  }) => {
    const title = `Forward-marching epic ${project.id}`;
    const epic = await createEpic(request, project.id, title);

    await page.goto(project.boardUrl);

    // backlog → in_progress and in_progress → review are separate edges of the
    // epic state machine (lib/workflow/engine.ts); a drag that works for one
    // says nothing about the other.
    let from = "backlog";
    for (const status of ["in_progress", "review"] as const) {
      await expect(cardInColumn(page, from, title)).toBeVisible();

      expect(
        await dragCardToColumn(page, title, status),
        `the drag to ${status} was refused`
      ).toBe(200);
      expect(await storedEpicStatus(request, project.id, epic.id)).toBe(status);

      // Re-derive the board from the server before the next leg, so the drag
      // starts from the column the ticket is actually in.
      await syncBoard(page);
      from = status;
    }

    await expect(cardInColumn(page, "review", title)).toBeVisible();
  });

  test("refuses a drag the workflow forbids and puts the card back", async ({
    page,
    project,
    request,
  }) => {
    const title = `Undraggable epic ${project.id}`;
    const epic = await createEpic(request, project.id, title);

    await page.goto(project.boardUrl);
    await expect(cardInColumn(page, "backlog", title)).toBeVisible();

    // Backlog's only outbound edges are To Do and In Progress. Review is two
    // steps away, so this is a structurally invalid transition rather than a
    // guard the board could satisfy by trying harder.
    expect(await dragCardToColumn(page, title, "review")).toBe(400);

    // The toast is read straight from the refused response, so unlike the
    // board it does not depend on a refetch landing in order.
    await expect(boardToast(page, /Invalid transition/i)).toBeVisible();
    expect(await storedEpicStatus(request, project.id, epic.id)).toBe("backlog");

    await syncBoard(page);
    await expect(cardInColumn(page, "backlog", title)).toBeVisible();
    await expect(cardInColumn(page, "review", title)).toHaveCount(0);
  });

  test("reorders inside a column and keeps the new rank", async ({
    page,
    project,
    request,
  }) => {
    const first = `Rank one ${project.id}`;
    const second = `Rank two ${project.id}`;
    await createEpic(request, project.id, first);
    await createEpic(request, project.id, second);

    await page.goto(project.boardUrl);

    const rendered = () =>
      boardColumn(page, "backlog").locator("h4").allTextContents();

    await expect.poll(rendered).toEqual([first, second]);

    // Same-column drags take the other branch of `handleDragEnd`: the drop
    // resolves to a CARD rather than to a column, and the index it lands at is
    // what `epics.position` is rewritten from.
    expect(await dragCardOntoCard(page, second, first)).toBe(200);

    // Positions are the board's execution order, so the ranking has to be
    // stored, not merely drawn. This also distinguishes the reorder from the
    // append a drop on the column body would have produced — that one answers
    // 200 as well, and leaves the order exactly as it was.
    expect(
      await storedColumnOrder(request, project.id, "backlog"),
      "the drop did not re-rank the column"
    ).toEqual([second, first]);

    await syncBoard(page);
    await expect
      .poll(rendered, { message: "the new rank did not survive a reload" })
      .toEqual([second, first]);
  });
});
