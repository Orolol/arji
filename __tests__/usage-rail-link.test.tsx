/**
 * The usage observatory's entry point — REWRITTEN FOR THE GLOBAL TOP BAR.
 *
 * This file used to assert that the left rail's bottom cluster carried a link
 * to /usage. Frame 13a retired the rail (`components/layout/Sidebar.tsx` is
 * gone): navigation is now the bar's three category menus, and Usage is the
 * last entry of the turquoise **Agents** menu. The assertion that mattered is
 * unchanged — the usage screen has an entry point, and it points at /usage —
 * it is just made against the surface that now owns it.
 *
 * The old companion assertion ("sits right after the dashboard link") was
 * about the rail's vertical order; its equivalent here is the entry's position
 * inside its category, which the shared nav model owns, so it is asserted
 * against `NAV_CATEGORIES` rather than against pixels.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { NAV_CATEGORIES } from "@/lib/piscine/nav";

const routerState = vi.hoisted(() => ({ push: vi.fn(), pathname: "/projects/p1" }));

vi.mock("next/navigation", () => ({
  usePathname: () => routerState.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: routerState.push }),
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

vi.mock("@/hooks/useAutoModeArmed", () => ({
  useAutoModeArmed: () => ({
    armed: new Map(),
    globalDefault: false,
    loaded: true,
    refresh: vi.fn(),
  }),
  isProjectArmed: () => false,
}));

// The menu owns the desk read; nothing here is about the desk payload.
vi.mock("@/hooks/useControlDesk", () => ({
  useControlDesk: () => ({ data: null, loading: false, error: null, refresh: vi.fn() }),
}));

import { TopBar } from "@/components/piscine/TopBar";

describe("Top bar — usage entry point", () => {
  it("links to the usage page from the Agents menu", () => {
    render(<TopBar />);

    // Focus opens the menu immediately; hover opens it after the intent delay.
    fireEvent.focus(screen.getByTestId("top-bar-bubble-agents"));

    const link = screen.getByTestId("top-bar-entry-usage");
    expect(link).toHaveAttribute("href", "/usage");
    expect(link).toHaveTextContent("Usage");
  });

  it("is reachable with no project in the URL — it is a global screen", () => {
    routerState.pathname = "/";
    render(<TopBar />);

    fireEvent.focus(screen.getByTestId("top-bar-bubble-agents"));

    const link = screen.getByTestId("top-bar-entry-usage");
    expect(link).toHaveAttribute("href", "/usage");
    expect(link).not.toHaveAttribute("data-disabled");
    routerState.pathname = "/projects/p1";
  });

  it("sits last in the Agents category, after Named agents · Sessions · Chat", () => {
    const agents = NAV_CATEGORIES.find((category) => category.id === "agents");
    expect(agents?.entries.map((entry) => entry.id)).toEqual([
      "named-agents",
      "sessions",
      "chat",
      "usage",
    ]);
  });
});
