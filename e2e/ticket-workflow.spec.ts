import { createEpic, expect, storedEpicStatus, test } from "./fixtures/arij-project";
import { changeTicketStatus, openRegistry, openTicketDetail, ticketCard } from "./fixtures/board";

// The registry and status menu replace the retired draggable Kanban columns.
test("changes a ticket status from its overlay and preserves workflow guards", async ({ page, project, request }) => {
  const title = `Workflow ${project.id}`;
  const epic = await createEpic(request, project.id, title);
  await openRegistry(page, project.id);
  await expect(ticketCard(page, title)).toBeVisible();
  const panel = await openTicketDetail(page, title);
  await panel.getByTestId("ticket-status-control").getByRole("button").click();
  await expect(page.getByRole("menuitem", { name: "Done", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Released", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await changeTicketStatus(page, "To Do")).toBe(200);
  expect(await storedEpicStatus(request, project.id, epic.id)).toBe("todo");
  await expect(panel.getByTestId("ticket-status-control")).toContainText("To Do");
  await panel.getByTestId("ticket-overlay-close").click();
  await page.reload();
  const reopened = await openTicketDetail(page, title);
  await expect(reopened.getByTestId("ticket-status-control")).toContainText("To Do");
  expect(await changeTicketStatus(page, "Backlog")).toBe(200);
  expect(await storedEpicStatus(request, project.id, epic.id)).toBe("backlog");
});
