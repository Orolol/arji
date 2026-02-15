import { describe, expect, it } from "vitest";
import {
  getActiveDetailTicketId,
  selectOnlyTicket,
  toggleTicketSelection,
} from "@/lib/kanban/selection";

describe("kanban selection ordering", () => {
  it("selects only the clicked ticket for primary selection", () => {
    expect(selectOnlyTicket("epic-1")).toEqual(["epic-1"]);
  });

  it("appends additive selections while preserving insertion order", () => {
    const selected = toggleTicketSelection(["epic-1"], "epic-2");
    expect(selected).toEqual(["epic-1", "epic-2"]);
    expect(getActiveDetailTicketId(selected)).toBe("epic-1");
  });

  it("promotes the next-oldest ticket when the first-selected ticket is removed", () => {
    const selected = toggleTicketSelection(["epic-1", "epic-2", "epic-3"], "epic-1");
    expect(selected).toEqual(["epic-2", "epic-3"]);
    expect(getActiveDetailTicketId(selected)).toBe("epic-2");
  });

  it("closes the detail panel when no tickets remain selected", () => {
    const selected = toggleTicketSelection(["epic-1"], "epic-1");
    expect(selected).toEqual([]);
    expect(getActiveDetailTicketId(selected)).toBeNull();
  });
});
