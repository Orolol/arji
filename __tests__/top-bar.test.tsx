/**
 * Frame 13a — the global top bar and the nav model it renders.
 *
 * The bar is mounted once in `app/layout.tsx`, so it is the app's only
 * navigation: these tests pin the three things that would silently rot
 * otherwise — the routes each entry claims, what happens to an entry whose
 * screen does not exist yet, and the rule that no numeral is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import {
  LAST_PROJECT_STORAGE_KEY,
  NAV_CATEGORIES,
  activeNavCategory,
  firstReachableHref,
  isNavEntryActive,
  navHrefBlockedReason,
  readLastVisitedProjectId,
  readNoVisitedProjectId,
  rememberVisitedProjectId,
  resetLastVisitedProjectId,
  resolveNavHref,
  resolveScopeProjectId,
  subscribeLastVisitedProjectId,
} from "@/lib/piscine/nav";
import type { NavEntry } from "@/lib/piscine/nav";
import type { ControlDeskPayload } from "@/lib/control-desk/types";

const barState = vi.hoisted(() => ({
  pathname: "/",
  projects: [] as Array<Record<string, unknown>>,
  push: vi.fn(),
  desk: null as ControlDeskPayload | null,
  autoLoaded: true,
  armed: new Map<string, boolean>(),
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
    armed: barState.armed,
    globalDefault: false,
    loaded: barState.autoLoaded,
    refresh: vi.fn(),
  }),
  isProjectArmed: (_state: unknown, projectId: string) =>
    barState.armed.get(projectId) ?? false,
}));

vi.mock("@/hooks/useControlDesk", () => ({
  useControlDesk: () => ({
    data: barState.desk,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { TopBar, categoryIsLive, projectIdFromPath } from "@/components/piscine/TopBar";
import { deriveStatuses } from "@/components/piscine/TopBarMenu";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * The island's pills, in DOM order.
 *
 * They sit in a scroll rail one level inside `top-bar-island` (B-arij-164:
 * `overflow-x` on the island itself would clip the menu that opens below it),
 * and the open menu is a sibling of that rail — so read them by test id rather
 * than positionally off `children`.
 */
function islandPills(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("top-bar-island").querySelectorAll<HTMLElement>(
      '[data-testid^="top-bar-bubble-"]',
    ),
  );
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Arij",
    status: "building",
    activeAgents: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function deskPayload(overrides: Partial<ControlDeskPayload> = {}): ControlDeskPayload {
  return {
    generatedAt: "2026-08-30T08:00:00.000Z",
    projects: [],
    working: [],
    queued: [],
    today: {
      ticketsShipped: null,
      failedSessions: null,
      costUsd: null,
      projects: null,
      sessions: null,
    },
    yourTurn: { awaitingReply: [], failed: [], conflicts: [] },
    readyToLand: [],
    heldBackCount: 0,
    upNext: [],
    ...overrides,
  };
}

function workingSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    projectId: "p1",
    epicId: "e1",
    readableId: "ARJ-1",
    title: "Ship the bar",
    taskType: "BUILD",
    agentName: "Opus Builder",
    startedAt: "2026-08-30T07:00:00.000Z",
    lastLogLine: null,
    nightRun: false,
    stale: false,
    ...overrides,
  } as ControlDeskPayload["working"][number];
}

beforeEach(() => {
  barState.pathname = "/";
  barState.projects = [];
  barState.push = vi.fn();
  barState.desk = null;
  barState.autoLoaded = true;
  barState.armed = new Map();
  window.localStorage.clear();
  // The snapshot lives as long as the document does; jsdom gives every case the
  // same one, so each starts it over. Without this a case that seeds storage to
  // stand for an earlier visit would read the previous case's snapshot instead.
  resetLastVisitedProjectId();
});

/* ------------------------------------------------------------------ */
/* The last-visited project store                                      */
/* ------------------------------------------------------------------ */

/**
 * `localStorage` is an external store, and the bar reads it through
 * `useSyncExternalStore`. That only stays live if a write tells React the
 * snapshot moved, so the notification is part of the contract, not an
 * implementation detail.
 */
