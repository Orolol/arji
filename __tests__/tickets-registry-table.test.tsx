/**
 * The registry screen, rendered.
 *
 * Everything here is a promise the frame makes: the seven accented column
 * headers, group headers carrying the TRUE total, an empty group rendering
 * nothing at all, the frame's truncation caps, single-select state pills with
 * exactly one filled control, and em-dashes where a figure does not exist.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const openTicket = vi.fn();
vi.mock("@/components/ticket/TicketOverlayProvider", () => ({
  useTicketOverlay: () => ({
    ticketId: null,
    projectId: null,
    open: false,
    openTicket,
    closeTicket: vi.fn(),
  }),
  TicketOverlayProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const setWindow = vi.fn();
let payload: TicketsRegistryPayload | null = null;
let loadError: string | null = null;

vi.mock("@/components/tickets-registry/useTicketsRegistry", () => ({
  useTicketsRegistry: () => ({
    data: payload,
    loading: payload === null,
    error: loadError,
    window: { done: 40, released: 40 },
    refresh: vi.fn(),
    setWindow,
  }),
}));

const { TicketsRegistryView } = await import(
  "@/components/tickets-registry/TicketsRegistryView"
);
const { deriveProjects } = await import("@/lib/control-desk/aggregate");

import type { RegistryRow, TicketsRegistryPayload } from "@/lib/tickets-registry/types";

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "p2", name: "Ledger", createdAt: "2026-01-02T00:00:00.000Z" },
]);

function row(overrides: Partial<RegistryRow> & { epicId: string }): RegistryRow {
  return {
    projectId: "p1",
    readableId: `ARJ-${overrides.epicId}`,
    title: "Streaming session logs over SSE",
    status: "todo",
    type: "feature",
    priority: 2,
    group: "waiting",
    taskType: null,
    startedAt: null,
    yourTurnKind: null,
    queueLabel: "To Do",
    queueRank: 1,
    blockedBy: [],
    isDraft: false,
    isQueued: false,
    mergeReady: false,
    mergeBlockerLine: null,
    releaseVersion: null,
    usDone: 2,
    usCount: 5,
    activity: "updated · 1d ago",
    activityTone: "muted",
    costUsd: 0.84,
    projectName: "Arij",
    ...overrides,
  };
}

function makePayload(
  rows: RegistryRow[],
  overrides: Partial<TicketsRegistryPayload> = {},
): TicketsRegistryPayload {
  const groupLoaded = {
    active: 0,
    your_turn: 0,
    waiting: 0,
    done: 0,
    released: 0,
  };
  for (const item of rows) groupLoaded[item.group] += 1;
  return {
    generatedAt: "2026-08-30T12:00:00.000Z",
    projects,
    rows,
    counts: {
      all: rows.length,
      open: groupLoaded.active + groupLoaded.your_turn + groupLoaded.waiting,
      active: groupLoaded.active,
      yourTurn: groupLoaded.your_turn,
      done: groupLoaded.done,
      released: groupLoaded.released,
    },
    groupTotals: { ...groupLoaded },
    groupLoaded,
    totals: { tickets: rows.length, projects: 2, cost30dUsd: 38.2 },
    ...overrides,
  };
}

beforeEach(() => {
  openTicket.mockClear();
  setWindow.mockClear();
  loadError = null;
  payload = makePayload([row({ epicId: "1" })]);
});

describe("the column header", () => {
  it("renders the seven accented labels in source case", () => {
    render(<TicketsRegistryView />);
    for (const label of [
      "Ticket",
      "Titre",
      "État",
      "Stories",
      "Priorité",
      "Dernière activité",
      "Coût",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("group headers", () => {
  it("carry the TRUE total, not the loaded count", () => {
    payload = makePayload(
      [
        row({ epicId: "r1", group: "released", status: "released" }),
        row({ epicId: "r2", group: "released", status: "released" }),
      ],
      {
        groupTotals: { active: 0, your_turn: 0, waiting: 0, done: 0, released: 20 },
      },
    );
    render(<TicketsRegistryView />);
    expect(screen.getByTestId("tickets-group-header")).toHaveTextContent(
      "Released · 20",
    );
  });

  it("an empty group renders NO header", () => {
    payload = makePayload([row({ epicId: "1", group: "waiting" })]);
    render(<TicketsRegistryView />);
    const headers = screen.getAllByTestId("tickets-group-header");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveAttribute("data-group", "waiting");
  });

  it("collapses its rows when clicked", () => {
    render(<TicketsRegistryView />);
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("tickets-group-header"));
    expect(screen.queryAllByTestId("tickets-row")).toHaveLength(0);
    expect(screen.getByTestId("tickets-group-header")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("renders nothing at all when every group is empty", () => {
    payload = makePayload([]);
    render(<TicketsRegistryView />);
    expect(screen.getByTestId("tickets-empty")).toBeEmptyDOMElement();
    expect(screen.queryAllByTestId("tickets-group-header")).toHaveLength(0);
    expect(screen.getByTestId("tickets-footer-status")).toHaveTextContent(
      "0 tickets · 2 projets",
    );
  });
});

describe("truncation", () => {
  it("caps DONE at three and offers tout montrer ↓", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      row({ epicId: `d${index}`, group: "done", status: "done" }),
    );
    payload = makePayload(rows);
    render(<TicketsRegistryView />);

    expect(screen.getAllByTestId("tickets-row")).toHaveLength(3);
    expect(screen.getByText("+ 6 autres done")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tickets-show-all"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(9);
    expect(setWindow).toHaveBeenCalledWith("done", 9);
  });

  it("only claims 'en backlog' when every hidden row really is one", () => {
    const backlog = Array.from({ length: 6 }, (_, index) =>
      row({ epicId: `b${index}`, group: "waiting", status: "backlog", isDraft: true }),
    );
    payload = makePayload(backlog);
    const { unmount } = render(<TicketsRegistryView />);
    expect(screen.getByText("+ 2 autres en backlog")).toBeInTheDocument();
    unmount();

    payload = makePayload([
      ...backlog.slice(0, 5),
      row({ epicId: "mix", group: "waiting", status: "todo" }),
    ]);
    render(<TicketsRegistryView />);
    expect(screen.getByText("+ 2 autres")).toBeInTheDocument();
  });
});

describe("rows", () => {
  it("opens the 6a overlay with the epic and its project", () => {
    render(<TicketsRegistryView />);
    fireEvent.click(screen.getByTestId("tickets-row"));
    expect(openTicket).toHaveBeenCalledWith("1", { projectId: "p1" });
  });

  it("dims a blocked waiting row and names what it waits on", () => {
    payload = makePayload([
      row({ epicId: "1", blockedBy: ["ARJ-128"], queueRank: null }),
    ]);
    render(<TicketsRegistryView />);
    const element = screen.getByTestId("tickets-row");
    expect(element.className).toContain("opacity-60");
    expect(element).toHaveTextContent("waits on ARJ-128");
  });

  it("renders em-dashes, never zeros, for absent stories and cost", () => {
    payload = makePayload([
      row({ epicId: "1", usCount: 0, usDone: 0, costUsd: null, priority: null }),
    ]);
    render(<TicketsRegistryView />);
    const element = screen.getByTestId("tickets-row");
    expect(within(element).getAllByText("—")).toHaveLength(3);
    expect(element).not.toHaveTextContent("0/0");
    expect(element).not.toHaveTextContent("$0.00");
  });

  it("stamps a released row with its version and nothing when there is none", () => {
    payload = makePayload([
      row({
        epicId: "1",
        group: "released",
        status: "released",
        releaseVersion: "v0.4.2",
      }),
      row({ epicId: "2", group: "released", status: "released" }),
    ]);
    render(<TicketsRegistryView />);
    expect(screen.getByText("v0.4.2")).toBeInTheDocument();
    expect(screen.getByText("released")).toBeInTheDocument();
  });
});

describe("the filter row", () => {
  it("single-selects the state pills, with exactly one filled control", () => {
    render(<TicketsRegistryView />);
    const filled = () =>
      screen
        .getAllByTestId(/^tickets-filter-/)
        .filter((node) => node.getAttribute("data-variant") === "filled");

    expect(filled()).toHaveLength(1);
    expect(filled()[0]).toHaveAttribute("data-testid", "tickets-filter-all");

    fireEvent.click(screen.getByTestId("tickets-filter-done"));
    expect(filled()).toHaveLength(1);
    expect(filled()[0]).toHaveAttribute("data-testid", "tickets-filter-done");
  });

  it("toggles Bug and High+ independently and never fills them", () => {
    payload = makePayload([
      row({ epicId: "1", type: "feature", priority: 1 }),
      row({ epicId: "2", type: "bug", priority: 3 }),
    ]);
    render(<TicketsRegistryView />);
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("tickets-filter-bug"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(1);
    expect(screen.getByTestId("tickets-filter-bug")).toHaveAttribute(
      "data-variant",
      "outline",
    );

    fireEvent.click(screen.getByTestId("tickets-filter-high"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(1);
    expect(screen.getByTestId("tickets-filter-high")).toHaveAttribute(
      "data-variant",
      "outline",
    );

    // Independent: turning Bug back off leaves High+ on.
    fireEvent.click(screen.getByTestId("tickets-filter-bug"));
    expect(screen.getByTestId("tickets-filter-bug")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByTestId("tickets-filter-high")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("reads · — before the first response, never · 0", () => {
    payload = null;
    render(<TicketsRegistryView />);
    expect(screen.getByTestId("tickets-filter-all")).toHaveTextContent("All · —");
    expect(screen.getByTestId("tickets-filter-released")).toHaveTextContent(
      "Released · —",
    );
    expect(screen.getByTestId("tickets-filter-all")).not.toHaveTextContent("All · 0");
  });

  it("⌘F focuses the filter field and preventDefaults", () => {
    render(<TicketsRegistryView />);
    const field = screen.getByTestId("tickets-filter-field");
    expect(field).not.toHaveFocus();

    // fireEvent returns false when the handler called preventDefault.
    const notPrevented = fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(notPrevented).toBe(false);
    expect(field).toHaveFocus();
  });

  it("Escape in the field clears the query", () => {
    render(<TicketsRegistryView />);
    const field = screen.getByTestId("tickets-filter-field") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sse" } });
    expect(field.value).toBe("sse");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
  });
});

describe("the footer", () => {
  it("prints the totals and the 30-day cost", () => {
    render(<TicketsRegistryView />);
    expect(screen.getByTestId("tickets-footer-status")).toHaveTextContent(
      "1 ticket · 2 projets",
    );
    expect(screen.getByText("$38.20")).toBeInTheDocument();
  });

  it("shows an em-dash when nothing billed in 30 days", () => {
    payload = makePayload([row({ epicId: "1" })], {
      totals: { tickets: 1, projects: 2, cost30dUsd: null },
    });
    render(<TicketsRegistryView />);
    const footer = screen.getByTestId("tickets-footer-status").parentElement!;
    expect(footer).toHaveTextContent("coût total 30j : —");
  });

  it("puts a route error in the status slot and keeps the last good rows", () => {
    loadError = "Failed to load the registry (500)";
    render(<TicketsRegistryView />);
    expect(screen.getByTestId("tickets-footer-status")).toHaveTextContent(
      "Failed to load the registry (500)",
    );
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(1);
  });
});
