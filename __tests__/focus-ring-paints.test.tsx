/**
 * B-arij-JJ5FdaHpX7d6 — the keyboard focus ring is dead in the whole TopBar.
 *
 * THE DEFECT. Every control in the app's one chrome carries
 * `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`
 * *and* `outline-none`. In Tailwind v4 those two cancel:
 *
 *     .outline-none             { --tw-outline-style: none; outline-style: none; }
 *     .focus-visible\:outline-2 { &:focus-visible {
 *         outline-style: var(--tw-outline-style); outline-width: 2px; } }
 *
 * `:focus-visible` matches, the width and the colour are applied, and
 * `outline-style` still resolves to `none` — so nothing is ever painted.
 * Measured in Chrome on the unfixed bar (viewport 1440×950, route /tickets):
 *
 *     {"id":"top-bar-bubble-chat","matchesFocusVisible":true,
 *      "outline":"rgb(111, 203, 180) none 2px","outlineOffset":"2px"}
 *
 * WHY THIS FILE ASSERTS A RESOLVED VALUE AND NOT A CLASS NAME. The regression
 * shipped *with* `focus-visible:outline-2` present on every control, so
 * `expect(className).toContain("focus-visible:outline-2")` passes on the bug.
 * Only the resolved `outline-style` separates the two states, so that is what
 * is asserted here — the class list is compiled by the real Tailwind engine and
 * the cascade is resolved for the `:focus-visible` state
 * (`__tests__/helpers/tailwind-outline.ts`).
 *
 * WHAT THIS FILE DOES NOT PROVE. It is not a browser: jsdom has no layout and
 * loads no CSS, so the class lists are read off the rendered DOM and resolved
 * out-of-band. That the ring is actually *drawn* on screen is a visual claim,
 * measured in real Chrome by `e2e/focus-ring.spec.ts`.
 *
 * NOR THE OTHER SHAPE. Everything here is about a ring that IS declared and
 * fails to paint. An element that clears the outline and declares NO focus
 * affordance at all is invisible to this file by construction — nothing to
 * resolve, nothing to repair. That one is `./focus-ring-undeclared.test.tsx`
 * and `e2e/focus-ring-inputs.spec.ts` (B-arij-203).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  describeSite,
  outlinePairingSites,
  scanSources,
} from "./helpers/class-list-scan";
import {
  classTokens,
  resolveFocusVisibleOutline,
} from "./helpers/tailwind-outline";

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

/**
 * The controls named in the bug report, in the order the reporter tabbed
 * through them.
 */
const TOP_BAR_CONTROLS = [
  "top-bar-bubble-now",
  "top-bar-bubble-work",
  "top-bar-bubble-chat",
  "top-bar-bubble-agents",
  "top-bar-new",
  "top-bar-inbox",
] as const;