describe("last visited project store", () => {
  it("notifies its subscribers when a visit is recorded", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLastVisitedProjectId(listener);

    rememberVisitedProjectId("p9");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(readLastVisitedProjectId()).toBe("p9");
    unsubscribe();
  });

  it("reads nothing on the server, whatever storage holds", () => {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "p9");

    // The server snapshot of `useSyncExternalStore`. jsdom has a `window`, so
    // only an unconditional `null` keeps the server render independent of the
    // browser's storage.
    expect(readNoVisitedProjectId()).toBeNull();
    expect(readLastVisitedProjectId()).toBe("p9");
  });

  it("stops notifying once unsubscribed", () => {
    const listener = vi.fn();
    subscribeLastVisitedProjectId(listener)();

    rememberVisitedProjectId("p9");

    expect(listener).not.toHaveBeenCalled();
  });

  /**
   * `localStorage` is shared by every tab, and nothing announces another tab's
   * write to this one. The snapshot is read on every render, so treating the
   * shared key as the live value let a second tab move this document's project
   * scope silently.
   */
  it("holds the snapshot a foreign write never announced", () => {
    rememberVisitedProjectId("a");

    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "b");

    expect(readLastVisitedProjectId()).toBe("a");
  });

  it("keeps a visit it could not persist", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    rememberVisitedProjectId("p9");
    setItem.mockRestore();

    // Nothing was written, and the visit is remembered all the same: the store
    // is this document's, storage is only where it survives the document.
    expect(window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBeNull();
    expect(readLastVisitedProjectId()).toBe("p9");
  });

  it("still notifies when the write itself is refused", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLastVisitedProjectId(listener);
    // Safari private mode throws on `setItem`. The snapshot is worth re-reading
    // either way, and a swallowed write must not swallow the notification.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    expect(() => rememberVisitedProjectId("p9")).not.toThrow();

    expect(listener).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
    unsubscribe();
  });
});

/* ------------------------------------------------------------------ */
/* The nav model                                                       */
/* ------------------------------------------------------------------ */

describe("nav model", () => {
  it("is the three categories of frame 13a, in order", () => {
    expect(NAV_CATEGORIES.map((category) => category.label)).toEqual([
      "Work",
      "Agents",
      "Réglages",
    ]);
    expect(NAV_CATEGORIES.map((category) => category.stratum)).toEqual([
      "next",
      "live",
      "feed",
    ]);
  });

  /**
   * The paths the screen agents of the next wave have to match. This test is
   * the contract: changing one here is a deliberate act, not a drift.
   */
  it("claims exactly these routes", () => {
    const claimed = NAV_CATEGORIES.flatMap((category) =>
      category.entries.map((entry) => `${entry.id} ${entry.href}${entry.planned ? " (planned)" : ""}`),
    );
    expect(claimed).toEqual([
      "tickets /tickets",
      "spec /projects/:projectId/spec",
      "qa /qa",
      "releases /projects/:projectId/releases",
      "named-agents /agents",
      "sessions /projects/:projectId/sessions",
      "usage /usage",
      "workspace /settings",
      "night-runs /settings#night-runs",
      "notifications /settings#notifications",
      "integrations /settings/integrations",
    ]);
  });

  /**
   * Wave 2 built /tickets, /qa and /chat, so no entry is soft-for-lack-of-a-
   * screen any more. The mechanism stays for the next screen claimed before it
   * exists — this pins the behaviour, not a current entry.
   */
  it("still refuses to link a screen that does not exist yet", () => {
    expect(NAV_CATEGORIES.flatMap((c) => c.entries).filter((e) => e.planned)).toEqual([]);

    const unbuilt = { ...NAV_CATEGORIES[0].entries[0], planned: true } as NavEntry;
    expect(resolveNavHref(unbuilt, "p1")).toBeNull();
    expect(navHrefBlockedReason(unbuilt, "p1")).toBe("planned");
  });

  it("resolves a per-project entry only when a project is active", () => {
    const spec = NAV_CATEGORIES[0].entries[1];
    expect(resolveNavHref(spec, null)).toBeNull();
    expect(navHrefBlockedReason(spec, null)).toBe("needs-project");
    expect(resolveNavHref(spec, "p7")).toBe("/projects/p7/spec");
    expect(navHrefBlockedReason(spec, "p7")).toBeNull();
  });

  it("keeps an entry lit on its sub-routes", () => {
    const namedAgents = NAV_CATEGORIES[1].entries[0];
    expect(isNavEntryActive(namedAgents, "/agents", null)).toBe(true);
    expect(isNavEntryActive(namedAgents, "/agents/limits", null)).toBe(true);
    expect(isNavEntryActive(namedAgents, "/agentsx", null)).toBe(false);
  });

  it("puts no category on the desk or on /chat — both are direct destinations", () => {
    expect(activeNavCategory("/", null)).toBeNull();
    expect(activeNavCategory("/chat", null)).toBeNull();
    expect(activeNavCategory("/chat", "p1")).toBeNull();
    expect(activeNavCategory("/agents", null)?.id).toBe("agents");
    expect(activeNavCategory("/projects/p1/spec", "p1")?.id).toBe("work");
    expect(activeNavCategory("/settings", null)?.id).toBe("settings");
  });

  it("sends a bubble click to the first entry that actually leads somewhere", () => {
    const [work, agents, settings] = NAV_CATEGORIES;
    expect(firstReachableHref(work, null)).toBe("/tickets");
    expect(firstReachableHref(work, "p1")).toBe("/tickets");
    expect(firstReachableHref(agents, null)).toBe("/agents");
    expect(firstReachableHref(settings, null)).toBe("/settings");
  });
});

