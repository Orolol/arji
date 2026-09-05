/**
 * B-arij-164 — the top bar's three groups collide below ~800px and the page
 * scrolls horizontally below ~470px.
 *
 * MEASURED IN CHROME on the unfixed bar (two projects, 2026-09-05, five island
 * pills):
 *   320px  documentElement.scrollWidth 380 vs clientWidth 320  → page scroll
 *   390px  scrollWidth 415 vs 390                              → page scroll
 *   768px  no page scroll, island×right-cluster overlap 122px
 *   1280 / 1440  clean
 * and at 320/390 the left zone measured 0px wide — `max-width: calc(50% - 235px)`
 * is negative there, so the project chips were not merely cramped, they were
 * gone.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
 *
 * jsdom has no layout engine and does not load Tailwind, so it can measure
 * neither an overlap nor a scrollWidth. What it CAN pin is the mechanism that
 * produced both:
 *
 *   1. the centre group taken OUT OF FLOW (`absolute … left-1/2
 *      -translate-x-1/2`), which is what let it sit on top of its neighbours
 *      rather than share the row with them;
 *   2. the left zone capped by an inline `calc(50% - 235px)`, which computes
 *      negative — and is therefore clamped to 0 — below 470px;
 *   3. the island's own pills never shrinking, so 439px of chrome had to go
 *      somewhere on a 320px screen.
 *
 * Those are string-level facts about the markup and they all flip with the fix.
 * The RENDERED GEOMETRY — no page-level horizontal scroll and no pairwise
 * intersection of the three zones at 320/390/768/1280/1440 — is a visual claim
 * and is measured in a real browser by `e2e/top-bar-responsive.spec.ts`. This
 * file is not a substitute for it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const barState = vi.hoisted(() => ({
  pathname: "/",
  projects: [] as Array<Record<string, unknown>>,
  push: vi.fn(),
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
    armed: new Map<string, boolean>(),
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

/** The three zones, by the test ids the bar has always exposed. */
function zones() {
  const island = screen.getByTestId("top-bar-island");
  const left = screen.getByTestId("top-bar-project-chips").parentElement as HTMLElement;
  const right = screen.getByTestId("top-bar-new").parentElement as HTMLElement;
  return { island, left, right };
}

/**
 * Does the class list carry `utility` with NO responsive prefix?
 *
 * The whole point of the fix is that the desktop bar is allowed to keep
 * utilities the mobile bar may not have, so a plain `includes()` would pass on
 * `xl:absolute` and prove nothing. Only the unprefixed token — the one that
 * applies at 320px — is the defect.
 */
function hasBaseUtility(element: HTMLElement, utility: string): boolean {
  return element.className
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => token === utility);
}

beforeEach(() => {
  barState.pathname = "/";
  barState.projects = [
    { id: "p1", name: "Arij", status: "building", activeAgents: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "p2", name: "Piscine Design", status: "building", activeAgents: 0, createdAt: "2026-01-02T00:00:00.000Z" },
  ];
});

