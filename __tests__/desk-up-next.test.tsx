/**
 * The pool-blue stratum: the order Full Auto will pick from.
 *
 * Replaces the queue-rank half of the deleted
 * `kanban-board-dependency-visibility` suite: rank styling, blocked labels,
 * the "+N" overflow and the promise the band header makes in words.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { UpNextBand, chipRank } from "@/components/desk/UpNextBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type { DeskQueueTicket } from "@/lib/control-desk/types";

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01" },
  { id: "p2", name: "Ledger", createdAt: "2026-01-02" },
]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

function ticket(overrides: Partial<DeskQueueTicket> & { epicId: string }): DeskQueueTicket {
  return {
    projectId: "p1",
    readableId: `ARJ-${overrides.epicId}`,
    title: "Inline review findings",
    status: "todo",
    rank: 1,
    blockedBy: [],
    awaitingReply: false,
    specOnly: false,
    storyCount: 2,
    ...overrides,
  };
}

function renderBand(
  upNext: React.ComponentProps<typeof UpNextBand>["upNext"],
  onOpenTicket?: (epicId: string, event: React.MouseEvent) => void,
) {
  return render(
    <UpNextBand
      upNext={upNext}
      projectsById={projectsById}
      onOpenTicket={onOpenTicket}
    />,
  );
}

describe("band header", () => {
  it("carries the hint instead of a counter — deliberately", () => {
    renderBand([{ projectId: "p1", tickets: [ticket({ epicId: "1" })] }]);
    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(screen.getByText("the order Full Auto picks from")).toBeInTheDocument();
  });

  it("collapses to the label line when nothing is queued anywhere", () => {
    renderBand([{ projectId: "p1", tickets: [] }]);
    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(screen.queryByTestId("desk-up-next-row")).not.toBeInTheDocument();
    // No queue, no promise about an order.
    expect(
      screen.queryByText("the order Full Auto picks from"),
    ).not.toBeInTheDocument();
  });
});

describe("queue chips", () => {
  it("gives rank 1, rank 2 and everything else their own chip style", () => {
    renderBand([
      {
        projectId: "p1",
        tickets: [
          ticket({ epicId: "1", rank: 1 }),
          ticket({ epicId: "2", rank: 2 }),
          ticket({ epicId: "3", rank: 3 }),
        ],
      },
    ]);
    const chips = screen.getAllByTestId("desk-queue-chip");
    expect(chips.map((chip) => chip.getAttribute("data-rank"))).toEqual(["1", "2", "3"]);
    // Rank 3 keeps the geometry but drops the fill entirely.
    expect(chips[0].className).toContain("bg-card");
    expect(chips[1].className).toContain("bg-card-translucent");
    expect(chips[2].className).not.toContain("bg-card");
    expect(chips[2].className).toContain("px-[11px]");
  });

  it("labels an unranked, dependency-blocked ticket as blocked", () => {
    renderBand([
      {
        projectId: "p1",
        tickets: [ticket({ epicId: "125", rank: null, blockedBy: ["ARJ-131"] })],
      },
    ]);
    const chip = screen.getByTestId("desk-queue-chip");
    expect(chip).toHaveTextContent("ARJ-125 blocked");
    expect(chip).toHaveAttribute("data-rank", "3");
    // The prerequisite is named, resolved server-side from the whole project.
    expect(chip).toHaveAttribute("title", "Blocked by ARJ-131");
  });

  it("labels a ticket waiting on the user", () => {
    renderBand([
      {
        projectId: "p1",
        tickets: [ticket({ epicId: "9", rank: null, awaitingReply: true })],
      },
    ]);
    expect(screen.getByTestId("desk-queue-chip")).toHaveTextContent("ARJ-9 waiting");
  });

  it("marks a storyless feature as spec", () => {
    renderBand([
      { projectId: "p1", tickets: [ticket({ epicId: "31", specOnly: true })] },
    ]);
    expect(screen.getByTestId("desk-queue-chip")).toHaveTextContent(
      "ARJ-31 Inline review findings · spec",
    );
  });

  it("classifies every unranked ticket as the third style", () => {
    expect(chipRank(ticket({ epicId: "1", rank: null }))).toBe(3);
    expect(chipRank(ticket({ epicId: "1", rank: 7 }))).toBe(3);
  });
});

describe("row geometry", () => {
  it("turns the last slot into a +N chip past four tickets", () => {
    renderBand([
      {
        projectId: "p1",
        tickets: [1, 2, 3, 4, 5].map((n) => ticket({ epicId: String(n), rank: n })),
      },
    ]);
    // SLOTS is 4: three chips plus the overflow marker for the remaining two.
    expect(screen.getAllByTestId("desk-queue-chip")).toHaveLength(3);
    expect(screen.getByTestId("desk-queue-overflow")).toHaveTextContent("+2");
  });

  it("shows four tickets without an overflow marker", () => {
    renderBand([
      {
        projectId: "p1",
        tickets: [1, 2, 3, 4].map((n) => ticket({ epicId: String(n), rank: n })),
      },
    ]);
    expect(screen.getAllByTestId("desk-queue-chip")).toHaveLength(4);
    expect(screen.queryByTestId("desk-queue-overflow")).toBeNull();
  });

  /**
   * jsdom has no layout, so this asserts the CLASS rather than the paint. The
   * paint was checked in Chrome on a scratch stack: with `line-clamp-1` a
   * wrapped label put its second line BELOW the pill, sliced in half
   * (`scrollHeight` 50 against `clientHeight` 31); with `truncate` the chip is
   * one line with an ellipsis inside the pill. Four slots make chips narrow
   * enough that most labels wrap, so this guards the fourth slot as much as
   * the chip.
   */
  it("keeps a chip on one line — truncate, never a line clamp", () => {
    renderBand([
      {
        projectId: "p1",
        tickets: [
          ticket({
            epicId: "1",
            title: "Refonte complete du pipeline autonome avec garde-fous mecaniques",
          }),
        ],
      },
    ]);
    const chip = screen.getAllByTestId("desk-queue-chip")[0];
    expect(chip.className).toContain("truncate");
    expect(chip.className).not.toContain("line-clamp");
  });

  it("pads a short row so chips line up on the same four columns", () => {
    const { container } = renderBand([
      { projectId: "p1", tickets: [ticket({ epicId: "1" })] },
    ]);
    const spacer = container.querySelector('[aria-hidden="true"][style]');
    expect(spacer).toBeTruthy();
    expect(spacer).toHaveStyle({ flex: "3" });
  });

  it("names each project in its own identity colour", () => {
    renderBand([
      { projectId: "p1", tickets: [ticket({ epicId: "1" })] },
      { projectId: "p2", tickets: [ticket({ epicId: "2", projectId: "p2" })] },
    ]);
    expect(screen.getByText("ARIJ").className).toContain("text-project-1-deep");
    expect(screen.getByText("LEDGER").className).toContain("text-project-2-deep");
  });

  it("draws the rail label with the Mono primitive, not a hand-rolled run", () => {
    // Mono is what guarantees Space Mono and tabular-nums; a raw `font-mono`
    // run gets neither for free, and `font-bold` on the label is only honest
    // because Space Mono ships a real 700.
    renderBand([{ projectId: "p1", tickets: [ticket({ epicId: "1" })] }]);
    const label = screen.getByText("ARIJ");
    expect(label).toHaveAttribute("data-slot", "mono");
    expect(label.className).toContain("tabular-nums");
    expect(label.className).toContain("font-bold");
  });

  it("hides a project with an empty queue rather than drawing an empty row", () => {
    renderBand([
      { projectId: "p1", tickets: [ticket({ epicId: "1" })] },
      { projectId: "p2", tickets: [] },
    ]);
    expect(screen.getAllByTestId("desk-up-next-row")).toHaveLength(1);
  });
});

describe("interaction", () => {
  it("opens the ticket, and never offers a drag handle", () => {
    const onOpenTicket = vi.fn();
    renderBand(
      [{ projectId: "p1", tickets: [ticket({ epicId: "1" })] }],
      onOpenTicket,
    );
    const chip = screen.getByTestId("desk-queue-chip");
    fireEvent.click(chip);
    expect(onOpenTicket).toHaveBeenCalledWith("1", expect.anything());
    // Order is execution order — re-prioritising happens in the overlay.
    expect(chip).not.toHaveAttribute("draggable");
  });
});
