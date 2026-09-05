/**
 * `/tickets` — the registry's filters live in the URL (epic 5sCe4w0bxRYl).
 *
 * THE BUG. The screen took its scope from `/tickets?project=X`, then kept
 * every later selection in component state: picking project Y showed Y's rows
 * while the address bar still said `?project=X`, so a reload — or a Back —
 * silently restored X. The same held for the state pills, the exact-status
 * select and the sort column and its direction: a filtered registry could not
 * be reloaded, bookmarked or handed to anyone.
 *
 * THE CONTRACT these tests pin:
 *
 * - `project`, `status`, `state`, `sort` and `direction` are read from the
 *   URL and written back to it. Default values are left out, so a plain
 *   `/tickets` stays plain.
 * - Writes go through the History API, which the App Router patches to keep
 *   `useSearchParams()` in sync (see `__tests__/helpers/app-router-url.ts`) —
 *   not `router.replace()`, which is a navigation and leaves the address bar
 *   stale for a whole RSC round-trip.
 * - They are `pushState`, so Back and Forward walk the filter history.
 * - A scope supplied by NAVIGATION still wins over the current selection: the
 *   URL is the only source of truth, so arriving at `/tickets?project=X`
 *   shows X whatever was selected a moment earlier.
 * - The query field, the Bug/High+ toggles and the group windows stay local
 *   on purpose: per-keystroke history entries would make Back unusable, and
 *   the ticket scopes the URL contract to projet/état/tri/direction.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  currentUrl,
  installAppRouterUrl,
  navigateTo,
} from "@/__tests__/helpers/app-router-url";

vi.mock("next/navigation", async () => {
  const { useMockSearchParams } = await import("@/__tests__/helpers/app-router-url");
  return { useSearchParams: () => useMockSearchParams() };
});

vi.mock("@/components/ticket/TicketOverlayProvider", () => ({
  useTicketOverlay: () => ({
    ticketId: null,
    projectId: null,
    open: false,
    openTicket: vi.fn(),
    closeTicket: vi.fn(),
  }),
  TicketOverlayProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/** Every argument tuple the data hook was called with, newest last. */
const { registryCalls } = vi.hoisted(() => ({
  registryCalls: [] as Array<{
    projectId: string | null | undefined;
    query: string | undefined;
    sort: string;
    direction: string;
    status: string;
  }>,
}));

let payload: TicketsRegistryPayload | null = null;

vi.mock("@/components/tickets-registry/useTicketsRegistry", () => ({
  useTicketsRegistry: (
    projectId?: string | null,
    query?: string,
    sort = "activite",
    direction = "desc",
    status = "all",
  ) => {
    registryCalls.push({ projectId, query, sort, direction, status });
    return {
      data: payload,
      loading: payload === null,
      error: null,
      window: { done: 40, released: 40 },
      refresh: vi.fn(),
      setWindow: vi.fn(),
    };
  },
}));

// TLA, not a static import: the mock factory closes over `payload`, which must
// be declared before the component module pulls the mock in.
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
    generatedAt: "2026-09-05T12:00:00.000Z",
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
  };
}

/** One ticket per project, so the visible rows name the scope. */
const TWO_PROJECT_ROWS = () => [
  row({ epicId: "a" }),
  row({ epicId: "b", projectId: "p2", projectName: "Ledger" }),
];

async function select(trigger: RegExp, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: trigger }));
  await user.click(screen.getByRole("menuitem", { name: option }));
}

function ticketIds(): string[] {
  return screen
    .queryAllByTestId("tickets-row")
    .map((element) => element.textContent ?? "")
    .map((text) => text.match(/ARJ-[a-z0-9-]+/)?.[0] ?? "");
}