describe("TopBar — the three zones share the row at every width", () => {
  /**
   * The reported collision, at its root: a group that is `position: absolute`
   * at 320px occupies no space in the row, so the browser is free to paint it
   * over both neighbours — which is exactly what the 390px screenshot showed
   * ("⌘K" under "Agents ●") and what the 768px measurement quantified
   * (122px of island over the right cluster).
   */
  it("does not take the centre island out of flow on a phone", () => {
    render(<TopBar />);
    const { island } = zones();

    for (const utility of ["absolute", "left-1/2", "-translate-x-1/2", "inset-y-0"]) {
      expect(
        hasBaseUtility(island, utility),
        `the island still carries "${utility}" with no breakpoint prefix, so at ` +
          `320px it is out of flow and paints over the left and right zones`,
      ).toBe(false);
    }
  });

  /**
   * `max-width: calc(50% - 235px)` is not merely tight below 470px — it is
   * NEGATIVE, so the used value is 0 and the project chips disappear entirely.
   * The audit's "projets toujours sélectionnables" criterion fails there.
   *
   * An inline style cannot carry a media query, so the cap cannot be repaired
   * in place: it has to go, and the centre has to be held by the flex share
   * instead (see the next test).
   */
  it("does not cap the left zone with an inline width that collapses to zero", () => {
    render(<TopBar />);
    const { left } = zones();

    expect(
      left.style.maxWidth,
      "the left zone still carries an inline max-width; below 470px it computes " +
        "negative and the project chips are clamped out of existence",
    ).toBe("");
  });

  /**
   * What replaces the absolute centring. Both flanks grow from a ZERO basis,
   * so they take equal shares of whatever is left over and the island lands in
   * the middle by arithmetic rather than by being lifted out of the row. A
   * zero basis is also what stops either flank from wrapping or from pushing
   * the island: its hypothetical size is 0, so it always fits.
   */
  it("lets the two flanks share the leftover width from a zero basis", () => {
    render(<TopBar />);
    const { left, right } = zones();

    for (const [name, zone] of [
      ["left", left],
      ["right", right],
    ] as const) {
      expect(
        hasBaseUtility(zone, "flex-1") && hasBaseUtility(zone, "basis-0"),
        `the ${name} zone must grow from a zero basis so the island keeps the middle`,
      ).toBe(true);
    }

    // The left zone must additionally be allowed to shrink past its content —
    // otherwise the project chips floor the row at their min-content width and
    // push the page wider than the viewport again.
    expect(hasBaseUtility(left, "min-w-0")).toBe(true);
  });

  /**
   * 439px of island cannot share a 320px row with a logo and four actions, so
   * below `lg` the island drops to its own line. `w-full` is what forces the
   * break; `lg:w-auto` is what puts it back in the middle of a single row.
   *
   * `lg`, not `md`: at 768 a single row DOES fit arithmetically, and the
   * measurement is what rejected it — the right cluster's min-content floor
   * (272px) took so much of the leftover that the left zone was left 4px and
   * the logo overflowed it. Measured in Chrome before this breakpoint moved.
   */
  it("gives the island its own line below lg and the middle of the row above it", () => {
    render(<TopBar />);
    const { island } = zones();
    const header = screen.getByTestId("top-bar");

    expect(hasBaseUtility(island, "w-full")).toBe(true);
    expect(island.className).toContain("lg:w-auto");
    expect(hasBaseUtility(header, "flex-wrap")).toBe(true);
    expect(header.className).toContain("lg:flex-nowrap");
  });

  /**
   * Even on its own line the island has to fit: 5 labelled pills measured
   * 439px against the 300px a 320px viewport leaves. The labels go to
   * `sr-only` below `sm` — VISUALLY hidden, never removed, so every pill keeps
   * its accessible name and the keyboard/screen-reader path the audit asks for
   * is untouched.
   */
  it("keeps every island label in the accessibility tree while hiding it on a phone", () => {
    render(<TopBar />);

    for (const [testId, label] of [
      ["top-bar-bubble-now", "Now"],
      ["top-bar-bubble-work", "Work"],
      ["top-bar-bubble-chat", "Chat"],
      ["top-bar-bubble-agents", "Agents"],
      ["top-bar-bubble-settings", "Réglages"],
    ] as const) {
      const pill = screen.getByTestId(testId);
      // Still readable by assistive tech and by `getByRole(name)`.
      expect(pill).toHaveTextContent(label);

      const hidden = Array.from(pill.querySelectorAll("span")).find(
        (span) => span.textContent === label,
      );
      expect(hidden, `${testId} must wrap its label so it can be hidden at 320px`).toBeDefined();
      expect(hasBaseUtility(hidden as HTMLElement, "sr-only")).toBe(true);
      expect((hidden as HTMLElement).className).toContain("sm:not-sr-only");
    }
  });

  /**
   * The same rule for the right cluster: 272px of ⌘K / Inbox / Auto / New is
   * more than a 320px row can hold beside the logo, so those three labels
   * collapse to their glyphs and keep their accessible names. They return at
   * `md` rather than at `sm` — the island has its own line until `lg`, but
   * these share theirs with the logo and the project chips.
   */
  it("keeps the right cluster's labels in the accessibility tree while hiding them on a phone", () => {
    render(<TopBar />);

    for (const [testId, label] of [
      ["top-bar-search", "⌘K"],
      ["top-bar-auto", "Auto"],
      ["top-bar-new", "New"],
    ] as const) {
      const control = screen.getByTestId(testId);
      expect(control).toHaveTextContent(label);

      const hidden = Array.from(control.querySelectorAll("span")).find(
        (span) => span.textContent === label,
      );
      expect(hidden, `${testId} must wrap its label so it can be hidden at 320px`).toBeDefined();
      expect(hasBaseUtility(hidden as HTMLElement, "sr-only")).toBe(true);
      expect((hidden as HTMLElement).className).toContain("md:not-sr-only");
    }
  });

  /**
   * THE RIGHT GUARDRAIL — the half B-arij-Gr4WgnOaRDQs was filed about.
   *
   * The bug report describes the bar as it stood at `f6b0179`: the island
   * centred with `absolute left-1/2 -translate-x-1/2` and protected on ONE
   * side only, by the `max-width: calc(50% - 235px)` this file's second test
   * already forbids. Nothing held the right, so the `ml-auto` cluster walked
   * inward under the out-of-flow island and captured its clicks — a click on
   * the right of "Réglages" opened the ⌘K palette instead.
   *
   * `052e062` removed the whole mechanism rather than adding a mirror cap, so
   * the right guard is now a NEGATIVE fact about the class list, and negative
   * facts rot silently: adding `min-w-0` to this zone is a one-token edit that
   * looks like tidying up after its neighbour. That is what this test exists
   * to catch.
   *
   * The asymmetry is deliberate and load-bearing. The left zone carries
   * `min-w-0`, so its chips scroll when the row is tight; this one does not,
   * so its `min-width: auto` floor is the row's hard floor and these four
   * controls are the last thing to give. Remove that asymmetry and the squeeze
   * has nowhere to go but back into the island.
   *
   * MARKUP ONLY, as everywhere in this file. That the cluster and the island
   * are actually clear of each other through the 820–1272 band the report
   * measured is a visual claim, and it is measured in Chrome by
   * `e2e/top-bar-responsive.spec.ts`.
   */
  it("keeps the right cluster in flow and lets it floor the row, never yield to the island", () => {
    render(<TopBar />);
    const { island, right, left } = zones();

    // In flow. An out-of-flow island was half the reported defect; an
    // out-of-flow right cluster is the same defect mirrored, and `ml-auto` is
    // the utility that used to walk it inward with nothing to stop it.
    for (const utility of ["absolute", "fixed", "ml-auto"]) {
      expect(
        hasBaseUtility(right, utility),
        `the right cluster still carries "${utility}" with no breakpoint prefix, ` +
          `so it does not reserve width against the island and the two can overlap`,
      ).toBe(false);
    }
    expect(
      hasBaseUtility(right, "justify-end"),
      "a flex-1 flank reaches the edge on its own; `justify-end` is what puts " +
        "the four controls at the far end of it without `ml-auto`",
    ).toBe(true);

    // The asymmetry, asserted as a PAIR so neither half can drift alone.
    expect(
      hasBaseUtility(left, "min-w-0"),
      "the left zone must shrink past its content — its chips are what absorbs the squeeze",
    ).toBe(true);
    expect(
      hasBaseUtility(right, "min-w-0"),
      "the right cluster must NOT shrink past its content: its min-content width " +
        "is the row's hard floor, and that floor is the only thing reserving " +
        "space against the island once the left-hand `calc(50% - 235px)` cap is gone",
    ).toBe(false);

    // And the island may not take that space back by refusing to yield the
    // row: it is `shrink-0`, so what gives under pressure is the left zone.
    expect(hasBaseUtility(island, "shrink-0")).toBe(true);
  });

  /**
   * The island is the menu's positioning context (`top-full` on
   * `TopBarMenu`). Taking it out of `absolute` would silently re-anchor the
   * menu on the <header>, so the replacement has to declare `relative`
   * itself — and stretch to the full line height, or the menu would open 14px
   * inside the bar instead of on its bottom edge.
   */
  it("keeps the island as the menu's positioning context", () => {
    render(<TopBar />);
    const { island } = zones();

    expect(hasBaseUtility(island, "relative")).toBe(true);
    expect(hasBaseUtility(island, "self-stretch")).toBe(true);
  });
});
