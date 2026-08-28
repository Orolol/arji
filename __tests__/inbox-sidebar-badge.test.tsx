import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InboxNavLink } from "@/components/layout/InboxNavLink";

const mockInboxState = vi.hoisted(() => ({
  unreadCount: 0,
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

const railState = vi.hoisted(() => ({
  pathname: "/projects/p1",
  projects: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => railState.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: railState.projects,
    allProjects: railState.projects,
    loading: false,
    error: null,
    filter: "all",
    setFilter: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// Frozen rail mounts — stubbed so this test stays about the rail itself.
vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));
vi.mock("@/components/layout/NotificationBell", () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));

import { Sidebar, projectInitials } from "@/components/layout/Sidebar";

describe("InboxNavLink (sidebar)", () => {
  beforeEach(() => {
    mockInboxState.unreadCount = 0;
  });

  it("links to the inbox page", () => {
    render(<InboxNavLink />);
    expect(screen.getByTestId("sidebar-inbox-link")).toHaveAttribute(
      "href",
      "/inbox"
    );
  });

  it("shows no badge when nothing is waiting", () => {
    render(<InboxNavLink />);
    expect(screen.queryByTestId("sidebar-inbox-badge")).not.toBeInTheDocument();
  });

  it("shows the waiting count as a badge", () => {
    mockInboxState.unreadCount = 3;
    render(<InboxNavLink />);
    expect(screen.getByTestId("sidebar-inbox-badge")).toHaveTextContent("3");
  });

  it("caps the badge at 99+", () => {
    mockInboxState.unreadCount = 120;
    render(<InboxNavLink />);
    expect(screen.getByTestId("sidebar-inbox-badge")).toHaveTextContent("99+");
  });
});

describe("project rail", () => {
  beforeEach(() => {
    mockInboxState.unreadCount = 0;
    railState.pathname = "/projects/p1";
    railState.projects = [
      { id: "p1", name: "Arij", status: "building", activeAgents: 0 },
      { id: "p2", name: "Astra Suite", status: "building", activeAgents: 2 },
      { id: "p3", name: "Old thing", status: "archived", activeAgents: 0 },
    ];
  });

  it("renders one tile per non-archived project", () => {
    render(<Sidebar />);

    expect(screen.getByTestId("project-rail")).toBeInTheDocument();
    expect(screen.getByTestId("rail-project-p1")).toHaveAttribute(
      "href",
      "/projects/p1"
    );
    expect(screen.getByTestId("rail-project-p2")).toBeInTheDocument();
    expect(screen.queryByTestId("rail-project-p3")).not.toBeInTheDocument();
  });

  it("marks the project of the current route as active", () => {
    railState.pathname = "/projects/p2/sessions";
    render(<Sidebar />);

    expect(screen.getByTestId("rail-project-p2")).toHaveAttribute(
      "data-active",
      "true"
    );
    expect(screen.getByTestId("rail-project-p1")).not.toHaveAttribute(
      "data-active"
    );
  });

  it("breathes a dot only on projects with agents running", () => {
    render(<Sidebar />);

    expect(
      screen.getByTestId("rail-project-agent-dot-p2").className
    ).toContain("breathing-dot");
    expect(
      screen.queryByTestId("rail-project-agent-dot-p1")
    ).not.toBeInTheDocument();
  });

  it("keeps the create, inbox, dashboard and settings destinations reachable", () => {
    render(<Sidebar />);

    expect(screen.getByTitle("New Project")).toHaveAttribute(
      "href",
      "/projects/new"
    );
    expect(screen.getByTitle("All projects")).toHaveAttribute("href", "/");
    expect(screen.getByTestId("sidebar-inbox-link")).toHaveAttribute(
      "href",
      "/inbox"
    );
    expect(screen.getByTitle("Settings")).toHaveAttribute("href", "/settings");
  });

  it("derives two-letter initials from the project name", () => {
    expect(projectInitials("Arij")).toBe("Ar");
    expect(projectInitials("Astra Suite")).toBe("AS");
    expect(projectInitials("lune")).toBe("Lu");
    expect(projectInitials("my-side-project")).toBe("MS");
  });
});
