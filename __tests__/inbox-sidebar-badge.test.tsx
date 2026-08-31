/**
 * The inbox badge and the project chips — REWRITTEN FOR THE GLOBAL TOP BAR.
 *
 * This file used to cover `components/layout/InboxNavLink` and the left rail's
 * project tiles. Frame 13a retired both (`Sidebar.tsx` and `InboxNavLink.tsx`
 * are gone); the bar's right cluster carries the inbox pill and its coral count
 * badge, and the bar's left zone carries one chip per project. Every assertion
 * that was about behaviour rather than about the rail's geometry is preserved:
 *
 *   - the inbox entry point leads to /inbox
 *   - no badge when nothing is waiting
 *   - the waiting count is shown on the badge
 *   - one chip per non-archived project, linking to that project
 *   - the chip of the current route is marked active
 *   - a breathing dot only on projects with agents running
 *   - create / inbox / desk / settings all stay reachable
 *
 * DROPPED, with reason:
 *   - the "99+" cap. The bar's badge is `PillButton`'s (the system primitive,
 *     mono 9.5px bold on `--destructive`), which prints the exact count; the
 *     cap was the old bespoke badge's. It grows the pill rather than lying.
 *   - `projectInitials`. The rail squeezed a project into two letters; the bar
 *     prints the full name on its chip, so the function has no caller left and
 *     went with the rail. `agentInitials` is now the only initials rule.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const mockInboxState = vi.hoisted(() => ({ unreadCount: 0 }));

const barState = vi.hoisted(() => ({
  pathname: "/projects/p1",
  projects: [] as Array<Record<string, unknown>>,
  push: vi.fn(),
}));

vi.mock("@/hooks/useInbox", () => ({
  useInbox: () => ({
    items: [],
    unreadCount: mockInboxState.unreadCount,
    loading: false,
    markRead: vi.fn(),
    reply: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => barState.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: barState.push }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: barState.projects,
    allProjects: barState.projects,
    loading: false,
    error: null,
    filter: "all",
    setFilter: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useAutoModeArmed", () => ({
  useAutoModeArmed: () => ({
    armed: new Map(),
    globalDefault: false,
    loaded: true,
    refresh: vi.fn(),
  }),
  isProjectArmed: () => false,
}));

vi.mock("@/hooks/useControlDesk", () => ({
  useControlDesk: () => ({ data: null, loading: false, error: null, refresh: vi.fn() }),
}));

import { TopBar } from "@/components/piscine/TopBar";

describe("Top bar — inbox pill", () => {
  beforeEach(() => {
    mockInboxState.unreadCount = 0;
    barState.push = vi.fn();
    barState.pathname = "/projects/p1";
    barState.projects = [];
  });

  it("leads to the inbox", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTestId("top-bar-inbox"));
    expect(barState.push).toHaveBeenCalledWith("/inbox");
  });

  it("shows no badge when nothing is waiting", () => {
    render(<TopBar />);
    const pill = screen.getByTestId("top-bar-inbox");
    expect(within(pill).queryByText("0")).not.toBeInTheDocument();
    expect(pill.textContent).not.toMatch(/\d/);
  });

  it("shows the waiting count as a badge", () => {
    mockInboxState.unreadCount = 3;
    render(<TopBar />);
    expect(within(screen.getByTestId("top-bar-inbox")).getByText("3")).toBeInTheDocument();
  });
});

describe("Top bar — project chips", () => {
  beforeEach(() => {
    mockInboxState.unreadCount = 0;
    barState.push = vi.fn();
    barState.pathname = "/projects/p1";
    barState.projects = [
      {
        id: "p1",
        name: "Arij",
        status: "building",
        activeAgents: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "p2",
        name: "Astra Suite",
        status: "building",
        activeAgents: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "p3",
        name: "Old thing",
        status: "archived",
        activeAgents: 0,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ];
  });

  it("renders one chip per non-archived project", () => {
    render(<TopBar />);

    expect(screen.getByTestId("top-bar-project-chips")).toBeInTheDocument();
    expect(screen.getByTestId("top-bar-project-p1")).toHaveAttribute(
      "href",
      "/projects/p1",
    );
    expect(screen.getByTestId("top-bar-project-p2")).toBeInTheDocument();
    expect(screen.queryByTestId("top-bar-project-p3")).not.toBeInTheDocument();
  });

  it("prints the project name, not an abbreviation", () => {
    render(<TopBar />);
    expect(screen.getByTestId("top-bar-project-p2")).toHaveTextContent("Astra Suite");
  });

  it("marks the project of the current route as active", () => {
    barState.pathname = "/projects/p2/sessions";
    render(<TopBar />);

    expect(screen.getByTestId("top-bar-project-p2")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("top-bar-project-p1")).not.toHaveAttribute("data-active");
  });

  it("breathes a dot only on projects with agents running", () => {
    render(<TopBar />);

    const withAgents = screen.getByTestId("top-bar-project-p2");
    const without = screen.getByTestId("top-bar-project-p1");
    expect(withAgents.querySelector('[data-slot="breathing-dot"]')).not.toBeNull();
    expect(without.querySelector('[data-slot="breathing-dot"]')).toBeNull();
  });

  it("does not light a chip on /projects/new — it is a route, not a project", () => {
    barState.pathname = "/projects/new";
    render(<TopBar />);

    expect(screen.getByTestId("top-bar-project-p1")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("top-bar-project-p2")).not.toHaveAttribute("data-active");
  });

  it("keeps the create, inbox, desk and settings destinations reachable", () => {
    render(<TopBar />);

    expect(screen.getByTestId("top-bar-add-project")).toHaveAttribute(
      "href",
      "/projects/new",
    );
    expect(screen.getByTestId("top-bar-home")).toHaveAttribute("href", "/");
    expect(screen.getByTestId("top-bar-inbox")).toBeInTheDocument();

    fireEvent.focus(screen.getByTestId("top-bar-bubble-settings"));
    expect(screen.getByTestId("top-bar-entry-workspace")).toHaveAttribute(
      "href",
      "/settings",
    );
  });
});
