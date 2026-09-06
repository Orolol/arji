/**
 * The tickets registry's refinement entry point (epic OhhuWSRBq1sX: "Il manque
 * le bouton refinement dans la partie tickets").
 *
 * The /tickets screen (frame 12a) shows every project's tickets at once, but a
 * refinement pass is per-project — `/api/projects/:id/refinement` — so the
 * button must name a target: a scoped registry (`?project=`) targets the
 * route param with no picker, and an unscoped registry offers the projects it
 * already lists and mounts the board's own RefinementButton for the chosen
 * one. Dispatch errors surface in the filter row (this screen has no toast
 * rail), and a finished pass pulls the reshuffled board in immediately.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RegistryRow, TicketsRegistryPayload } from "@/lib/tickets-registry/types";
import { mockFetchSequence } from "@/__tests__/helpers/mock-fetch";
import { installAppRouterUrl } from "@/__tests__/helpers/app-router-url";

const openTicket = vi.fn();

// The screen's scope is a URL parameter now (epic 5sCe4w0bxRYl), so a mounted
// registry needs an address bar to read: `useSearchParams()` is the App
// Router's, and returns null outside its provider.
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

// The registry's filter row builds its pills out of the raw radix primitives,
// so the module mock renders the menu contents inline — the trigger button is
// the real thing, and the items keep their props (data-testid included).
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.()}
      {...rest}
    >
      {children}
    </button>
  ),
}));

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
let payload: TicketsRegistryPayload | null = null;

vi.mock("@/components/tickets-registry/useTicketsRegistry", () => ({
  useTicketsRegistry: () => ({
    data: payload,
    loading: payload === null,
    error: null,
    window: { done: 40, released: 40 },
    refresh: refreshSpy,
    setWindow: vi.fn(),
  }),
}));

// TLA, not a static import: the mock factory reads `payload`, which must be
// initialised before the mocked module is first evaluated. A static import
// would run the factory during the import phase — before this module's body —
// and read the binding in its temporal dead zone. (Same shape the
// tickets-registry table test uses.)
const { TicketsRegistryView } = await import(
  "@/components/tickets-registry/TicketsRegistryView"
);
const { deriveProjects } = await import("@/lib/control-desk/aggregate");

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

function makePayload(rows: RegistryRow[]): TicketsRegistryPayload {
  const groupLoaded = { active: 0, your_turn: 0, waiting: 0, done: 0, released: 0 };
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
    totals: { tickets: rows.length, projects: projects.length, cost30dUsd: 38.2 },
  };
}

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

const originalFetch = global.fetch;

const idle = () => ({
  ok: true,
  body: { data: { running: false, sessionId: null, ticketCount: 5 } },
});
const started = () => ({
  ok: true,
  body: { data: { started: true, sessionId: "session-1", provider: "claude", ticketCount: 5 } },
});
const running = () => ({
  ok: true,
  body: { data: { running: true, sessionId: "session-1", ticketCount: 5 } },
});

function pickTrigger(label: string): HTMLButtonElement {
  const actions = screen.getByTestId("refine-actions");
  return within(actions).getByText(label).closest("button") as HTMLButtonElement;
}

beforeEach(() => {
  vi.restoreAllMocks();
  refreshSpy.mockClear();
  openTicket.mockClear();
  payload = makePayload([row({ epicId: "1" })]);
  // Filters live in the URL, so an unreset address bar leaks a scope from one
  // case into the next.
  installAppRouterUrl("/tickets");
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("scoped registry", () => {
  it("mounts the button for the route's project, with no project picker", async () => {
    const fetchMock = mockFetchSequence([idle()]);
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);

    const button = await screen.findByTestId("refinement-button");
    expect(button).not.toBeDisabled();
    // The route param is the target — there is nothing to choose.
    expect(screen.queryByTestId("refine-project-p1")).toBeNull();
    expect(screen.queryByTestId("refine-project-p2")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/refinement");
  });

  it("surfaces a dispatch error in the filter row, in the destructive tone", async () => {
    mockFetchSequence([
      idle(),
      {
        ok: false,
        body: {
          error: "A board refinement pass is already running for this project.",
          code: "REFINEMENT_ALREADY_RUNNING",
        },
      },
    ]);
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);

    fireEvent.click(await screen.findByTestId("refinement-button"));
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    const notice = await screen.findByTestId("refinement-notice");
    expect(notice).toHaveTextContent("already running");
    expect(within(notice).getByText(/already running/)).toHaveClass("text-destructive");
  });
});

describe("unscoped registry", () => {
  it("keeps the picker disabled and the button absent before the first response", () => {
    payload = null;
    mockFetchSequence([idle()]);
    render(<TicketsRegistryView />);

    expect(pickTrigger("refine: —")).toBeDisabled();
    expect(screen.queryByTestId("refine-project-p1")).toBeNull();
    expect(screen.queryByTestId("refinement-button")).toBeNull();
  });

  it("lists every project the registry shows, one option each", () => {
    mockFetchSequence([idle()]);
    render(<TicketsRegistryView />);

    expect(pickTrigger("refine: —")).not.toBeDisabled();
    expect(screen.getByTestId("refine-project-p1")).toHaveTextContent("Arij");
    expect(screen.getByTestId("refine-project-p2")).toHaveTextContent("Ledger");
    expect(screen.queryByTestId("refinement-button")).toBeNull();
  });

  it("mounts the button for the chosen project, and dispatch lands on its route", async () => {
    // Queue: mount status, the dispatch answer, then the status re-read the
    // button performs once it knows a pass is in flight.
    const fetchMock = mockFetchSequence([idle(), started(), running()]);
    render(<TicketsRegistryView />);
    fireEvent.click(screen.getByTestId("refine-project-p2"));
    const button = await screen.findByTestId("refinement-button");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/p2/refinement"),
    );
    expect(pickTrigger("refine: LEDGER")).not.toBeDisabled();

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/p2/refinement",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.getByTestId("refinement-button-spinner")).toBeTruthy();
    expect(await screen.findByTestId("refinement-notice")).toHaveTextContent(
      "Agent Refinement started",
    );
  });

  it("reports an empty board as a notice, not a failure", async () => {
    mockFetchSequence([
      idle(),
      {
        ok: true,
        body: {
          data: {
            started: false,
            reason: "Both planning columns are empty — there is nothing to refine.",
          },
        },
      },
    ]);
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);

    fireEvent.click(await screen.findByTestId("refinement-button"));
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    const notice = await screen.findByTestId("refinement-notice");
    expect(notice).toHaveTextContent("nothing to refine");
    expect(within(notice).getByText(/nothing to refine/)).not.toHaveClass("text-destructive");
  });

  it("pulls the registry back in as soon as a finished pass reshapes the board", async () => {
    // Mount status, the dispatch answer, then the reload that sees the pass
    // idle again — the running→idle edge is what fires onFinished, and it
    // also re-runs the status effect, hence the fourth response.
    mockFetchSequence([idle(), started(), idle(), idle()]);
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);

    fireEvent.click(await screen.findByTestId("refinement-button"));
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("refinement-notice")).toHaveTextContent(
      "Board refinement finished",
    );
  });

  it("switching targets mid-pass does not announce a finish for the previous one", async () => {
    // p1's pass starts and is still in flight when the user switches to p2:
    // the fresh button for p2 must not announce p1's pass as finished.
    mockFetchSequence([idle(), started(), running(), idle()]);
    render(<TicketsRegistryView />);

    fireEvent.click(screen.getByTestId("refine-project-p1"));
    const first = await screen.findByTestId("refinement-button");
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Start refinement" }));
    await waitFor(() =>
      expect(screen.getByTestId("refinement-button-badge")).toHaveTextContent("running"),
    );

    fireEvent.click(screen.getByTestId("refine-project-p2"));
    await screen.findByTestId("refinement-button");

    // The "started" line for p1 is still on screen (it clears on its own
    // timer), but nothing may claim a pass finished.
    const notice = screen.queryByTestId("refinement-notice");
    expect(notice?.textContent).not.toContain("finished");
  });
});