/** Back / Forward. jsdom owns the session history; popstate is asynchronous. */
async function traverse(direction: "back" | "forward") {
  await act(async () => {
    if (direction === "back") window.history.back();
    else window.history.forward();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** A reload: the same URL, a brand-new mount, nothing carried over. */
function reload() {
  cleanup();
  render(<TicketsRegistryView />);
}

beforeEach(() => {
  registryCalls.length = 0;
  payload = makePayload(TWO_PROJECT_ROWS());
  installAppRouterUrl("/tickets");
});

afterEach(() => {
  cleanup();
});

describe("the project scope round-trips through the URL", () => {
  it("writes the chosen project to the address bar and survives a reload", async () => {
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);
    expect(ticketIds()).toEqual(["ARJ-a"]);

    await select(/^Projet :/, "Ledger");

    expect(currentUrl()).toBe("/tickets?project=p2");
    expect(ticketIds()).toEqual(["ARJ-b"]);

    reload();

    expect(screen.getByRole("button", { name: /^Projet :/ })).toHaveTextContent("Ledger");
    expect(ticketIds()).toEqual(["ARJ-b"]);
    expect(registryCalls.at(-1)?.projectId).toBe("p2");
  });

  it("restores the previous scope on Back and re-applies it on Forward", async () => {
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);
    await select(/^Projet :/, "Ledger");
    expect(ticketIds()).toEqual(["ARJ-b"]);

    await traverse("back");

    expect(currentUrl()).toBe("/tickets?project=p1");
    expect(ticketIds()).toEqual(["ARJ-a"]);

    await traverse("forward");

    expect(currentUrl()).toBe("/tickets?project=p2");
    expect(ticketIds()).toEqual(["ARJ-b"]);
  });

  it("lets a navigation-supplied scope win over the current selection", async () => {
    render(<TicketsRegistryView />);
    await select(/^Projet :/, "Ledger");
    expect(currentUrl()).toBe("/tickets?project=p2");

    // A top-bar project chip, i.e. a real navigation to the registry.
    act(() => navigateTo("/tickets?project=p1"));

    expect(ticketIds()).toEqual(["ARJ-a"]);
    expect(screen.getByRole("button", { name: /^Projet :/ })).toHaveTextContent("Arij");
  });

  it("drops the parameter when the scope is cleared rather than writing a blank one", async () => {
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);

    await select(/^Projet :/, "Tous les projets");

    expect(currentUrl()).toBe("/tickets");
    expect(ticketIds()).toEqual(["ARJ-a", "ARJ-b"]);
  });

  it("keeps parameters it does not own", async () => {
    installAppRouterUrl("/tickets?ticket=epic-1&project=p1");
    render(<TicketsRegistryView />);

    await select(/^Projet :/, "Ledger");

    expect(currentUrl()).toBe("/tickets?ticket=epic-1&project=p2");
  });

  it("does not record a history entry for a selection that changes nothing", async () => {
    installAppRouterUrl("/tickets?project=p1");
    render(<TicketsRegistryView />);
    const before = window.history.length;

    await select(/^Projet :/, "Arij");

    expect(currentUrl()).toBe("/tickets?project=p1");
    expect(window.history.length).toBe(before);
  });
});

describe("state, exact status, sort and direction round-trip too", () => {
  it("writes the state pill and clears the exact status it replaces", async () => {
    installAppRouterUrl("/tickets?status=todo");
    payload = makePayload([row({ epicId: "done", status: "done", group: "done" })]);
    render(<TicketsRegistryView />);

    await userEvent.setup().click(screen.getByTestId("tickets-filter-done"));

    expect(currentUrl()).toBe("/tickets?state=done");
  });

  it("writes the exact status and clears the state pill it replaces", async () => {
    installAppRouterUrl("/tickets?state=done");
    render(<TicketsRegistryView />);

    await select(/^État :/, "Review");

    expect(currentUrl()).toBe("/tickets?status=review");
  });

  it("writes the sort column, and the direction only when it is not the column's default", async () => {
    render(<TicketsRegistryView />);
    const user = userEvent.setup();
    const header = () => screen.getByRole("columnheader", { name: "Titre" });

    await user.click(within(header()).getByRole("button", { name: "Titre" }));
    expect(currentUrl()).toBe("/tickets?sort=titre");

    await user.click(within(header()).getByRole("button", { name: "Titre" }));
    expect(currentUrl()).toBe("/tickets?sort=titre&direction=desc");

    await traverse("back");
    expect(currentUrl()).toBe("/tickets?sort=titre");
    expect(header()).toHaveAttribute("aria-sort", "ascending");
  });

  it("starts from the parameters the URL carries", () => {
    installAppRouterUrl("/tickets?project=p2&state=done&sort=cout&direction=asc");
    payload = makePayload([
      row({ epicId: "a" }),
      row({ epicId: "b", projectId: "p2", projectName: "Ledger", status: "done", group: "done" }),
    ]);
    render(<TicketsRegistryView />);

    expect(screen.getByRole("button", { name: /^Projet :/ })).toHaveTextContent("Ledger");
    expect(screen.getByTestId("tickets-filter-done")).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: /^sort:/ })).toHaveTextContent("coût ↑");
    expect(registryCalls.at(-1)).toMatchObject({
      projectId: "p2",
      sort: "cout",
      direction: "asc",
      status: "all",
    });
    expect(ticketIds()).toEqual(["ARJ-b"]);
  });

  it("falls back to the defaults on unreadable parameters without rewriting the URL", () => {
    installAppRouterUrl("/tickets?project=&state=nope&status=nope&sort=nope&direction=nope");
    render(<TicketsRegistryView />);

    expect(screen.getByTestId("tickets-filter-all")).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: /^État :/ })).toHaveTextContent("Tous les états");
    expect(screen.getByRole("button", { name: /^sort:/ })).toHaveTextContent("activité ↓");
    expect(ticketIds()).toEqual(["ARJ-a", "ARJ-b"]);
    expect(currentUrl()).toBe(
      "/tickets?project=&state=nope&status=nope&sort=nope&direction=nope",
    );
  });
});