/* ------------------------------------------------------------------ */
/* Which project a per-project entry resolves against                  */
/* ------------------------------------------------------------------ */

describe("scope project", () => {
  it("prefers the URL over everything else", () => {
    expect(
      resolveScopeProjectId({
        routeProjectId: "route",
        lastVisitedProjectId: "remembered",
        knownProjectIds: ["route", "remembered"],
      }),
    ).toBe("route");
  });

  /**
   * The bug this fixes: with several projects and none in the URL, every
   * per-project entry went soft, so hovering Work on the desk produced four
   * unclickable rows. The last project the user opened is a choice they made,
   * so it stands in — it is not the bar picking one for them.
   */
  it("falls back to the last project the user actually visited", () => {
    expect(
      resolveScopeProjectId({
        routeProjectId: null,
        lastVisitedProjectId: "b",
        knownProjectIds: ["a", "b", "c"],
      }),
    ).toBe("b");
  });

  it("ignores a remembered project that no longer exists", () => {
    expect(
      resolveScopeProjectId({
        routeProjectId: null,
        lastVisitedProjectId: "deleted",
        knownProjectIds: ["a", "b"],
      }),
    ).toBeNull();
  });

  it("stands in the sole project of a one-project workspace", () => {
    expect(
      resolveScopeProjectId({
        routeProjectId: null,
        lastVisitedProjectId: null,
        knownProjectIds: ["solo"],
      }),
    ).toBe("solo");
  });

  it("has no scope before the projects have loaded", () => {
    expect(
      resolveScopeProjectId({
        routeProjectId: null,
        lastVisitedProjectId: "b",
        knownProjectIds: [],
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Statuses — no invented numerals                                     */
/* ------------------------------------------------------------------ */

describe("menu statuses", () => {
  it("says nothing at all without a desk payload", () => {
    expect(deriveStatuses(null).size).toBe(0);
  });

  it("omits a count rather than printing a zero", () => {
    const statuses = deriveStatuses(deskPayload());
    expect(statuses.has("qa")).toBe(false);
    expect(statuses.has("sessions")).toBe(false);
    expect(statuses.has("usage")).toBe(false);
  });

  it("prints blocking findings in the danger tone and live sessions with a dot", () => {
    const statuses = deriveStatuses(
      deskPayload({
        heldBackCount: 1,
        working: [workingSession(), workingSession({ sessionId: "s2" })],
        today: {
          ticketsShipped: 7,
          failedSessions: 0,
          costUsd: 12.5,
          projects: 2,
          sessions: 9,
        },
      }),
    );

    expect(statuses.get("qa")).toEqual({ text: "1 blocking", tone: "danger" });
    expect(statuses.get("sessions")).toEqual({
      text: "2 live",
      tone: "live-deep",
      live: true,
    });
    expect(statuses.get("usage")?.text).toBe("$12.50 today");
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

describe("route helpers", () => {
  it("reads the project out of the path, and only a real one", () => {
    expect(projectIdFromPath("/projects/p1")).toBe("p1");
    expect(projectIdFromPath("/projects/p1/sessions/s2")).toBe("p1");
    expect(projectIdFromPath("/projects/new")).toBeNull();
    expect(projectIdFromPath("/projects/import")).toBeNull();
    expect(projectIdFromPath("/agents")).toBeNull();
  });

  it("puts the live dot on the category that owns sessions, and only when alive", () => {
    const [work, agents] = NAV_CATEGORIES;
    expect(categoryIsLive(agents, 3)).toBe(true);
    expect(categoryIsLive(agents, 0)).toBe(false);
    expect(categoryIsLive(work, 3)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The bar                                                             */
/* ------------------------------------------------------------------ */

describe("TopBar", () => {
  it("renders the logo mark, five island pills and the fixed right cluster", () => {
    render(<TopBar />);

    expect(screen.getByTestId("top-bar-home")).toHaveAttribute("href", "/");
    expect(screen.getByTestId("top-bar-bubble-now")).toHaveTextContent("Now");
    expect(screen.getByTestId("top-bar-bubble-work")).toHaveTextContent("Work");
    expect(screen.getByTestId("top-bar-bubble-chat")).toHaveTextContent("Chat");
    expect(screen.getByTestId("top-bar-bubble-agents")).toHaveTextContent("Agents");
    expect(screen.getByTestId("top-bar-bubble-settings")).toHaveTextContent("Réglages");
    expect(screen.getByTestId("top-bar-search")).toHaveTextContent("⌘K");
    expect(screen.getByTestId("top-bar-inbox")).toBeInTheDocument();
    expect(screen.getByTestId("top-bar-auto")).toHaveTextContent("Auto");
    expect(screen.getByTestId("top-bar-new")).toHaveTextContent("New");
  });

  /* ---- Island destinations and category pills ------------------------- */

  it("puts Now first, Work second, Chat next to Work in the centred island", () => {
    render(<TopBar />);

    const pills = islandPills();
    expect(pills.map((node) => node.getAttribute("data-testid"))).toEqual([
      "top-bar-bubble-now",
      "top-bar-bubble-work",
      "top-bar-bubble-chat",
      "top-bar-bubble-agents",
      "top-bar-bubble-settings",
    ]);
  });

  /* ---- Chat, the fifth pill next to Work ------------------------------- */

  it("marks Chat active on /chat and inactive on every other route", () => {
    barState.pathname = "/chat";
    const { unmount } = render(<TopBar />);
    expect(screen.getByTestId("top-bar-bubble-chat")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("top-bar-bubble-chat")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("top-bar-bubble-now")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("top-bar-bubble-work")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("top-bar-bubble-agents")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("top-bar-bubble-settings")).not.toHaveAttribute("data-active");
    unmount();

    for (const pathname of ["/", "/agents/prompts", "/tickets", "/projects/p1", "/settings"]) {
      barState.pathname = pathname;
      const view = render(<TopBar />);
      expect(screen.getByTestId("top-bar-bubble-chat")).not.toHaveAttribute(
        "data-active",
      );
      view.unmount();
    }
  });

  it("takes a click directly to /chat from anywhere", () => {
    barState.pathname = "/settings";
    render(<TopBar />);

    // A real <a href="/chat">, so navigation is the browser's, not router.push's.
    expect(screen.getByTestId("top-bar-bubble-chat")).toHaveAttribute("href", "/chat");
  });

  it("gives Chat no menu: no popup role, and hover opens nothing", () => {
    barState.pathname = "/tickets";
    vi.useFakeTimers();
    try {
      render(<TopBar />);
      const chat = screen.getByTestId("top-bar-bubble-chat");

      expect(chat).not.toHaveAttribute("aria-haspopup");
      expect(chat).not.toHaveAttribute("aria-expanded");

      fireEvent.mouseEnter(chat);
      fireEvent.focus(chat);
      act(() => void vi.advanceTimersByTime(1000));

      for (const id of ["now", "chat", "work", "agents", "settings"]) {
        expect(screen.queryByTestId(`top-bar-menu-${id}`)).not.toBeInTheDocument();
      }

      // Control: the SAME gesture on a real bubble does open one.
      fireEvent.mouseEnter(screen.getByTestId("top-bar-bubble-work"));
      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.getByTestId("top-bar-menu-work")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an open category menu when focus moves to Chat or Now", () => {
    render(<TopBar />);
    const work = screen.getByTestId("top-bar-bubble-work");
    const chat = screen.getByTestId("top-bar-bubble-chat");
    const now = screen.getByTestId("top-bar-bubble-now");

    fireEvent.focus(work);
    expect(screen.getByTestId("top-bar-menu-work")).toBeInTheDocument();

    fireEvent.focus(chat);
    expect(screen.queryByTestId("top-bar-menu-work")).not.toBeInTheDocument();

    fireEvent.focus(work);
    expect(screen.getByTestId("top-bar-menu-work")).toBeInTheDocument();

    fireEvent.focus(now);
    expect(screen.queryByTestId("top-bar-menu-work")).not.toBeInTheDocument();
  });

  it("marks Now active on the desk and inactive on every other route", () => {
    const { unmount } = render(<TopBar />);
    expect(screen.getByTestId("top-bar-bubble-now")).toHaveAttribute(
      "data-active",
      "true",
    );
    unmount();

    for (const pathname of ["/agents/prompts", "/tickets", "/projects/p1", "/settings"]) {
      barState.pathname = pathname;
      const view = render(<TopBar />);
      expect(screen.getByTestId("top-bar-bubble-now")).not.toHaveAttribute(
        "data-active",
      );
      view.unmount();
    }
  });

  it("takes a click back to the desk from anywhere", () => {
    barState.pathname = "/settings";
    render(<TopBar />);

    // A real <a href="/">, so navigation is the browser's, not router.push's.
    expect(screen.getByTestId("top-bar-bubble-now")).toHaveAttribute("href", "/");
  });

  it("gives Now no menu: no popup role, and hover opens nothing", () => {
    barState.pathname = "/tickets";
    // The bubbles open on a 120ms hover intent, so the wait has to be real
    // time-travel — asserting immediately after the mouseEnter would pass even
    // if Now DID open a menu.
    vi.useFakeTimers();
    try {
      render(<TopBar />);
      const now = screen.getByTestId("top-bar-bubble-now");

      expect(now).not.toHaveAttribute("aria-haspopup");
      expect(now).not.toHaveAttribute("aria-expanded");

      fireEvent.mouseEnter(now);
      fireEvent.focus(now);
      act(() => void vi.advanceTimersByTime(1000));

      for (const id of ["now", "work", "agents", "settings"]) {
        expect(screen.queryByTestId(`top-bar-menu-${id}`)).not.toBeInTheDocument();
      }

      // Control: the SAME gesture on a real bubble does open one, so the
      // assertion above is about Now and not about the timers.
      fireEvent.mouseEnter(screen.getByTestId("top-bar-bubble-work"));
      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.getByTestId("top-bar-menu-work")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the left zone as the logo alone — no Now label beside it", () => {
    render(<TopBar />);
    const logo = screen.getByTestId("top-bar-home");

    // The mark keeps its accessible name; the word moved to the island.
    expect(logo).toHaveAttribute("aria-label", "Now — control desk");
    expect(logo).toHaveTextContent("A");
    expect(logo.textContent).not.toMatch(/Now/);
  });

  /**
   * The left zone used to be capped by an inline `calc(50% - 235px)`, a number
   * MEASURED against a known pill count — and one that went negative (so:
   * clamped to zero, chips gone) below 470px. B-arij-164 replaced it with a
   * flex share: both flanks grow from a zero basis, which centres the island by
   * arithmetic and needs no re-measuring when a sixth pill lands.
   *
   * The count is still pinned here, because the numbers in
   * `__tests__/top-bar-responsive.test.tsx` and in `e2e/top-bar-responsive.spec.ts`
   * were measured against five pills — a sixth needs the 320px fit re-checked.
   */
  it("holds the island's middle with a flex share, not a measured cap", () => {
    render(<TopBar />);

    expect(islandPills()).toHaveLength(5);

    const chips = screen.getByTestId("top-bar-project-chips");
    const left = chips.parentElement as HTMLElement;
    expect(left.style.maxWidth).toBe("");
    expect(left.className).toContain("flex-1");
    expect(left.className).toContain("basis-0");
  });

  it("marks no bubble on the desk and the right one elsewhere", () => {
    const { unmount } = render(<TopBar />);
    for (const id of ["work", "agents", "settings"]) {
      expect(screen.getByTestId(`top-bar-bubble-${id}`)).not.toHaveAttribute("data-active");
    }
    unmount();

    barState.pathname = "/agents/prompts";
    render(<TopBar />);
    expect(screen.getByTestId("top-bar-bubble-agents")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("top-bar-bubble-work")).not.toHaveAttribute("data-active");
  });

  it("opens a menu on focus and closes it on Escape", () => {
    render(<TopBar />);
    const bubble = screen.getByTestId("top-bar-bubble-agents");

    expect(screen.queryByTestId("top-bar-menu-agents")).not.toBeInTheDocument();
    fireEvent.focus(bubble);
    expect(screen.getByTestId("top-bar-menu-agents")).toBeInTheDocument();
    expect(bubble).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(bubble, { key: "Escape" });
    expect(screen.queryByTestId("top-bar-menu-agents")).not.toBeInTheDocument();
  });

  /**
   * Both dismissals used to run from `useEffect`, so the new route painted once
   * with the old menu or palette still on screen. They are adjusted during
   * render now; these pin the behaviour either way, which is the point — the
   * refactor that reopened this file to the React Compiler had to keep it.
   */
  it("dismisses an open menu when the route changes", () => {
    const { rerender } = render(<TopBar />);
    fireEvent.focus(screen.getByTestId("top-bar-bubble-agents"));
    expect(screen.getByTestId("top-bar-menu-agents")).toBeInTheDocument();

    barState.pathname = "/tickets";
    rerender(<TopBar />);

    expect(screen.queryByTestId("top-bar-menu-agents")).not.toBeInTheDocument();
  });

  it("keeps the menu open across a re-render that is not a navigation", () => {
    const { rerender } = render(<TopBar />);
    fireEvent.focus(screen.getByTestId("top-bar-bubble-agents"));

    rerender(<TopBar />);

    // The guard compares pathnames; an unconditional reset would close it here
    // and make the menu unusable.
    expect(screen.getByTestId("top-bar-menu-agents")).toBeInTheDocument();
  });

  it("navigates to the menu's first reachable entry on click", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTestId("top-bar-bubble-agents"));
    expect(barState.push).toHaveBeenCalledWith("/agents");
  });

  it("opens the cross-project registries whatever the project scope is", () => {
    render(<TopBar />);
    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));

    // No project anywhere, and Work still has three live destinations.
    expect(screen.getByTestId("top-bar-entry-tickets")).toHaveAttribute(
      "href",
      "/tickets",
    );
    expect(screen.getByTestId("top-bar-entry-qa")).toHaveAttribute("href", "/qa");
    fireEvent.focus(screen.getByTestId("top-bar-bubble-agents"));
    expect(screen.getByTestId("top-bar-entry-named-agents")).toHaveAttribute(
      "href",
      "/agents",
    );
    expect(screen.getByTestId("top-bar-entry-usage")).toHaveAttribute("href", "/usage");
  });

  it("softens a per-project entry until a project is active", () => {
    render(<TopBar />);
    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));
    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });

  it("resolves per-project entries against the project in the URL", () => {
    barState.pathname = "/projects/p9/sessions";
    barState.projects = [project({ id: "p9" })];
    render(<TopBar />);

    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));
    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      "/projects/p9/spec",
    );
    expect(screen.getByTestId("top-bar-entry-releases")).toHaveAttribute(
      "href",
      "/projects/p9/releases",
    );
  });

  it("stands in the only project when there is exactly one and none in the URL", () => {
    barState.projects = [project({ id: "solo" })];
    render(<TopBar />);

    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));
    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      "/projects/solo/spec",
    );
  });

  /**
   * The reported bug: with several projects and none in the URL every entry of
   * the Work menu was soft, so the menu opened with nothing to click.
   */
  it("resolves per-project entries against the last project visited", () => {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "b");
    barState.projects = [project({ id: "a" }), project({ id: "b", name: "B" })];
    render(<TopBar />);

    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));
    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      "/projects/b/spec",
    );
  });

  it("remembers the project of the route it is on", () => {
    barState.pathname = "/projects/p9/sessions";
    barState.projects = [project({ id: "p9" }), project({ id: "other", name: "O" })];
    render(<TopBar />);

    expect(window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBe("p9");
  });

  /**
   * The remembered project is read from `localStorage` through
   * `useSyncExternalStore`, which requires a server snapshot: without one the
   * server render throws outright rather than degrading. The bar is in
   * `app/layout.tsx`, so that would be every route at once.
   *
   * This does not pin *which* value the server sees — `lastVisitedProjectId`
   * only reaches the menu, which mounts on interaction, so it leaves no mark
   * on the bar's own markup to mismatch against. `readNoVisitedProjectId`
   * carries that half of the contract, below.
   */
  it("renders on the server, where there is no storage to read", () => {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "b");
    barState.projects = [project({ id: "a" }), project({ id: "b", name: "B" })];

    expect(() => renderToString(<TopBar />)).not.toThrow();
  });

  it("stays soft when the remembered project is gone", () => {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "deleted");
    barState.projects = [project({ id: "a" }), project({ id: "b", name: "B" })];
    render(<TopBar />);

    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));
    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });

  /**
   * Only a route change may move the project scope. A second tab writing the
   * shared key is not one — and this document is never told about it, so the
   * bar must not pick it up on the next render it happens to do.
   */
  it("keeps its scope when another document overwrites shared storage", () => {
    barState.projects = [project({ id: "a" }), project({ id: "b", name: "B" })];
    barState.pathname = "/projects/a/spec";
    const { rerender } = render(<TopBar />);

    barState.pathname = "/";
    rerender(<TopBar />);

    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "b");
    // Opening the menu is a render like any other; it must not import the
    // other tab's project.
    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));

    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      "/projects/a/spec",
    );
  });

  /**
   * Safari private mode throws on `setItem`. The visit still happened, so the
   * bar has to keep resolving against it — falling back to whatever an earlier
   * document left in storage points the menu at the wrong project.
   */
  it("resolves against a visit it could not persist", () => {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "b");
    barState.projects = [project({ id: "a" }), project({ id: "b", name: "B" })];
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    barState.pathname = "/projects/a/spec";
    const { rerender } = render(<TopBar />);
    barState.pathname = "/";
    rerender(<TopBar />);
    setItem.mockRestore();

    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));

    expect(screen.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      "/projects/a/spec",
    );
  });

  it("breathes a dot on Agents only while something is running", () => {
    barState.projects = [project({ activeAgents: 0 })];
    const { unmount } = render(<TopBar />);
    expect(screen.queryByTestId("top-bar-live-agents")).not.toBeInTheDocument();
    unmount();

    barState.projects = [project({ activeAgents: 2 })];
    render(<TopBar />);
    expect(screen.getByTestId("top-bar-live-agents")).toBeInTheDocument();
    expect(screen.queryByTestId("top-bar-live-work")).not.toBeInTheDocument();
  });

  it("paints Auto turquoise only once the settings read says a project is armed", () => {
    barState.projects = [project({ id: "p1" })];
    barState.autoLoaded = false;
    const { unmount } = render(<TopBar />);
    expect(screen.getByTestId("top-bar-auto")).toHaveAttribute("data-state", "unknown");
    unmount();

    barState.autoLoaded = true;
    barState.armed = new Map([["p1", true]]);
    render(<TopBar />);
    expect(screen.getByTestId("top-bar-auto")).toHaveAttribute("data-state", "on");
    expect(screen.getByTestId("top-bar-auto")).toHaveAttribute("href", "/settings");
  });

  it("fills the CE MATIN digest from the desk and drops the lines it has no figure for", () => {
    barState.desk = deskPayload({
      heldBackCount: 2,
      today: {
        ticketsShipped: 7,
        failedSessions: null,
        costUsd: null,
        projects: null,
        sessions: null,
      },
    });
    render(<TopBar />);
    fireEvent.focus(screen.getByTestId("top-bar-bubble-work"));

    expect(screen.getByTestId("top-bar-digest-shipped")).toHaveTextContent("7");
    expect(screen.getByTestId("top-bar-digest-blocking")).toHaveTextContent("2");
    expect(screen.queryByTestId("top-bar-digest-ready")).not.toBeInTheDocument();
    expect(screen.queryByTestId("top-bar-digest-waiting")).not.toBeInTheDocument();
  });

  it("lists live agents under EN CE MOMENT, grouped", () => {
    barState.desk = deskPayload({
      working: [
        workingSession(),
        workingSession({ sessionId: "s2" }),
        workingSession({ sessionId: "s3", agentName: "Security CC" }),
      ],
    });
    render(<TopBar />);
    fireEvent.focus(screen.getByTestId("top-bar-bubble-agents"));

    const rows = screen.getAllByTestId("top-bar-live-agent");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Opus Builder × 2",
      "Security CC",
    ]);
  });

  it("points New at the registry's create surface, not at the desk composer", () => {
    render(<TopBar />);
    expect(screen.getByTestId("top-bar-new")).toHaveAttribute("href", "/tickets/new");
  });
});

