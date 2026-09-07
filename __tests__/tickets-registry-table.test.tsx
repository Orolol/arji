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
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const openTicket = vi.fn();

// The filters live in the URL now (epic 5sCe4w0bxRYl): `useSearchParams()` is
// the App Router's hook and returns null outside its provider, so a mounted
// registry needs the stand-in address bar.
vi.mock("next/navigation", async () => {
  const { useMockSearchParams } = await import("@/__tests__/helpers/app-router-url");
  return { useSearchParams: () => useMockSearchParams() };
});

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
import { installAppRouterUrl, navigateTo } from "@/__tests__/helpers/app-router-url";

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
    activityAt: null,
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
  // A filter is a query parameter, so the address bar has to be reset between
  // cases or one case's scope survives into the next.
  installAppRouterUrl("/tickets");
});

describe("the column header", () => {
  it("renders the seven labels in source case", () => {
    render(<TicketsRegistryView />);
    for (const label of [
      "Ticket",
      "Title",
      "State",
      "Stories",
      "Priority",
      "Last activity",
      "Cost",
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
      "0 tickets · 2 projects",
    );
  });
});

describe("truncation", () => {
  it("caps DONE at three and offers show all ↓", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      row({ epicId: `d${index}`, group: "done", status: "done" }),
    );
    payload = makePayload(rows);
    render(<TicketsRegistryView />);

    expect(screen.getAllByTestId("tickets-row")).toHaveLength(3);
    expect(screen.getByText("+ 6 more done")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tickets-show-all"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(9);
    expect(setWindow).toHaveBeenCalledWith("done", 9);
  });

  it("only claims 'in backlog' when every hidden row really is one", () => {
    const backlog = Array.from({ length: 6 }, (_, index) =>
      row({ epicId: `b${index}`, group: "waiting", status: "backlog", isDraft: true }),
    );
    payload = makePayload(backlog);
    const { unmount } = render(<TicketsRegistryView />);
    expect(screen.getByText("+ 2 more in backlog")).toBeInTheDocument();
    unmount();

    payload = makePayload([
      ...backlog.slice(0, 5),
      row({ epicId: "mix", group: "waiting", status: "todo" }),
    ]);
    render(<TicketsRegistryView />);
    expect(screen.getByText("+ 2 more")).toBeInTheDocument();
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
      "1 ticket · 2 projects",
    );
    expect(screen.getByText("$38.20")).toBeInTheDocument();
  });

  it("shows an em-dash when nothing billed in 30 days", () => {
    payload = makePayload([row({ epicId: "1" })], {
      totals: { tickets: 1, projects: 2, cost30dUsd: null },
    });
    render(<TicketsRegistryView />);
    const footer = screen.getByTestId("tickets-footer-status").parentElement!;
    expect(footer).toHaveTextContent("30d total cost: —");
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

describe("project and exact workflow filters", () => {
  async function select(trigger: RegExp, option: string) {
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.click(screen.getByRole("button", { name: trigger }));
    await user.click(screen.getByRole("menuitem", { name: option }));
  }

  it("combines project, status, text, bug and priority filters and clears them", async () => {
    payload = makePayload([
      row({ epicId: "wanted", projectId: "p2", title: "Needle", status: "review", type: "bug" }),
      row({ epicId: "other-project", title: "Needle", status: "review", type: "bug" }),
      row({ epicId: "other-status", projectId: "p2", title: "Needle", type: "bug" }),
      row({ epicId: "feature", projectId: "p2", title: "Needle", status: "review" }),
      row({ epicId: "low", projectId: "p2", title: "Needle", status: "review", type: "bug", priority: 0 }),
      row({ epicId: "text", projectId: "p2", title: "Different", status: "review", type: "bug" }),
    ]);
    render(<TicketsRegistryView />);
    await select(/^Project:/, "Ledger");
    await select(/^State:/, "Review");
    fireEvent.change(screen.getByLabelText("Filter tickets"), { target: { value: "Needle" } });
    fireEvent.click(screen.getByTestId("tickets-filter-bug"));
    fireEvent.click(screen.getByTestId("tickets-filter-high"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(1);
    expect(screen.getByTestId("tickets-row")).toHaveTextContent("ARJ-wanted");
    await select(/^Project:/, "All projects");
    await select(/^State:/, "All states");
    fireEvent.change(screen.getByLabelText("Filter tickets"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("tickets-filter-bug"));
    fireEvent.click(screen.getByTestId("tickets-filter-high"));
    fireEvent.click(screen.getByTestId("tickets-show-all"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(6);
  });

  it.each([
    ["backlog", "Backlog"], ["todo", "To Do"], ["in_progress", "In Progress"],
    ["review", "Review"], ["to_merge", "To Merge"], ["done", "Done"], ["released", "Released"],
  ])("selects exact state %s, including states sharing a group", async (status, label) => {
    payload = makePayload(["backlog", "todo", "in_progress", "review", "to_merge", "done", "released"].map((value) =>
      row({ epicId: value, status: value, group: value === "released" ? "released" : ["to_merge", "done"].includes(value) ? "done" : "waiting" }),
    ));
    render(<TicketsRegistryView />);
    fireEvent.click(screen.getByTestId("tickets-filter-active"));
    await select(/^State:/, label);
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(1);
    expect(screen.getByTestId("tickets-row")).toHaveTextContent(`ARJ-${status}`);
    fireEvent.click(screen.getByTestId("tickets-filter-all"));
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(7);
  });

  it("honors route scope changes and allows returning to all projects", async () => {
    // The scope arrives as `?project=`, and a navigation still outranks
    // whatever was selected — see tickets-registry-url-state.test.tsx.
    payload = makePayload([row({ epicId: "a" }), row({ epicId: "b", projectId: "p2" })]);
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);
    expect(screen.getByTestId("tickets-row")).toHaveTextContent("ARJ-a");
    await select(/^Project:/, "All projects");
    expect(screen.getAllByTestId("tickets-row")).toHaveLength(2);
    act(() => navigateTo("/tickets?project=p2"));
    expect(screen.getByTestId("tickets-row")).toHaveTextContent("ARJ-b");
    act(() => navigateTo("/tickets?project=p1"));
    expect(screen.getByTestId("tickets-row")).toHaveTextContent("ARJ-a");
  });

  it("renders an empty result when project and status do not intersect", async () => {
    render(<TicketsRegistryView />);
    await select(/^Project:/, "Ledger");
    await select(/^State:/, "Released");
    expect(screen.queryAllByTestId("tickets-row")).toHaveLength(0);
    expect(screen.getByTestId("tickets-footer-status")).toHaveTextContent("0 tickets");
  });
});

describe("sortable headers", () => {
  it.each([
    ["Ticket", "asc", "a"], ["Title", "asc", "a"], ["State", "asc", "a"],
    ["Stories", "desc", "b"], ["Priority", "desc", "b"],
    ["Last activity", "asc", "a"], ["Cost", "desc", "b"],
  ])("sorts %s in both directions and exposes the direction", (label, direction, first) => {
    payload = makePayload([
      row({ epicId: "b", title: "Zulu", status: "review", usCount: 10, priority: 3, costUsd: 10, activityAt: "2026-09-05T10:00:00Z" }),
      row({ epicId: "a", title: "Alpha", status: "backlog", usCount: 2, priority: 1, costUsd: 2, activityAt: "2026-09-01T10:00:00Z" }),
    ]);
    render(<TicketsRegistryView />);
    const header = screen.getByRole("columnheader", { name: label });
    fireEvent.click(within(header).getByRole("button", { name: label }));
    expect(header).toHaveAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
    expect(screen.getAllByTestId("tickets-row")[0]).toHaveTextContent(`ARJ-${first}`);
    fireEvent.click(within(header).getByRole("button", { name: label }));
    expect(header).toHaveAttribute("aria-sort", direction === "asc" ? "descending" : "ascending");
    expect(screen.getAllByTestId("tickets-row")[0]).toHaveTextContent(`ARJ-${first === "a" ? "b" : "a"}`);
    expect(screen.getByRole("button", { name: /^sort:/ })).toHaveTextContent(direction === "asc" ? "↓" : "↑");
  });

  it("sorts from the keyboard while preserving filters", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    payload = makePayload([row({ epicId: "b", title: "Zulu" }), row({ epicId: "a", title: "Alpha" }), row({ epicId: "bug", type: "bug" })]);
    render(<TicketsRegistryView />);
    await user.click(screen.getByTestId("tickets-filter-high"));
    const button = within(screen.getByRole("columnheader", { name: "Title" })).getByRole("button");
    button.focus();
    await user.keyboard("{Enter}");
    expect(screen.getAllByTestId("tickets-row")[0]).toHaveTextContent("ARJ-a");
    expect(screen.getByTestId("tickets-filter-high")).toHaveAttribute("aria-pressed", "true");
  });
});