beforeEach(() => {
  barState.pathname = "/";
  barState.projects = [
    {
      id: "p1",
      name: "Arij",
      status: "building",
      activeAgents: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
});

describe("the Tailwind v4 mechanism the bug rests on", () => {
  /**
   * Pin the cause, so a future reader does not have to rediscover why
   * `outline-none` and `focus-visible:outline-2` are not independent.
   */
  it("lets outline-none defeat a bare focus-visible:outline-2", async () => {
    const resolved = await resolveFocusVisibleOutline([
      "outline-none",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-ring",
    ]);

    expect(resolved.width).toBe("2px");
    expect(resolved.offset).toBe("2px");
    expect(resolved.style).toBe("none");
    expect(resolved.paints).toBe(false);
  });

  /**
   * The control: the same ring with the style stated explicitly paints, which
   * is what makes the assertions below meaningful rather than vacuous.
   */
  it("paints once the style is stated explicitly", async () => {
    const resolved = await resolveFocusVisibleOutline([
      "outline-none",
      "focus-visible:outline-2",
      "focus-visible:outline-solid",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-ring",
    ]);

    expect(resolved.width).toBe("2px");
    expect(resolved.style).toBe("solid");
    expect(resolved.paints).toBe(true);
  });

  /**
   * A control that deliberately suppresses the outline keeps doing so — the
   * fix must not paint a ring on top of the dialog closers, which use a
   * box-shadow `ring` instead.
   */
  it("still suppresses the outline for focus-visible:outline-none", async () => {
    const resolved = await resolveFocusVisibleOutline([
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:outline-none",
    ]);

    expect(resolved.paints).toBe(false);
  });
});

describe("TopBar — every control paints a keyboard focus ring", () => {
  it.each(TOP_BAR_CONTROLS)("%s", async (testId) => {
    render(<TopBar />);
    const control = screen.getByTestId(testId);

    const resolved = await resolveFocusVisibleOutline(
      classTokens(control.className),
    );

    expect(
      resolved.paints,
      `${testId} resolves outline-style: ${resolved.style} under :focus-visible, ` +
        `so no ring is painted (width ${resolved.width}, colour ${resolved.color}). ` +
        `Class list: ${control.className}`,
    ).toBe(true);
  });
});


/* ================================================================== */
/* The sweep                                                          */
/* ================================================================== */

/**
 * The bar was not the only place the pairing occurred — it was 41 files.
 *
 * THIS SCAN UNDER-REPORTS, on purpose rather than by accident. It groups
 * ADJACENT string literals, which is the shape of a `cn(…)` argument list and
 * of a `cva` base array, so it sees `outline-none` and a focus ring written on
 * two different lines of the same element. It does NOT see a base class and a
 * conditional variant separated by an expression, and it cannot see a class
 * list composed across components at all. Every site it does find is a real
 * one; "no sites left" would not prove the codebase is clean. The rendered
 * assertions above are what cover composition.
 *
 * IT ALSO USED TO UNDER-REPORT BY ACCIDENT (B-arij-206). The literal/comment
 * grouping was two regexes that did not know about each other, so a comment
 * naming a utility between backticks read as a template literal and split one
 * element's class list in two — silently, since the only guard was a total
 * count. Over this tree the hole hid 8 sites, `top-bar-home` and
 * `top-bar-add-project` among them. The scanner now lexes
 * (`./helpers/class-list-scan`, tested by `./focus-ring-scan.test.ts`).
 */
const sites = scanSources(outlinePairingSites);

/**
 * The files known to carry at least one site, so that a site DISAPPEARING is a
 * named failure rather than a count that drifts back under a threshold. A file
 * gaining a site needs no edit here; a file losing its last one does, and the
 * failure says which.
 *
 * Recorded 2026-09-05 over 50 sites in these 40 files.
 */
const SCANNED_FILES = [
  "app/projects/[projectId]/sessions/page.tsx",
  "components/agents-workshop/AddAgentCard.tsx",
  "components/agents-workshop/AgentRosterCard.tsx",
  "components/agents-workshop/CliDropdown.tsx",
  "components/agents-workshop/PersonaBand.tsx",
  "components/agents-workshop/PromptsView.tsx",
  "components/chat-page/CreatedHereCard.tsx",
  "components/chat-page/NewConversationCard.tsx",
  "components/desk/AttentionRow.tsx",
  "components/desk/DeskCommandPalette.tsx",
  "components/desk/DeskComposer.tsx",
  "components/desk/FullAutoProjectRow.tsx",
  "components/desk/LiveSessionCard.tsx",
  "components/desk/QueuedTile.tsx",
  "components/desk/ReadyToLandBand.tsx",
  "components/piscine/GhostInputPill.tsx",
  "components/piscine/IdentityChip.tsx",
  "components/piscine/PillButton.tsx",
  "components/piscine/QuietDangerAction.tsx",
  "components/piscine/QuietLink.tsx",
  "components/piscine/SegmentedControl.tsx",
  "components/piscine/SelectPill.tsx",
  "components/piscine/TopBar.tsx",
  "components/piscine/TopBarMenu.tsx",
  "components/qa/FindingFilterPills.tsx",
  "components/qa/QaQueuedTile.tsx",
  "components/qa/QaRunCard.tsx",
  "components/qa/RunQaPassButton.tsx",
  "components/releases/ReleaseHistory.tsx",
  "components/session-live/LiveLogBand.tsx",
  "components/settings-piscine/OpenAiCard.tsx",
  "components/settings-piscine/SettingField.tsx",
  "components/settings-piscine/SettingToggle.tsx",
  "components/spec/DocsCard.tsx",
  "components/spec/SpecUpdateProgress.tsx",
  "components/ticket/TicketScreenshots.tsx",
  "components/tickets-registry/GroupHeader.tsx",
  "components/tickets-registry/NewTicketView.tsx",
  "components/tickets-registry/RegistryRow.tsx",
  "components/usage/MonthlyCapTile.tsx",
] as const;

describe("every class list that pairs outline-none with an outline focus ring", () => {
  /**
   * Guards the guard. `it.each` over an empty array is a green run over
   * nothing, and the previous version of this — a bare `>= 40` — is what
   * turned a lost site into `expected 39 to be greater than or equal to 40`.
   */
  it("still finds every file it is meant to sweep", () => {
    const found = new Set(sites.map((s) => s.file));
    const missing = SCANNED_FILES.filter((file) => !found.has(file));

    expect(
      missing,
      `these files carried a scanned class list and no longer do — either the ` +
        `classes moved somewhere the scan cannot see, or the file was deleted ` +
        `and this inventory needs the same edit:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("sweeps every file it lists", () => {
    // The inventory is one-directional: a NEW file is swept without an edit
    // here. This only pins that the recorded ones are still the floor.
    expect(sites.length).toBeGreaterThanOrEqual(SCANNED_FILES.length);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line}`, s] as const))(
    "%s",
    async (_label, site) => {
      const resolved = await resolveFocusVisibleOutline(site.classes);

      expect(
        resolved.paints,
        `${describeSite(site)}\n\n` +
          `outline-none cancels the focus ring here: outline-style resolves to ` +
          `${resolved.style} under :focus-visible (width ${resolved.width}, ` +
          `colour ${resolved.color}). State the style explicitly ` +
          `(focus-visible:outline-solid) or drop outline-none.`,
      ).toBe(true);
    },
  );
});