/* ------------------------------------------------------------------ */
/* ⌘K — one binding, in the bar                                        */
/* ------------------------------------------------------------------ */

describe("the command palette", () => {
  it("opens on ⌘K and on the pill, and closes on Escape", async () => {
    render(<TopBar />);
    expect(screen.queryByTestId("desk-command-palette")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByTestId("desk-command-palette")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("desk-command-input"), { key: "Escape" });
    expect(screen.queryByTestId("desk-command-palette")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("top-bar-search"));
    expect(screen.getByTestId("desk-command-palette")).toBeInTheDocument();
  });

  it("dismisses the palette when the route changes", () => {
    const { rerender } = render(<TopBar />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("desk-command-palette")).toBeInTheDocument();

    barState.pathname = "/projects/p1";
    rerender(<TopBar />);

    expect(screen.queryByTestId("desk-command-palette")).not.toBeInTheDocument();
  });

  it("keeps the palette open across a re-render that is not a navigation", () => {
    const { rerender } = render(<TopBar />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    rerender(<TopBar />);

    expect(screen.getByTestId("desk-command-palette")).toBeInTheDocument();
  });

  it("floats on the scrim alone, with no shadow", () => {
    // `--shadow-overlay` is the only shadow in the system and it belongs to
    // the ticket overlay.
    render(<TopBar />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog").className).not.toContain("shadow-");
  });

  /**
   * The bar sits outside every screen's providers, so a result cannot reach
   * into the desk's ticket overlay: each one is a URL. `?ticket=` is the deep
   * link `/projects/:id` already reads.
   */
  it("routes a ticket result instead of reaching into a screen", () => {
    barState.desk = deskPayload({
      projects: [
        {
          id: "p1",
          name: "Arij",
          shortName: "ARIJ",
          colorIndex: 0,
          activeAgents: 0,
          autoModeEnabled: false,
        },
      ],
      readyToLand: [
        {
          epicId: "e2",
          projectId: "p1",
          readableId: "ARJ-107",
          title: "Rail",
          prNumber: null,
          usDone: 1,
          usCount: 1,
          openFindings: 0,
          agentBusy: false,
        },
      ],
    });
    render(<TopBar />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const results = screen.getAllByTestId("desk-command-result");
    fireEvent.click(results[0]);
    expect(barState.push).toHaveBeenCalledWith("/projects/p1");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const ticket = screen
      .getAllByTestId("desk-command-result")
      .find((row) => row.textContent?.includes("ARJ-107"))!;
    fireEvent.click(ticket);
    expect(barState.push).toHaveBeenCalledWith("/projects/p1?ticket=e2");
  });
});
