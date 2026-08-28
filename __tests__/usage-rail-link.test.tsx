/**
 * The usage observatory's entry point in the rail's bottom utility cluster.
 *
 * The rail now hides itself on routes that ship their own Piscine header
 * ("/", "/agents", "/usage"), so this renders at a legacy route — which is
 * where the rail is still the only navigation.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/settings",
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [],
    allProjects: [],
    loading: false,
    error: null,
    filter: "all",
    setFilter: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useInbox", () => ({
  useInbox: () => ({
    items: [],
    unreadCount: 0,
    loading: false,
    markRead: vi.fn(),
    reply: vi.fn(),
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

import { Sidebar } from "@/components/layout/Sidebar";

describe("Rail — usage link", () => {
  it("links to the usage page", () => {
    render(<Sidebar />);

    const link = screen.getByTestId("rail-usage-link");
    expect(link).toHaveAttribute("href", "/usage");
    expect(link).toHaveAttribute("title", "Usage");
  });

  it("sits in the bottom cluster, right after the dashboard link", () => {
    render(<Sidebar />);

    const link = screen.getByTestId("rail-usage-link");
    const dashboard = screen.getByTitle("All projects");
    expect(dashboard.nextElementSibling).toBe(link);
  });
});
