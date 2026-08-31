/**
 * Tests for the ticket status option rules (lib/kanban/status-transitions):
 * the status control must mirror the workflow engine — only structural
 * transitions are selectable, to_merge → done is merge-gated (the merge IS
 * the approval), released is system-only, and a live session locks
 * in_progress.
 */
import { describe, it, expect } from "vitest";
import {
  ticketStatusOptions,
  isTicketTransitionSelectable,
  REASON_MERGE_REQUIRED,
  REASON_RELEASED_SYSTEM_ONLY,
  REASON_SESSION_RUNNING,
} from "@/lib/kanban/status-transitions";

function enabledStatuses(current: string, ctx?: { hasRunningSession?: boolean }) {
  return ticketStatusOptions(current, ctx)
    .filter((option) => option.enabled)
    .map((option) => option.status);
}

describe("ticketStatusOptions", () => {
  it("enables exactly the backlog transitions (todo, in_progress)", () => {
    expect(enabledStatuses("backlog")).toEqual(["todo", "in_progress"]);
  });

  it("enables exactly the todo transitions (backlog, in_progress)", () => {
    expect(enabledStatuses("todo")).toEqual(["backlog", "in_progress"]);
  });

  it("enables exactly the in_progress transitions without a running session", () => {
    expect(enabledStatuses("in_progress")).toEqual([
      "backlog",
      "todo",
      "review",
    ]);
  });

  it("enables exactly the review transitions (in_progress, to_merge)", () => {
    const options = ticketStatusOptions("review");
    const done = options.find((option) => option.status === "done");

    // Done is no longer structurally reachable from review — the merge
    // boundary (to_merge) sits between.
    expect(done?.enabled).toBe(false);
    expect(done?.disabledReason).toBe("No direct transition from Review");
    expect(options.filter((o) => o.enabled).map((o) => o.status)).toEqual([
      "in_progress",
      "to_merge",
    ]);
  });

  it("disables to_merge → done with the merge reason (workflow engine rule)", () => {
    const options = ticketStatusOptions("to_merge");
    const done = options.find((option) => option.status === "done");

    expect(done?.enabled).toBe(false);
    expect(done?.disabledReason).toBe(REASON_MERGE_REQUIRED);
    // Send-back edges stay selectable; Done only opens through the merge.
    expect(options.filter((o) => o.enabled).map((o) => o.status)).toEqual([
      "in_progress",
      "review",
    ]);
  });

  it("keeps done reachable only through the merge, never the dropdown", () => {
    expect(isTicketTransitionSelectable("review", "done")).toBe(false);
    expect(isTicketTransitionSelectable("to_merge", "done")).toBe(false);
    expect(isTicketTransitionSelectable("review", "to_merge")).toBe(true);
    expect(isTicketTransitionSelectable("review", "in_progress")).toBe(true);
  });

  it("disables the released target with the system-only reason from every source", () => {
    const fromDone = ticketStatusOptions("done").find(
      (option) => option.status === "released"
    );
    expect(fromDone?.enabled).toBe(false);
    expect(fromDone?.disabledReason).toBe(REASON_RELEASED_SYSTEM_ONLY);

    // done → in_progress / review stay enabled.
    expect(enabledStatuses("done")).toEqual(["in_progress", "review"]);
  });

  it("offers no transitions at all from released (terminal state)", () => {
    const options = ticketStatusOptions("released");
    expect(options.every((option) => !option.enabled)).toBe(true);
  });

  it("locks every in_progress transition while a session is running", () => {
    const options = ticketStatusOptions("in_progress", {
      hasRunningSession: true,
    });
    // Nothing is selectable from in_progress while the session is live.
    expect(enabledStatuses("in_progress", { hasRunningSession: true })).toEqual(
      []
    );
    // The structurally reachable targets carry the session reason; the
    // unreachable ones stay disabled with the structural reason.
    for (const status of ["backlog", "todo", "review"]) {
      const option = options.find((o) => o.status === status);
      expect(option?.enabled).toBe(false);
      expect(option?.disabledReason).toBe(REASON_SESSION_RUNNING);
    }
  });

  it("marks the current column as current and never selectable", () => {
    for (const status of ["backlog", "todo", "in_progress", "review", "to_merge", "done", "released"]) {
      const current = ticketStatusOptions(status).find(
        (option) => option.status === status
      );
      expect(current?.isCurrent).toBe(true);
      expect(current?.enabled).toBe(false);
    }
  });

  it("lists every board column exactly once, in column order", () => {
    expect(ticketStatusOptions("todo").map((option) => option.status)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "review",
      "to_merge",
      "done",
      "released",
    ]);
  });

  it("tolerates an unknown current status without crashing", () => {
    const options = ticketStatusOptions("mystery");
    expect(options).toHaveLength(7);
    expect(options.every((option) => !option.enabled || option.isCurrent)).toBe(
      true
    );
  });
});