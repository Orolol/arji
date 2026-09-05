/**
 * B-arij-203 — two inputs strip the focus outline and put nothing in its place.
 *
 * A DIFFERENT SHAPE from the one `__tests__/focus-ring-paints.test.tsx` sweeps,
 * and structurally invisible to it. There, a ring IS declared and Tailwind v4's
 * `outline-none` stops it painting; `focus-visible:outline-solid` repairs it.
 * Here no ring is declared at all — `outline-none` removes the browser's own
 * default and nothing replaces it, so `outline-solid` would have nothing to
 * make solid. That sweep only looks at class lists carrying
 * `focus-visible:outline-<n>`, so it can never see these.
 *
 * The two reported sites, both text inputs a keyboard user reaches by Tab:
 *
 *   components/desk/DeskCommandPalette.tsx  the ⌘K search field
 *   app/projects/[projectId]/sessions/page.tsx   the "Filter by ticket" field
 *
 * WHAT THIS FILE PROVES. That the elements the user focuses carry a ring that
 * resolves to a painted outline, read off the rendered DOM and resolved with the
 * real Tailwind engine (`./helpers/tailwind-outline`). jsdom loads no CSS, so
 * that a ring appears on screen is a visual claim — measured in real Chrome, in
 * day and night, by `e2e/focus-ring.spec.ts`.
 */

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import {
  type ClassListSite,
  describeSite,
  outlinePairingSites,
  scanSources,
  sourceFiles,
  undeclaredFocusSites,
} from "./helpers/class-list-scan";
import {
  classTokens,
  resolveFocusVisibleOutline,
} from "./helpers/tailwind-outline";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// Radix Select's portal plumbing is not what this file is about; the sessions
// page only needs to render far enough to put its filter input in the DOM.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

vi.mock("@/components/night/NightRunSummaryDialog", () => ({
  NightRunSummaryDialog: () => null,
}));

import { DeskCommandPalette } from "@/components/desk/DeskCommandPalette";
import SessionsPage from "@/app/projects/[projectId]/sessions/page";

/* ------------------------------------------------------------------ */
/* The sweep                                                          */
/* ------------------------------------------------------------------ */

/**
 * This rule groups by ELEMENT — every literal reached from one `className`
 * attribute or one `cn(…)` call, conditional branches included — where the
 * paint sweep groups by ADJACENCY.
 *
 * The looser grouping is required, not incidental. "Does this element offer a
 * focus affordance at all" is a question about the whole element: under
 * adjacency, `CheckMark` (ring behind `onToggle &&`) and `UpNextBand` (ring
 * after a `selected` ternary) read as a bare `outline-none` and two correct
 * controls would be accused. The trade-off is the mirror image of the sweep's:
 * a ring only one branch declares satisfies this rule, so it answers "is there
 * an affordance", never "does it paint". The sweep answers the second.
 */
const undeclared = scanSources(undeclaredFocusSites);

/**
 * Elements allowed to clear the outline and declare nothing. Every entry must
 * match a real site, so an exception that stops applying fails rather than
 * quietly widening the rule.
 */
const NO_AFFORDANCE_NEEDED: ReadonlyArray<{
  file: string;
  /** Tokens identifying the element, so an entry survives a line move. */
  identifiedBy: readonly string[];
  why: string;
}> = [
  {
    file: "components/ticket/TicketOverlay.tsx",
    identifiedBy: ["shadow-[var(--shadow-overlay)]"],
    why:
      "The modal panel itself: role=dialog, aria-modal, tabIndex={-1}. It is " +
      "focused programmatically when the overlay opens and is never in the " +
      "Tab order, so there is no keyboard affordance to lose — and a 2px ring " +
      "around a 1200px panel would not be one. Its focusable contents carry " +
      "their own rings, and those are swept by focus-ring-paints.test.tsx.",
  },
];

function isAllowed(site: ClassListSite): boolean {
  return NO_AFFORDANCE_NEEDED.some(
    (entry) =>
      entry.file === site.file &&
      entry.identifiedBy.every((token) => site.classes.includes(token)),
  );
}

describe("every element that clears the outline offers something instead", () => {
  /**
   * Guards the guard: an empty scan would make the assertion below vacuously
   * true, which is exactly how a stale glob hides a regression.
   */
  it("scans a tree that is actually there", () => {
    expect(sourceFiles().length).toBeGreaterThan(100);
    expect(sourceFiles()).toContain("components/piscine/TopBar.tsx");
    expect(sourceFiles()).toContain("components/desk/DeskCommandPalette.tsx");
  });

  it("leaves no element without a focus affordance", () => {
    const offenders = undeclared.filter((site) => !isAllowed(site));

    expect(
      offenders.map(describeSite),
      `these elements remove the outline and declare no focus affordance at ` +
        `all, so a keyboard user sees nothing at all on them. Give them a ring ` +
        `(focus-visible:outline-2 focus-visible:outline-solid ` +
        `focus-visible:outline-offset-2 focus-visible:outline-ring), or add a ` +
        `documented NO_AFFORDANCE_NEEDED entry saying why the element is never ` +
        `keyboard-focused.`,
    ).toEqual([]);
  });

  it.each(NO_AFFORDANCE_NEEDED.map((entry) => [entry.file, entry] as const))(
    "the exception for %s still describes a real element",
    (_file, entry) => {
      const matched = undeclared.filter(
        (site) =>
          site.file === entry.file &&
          entry.identifiedBy.every((token) => site.classes.includes(token)),
      );

      expect(
        matched.length,
        `NO_AFFORDANCE_NEEDED still exempts ${entry.file} ` +
          `(${entry.identifiedBy.join(" ")}) but nothing there clears the ` +
          `outline any more. Drop the entry.`,
      ).toBeGreaterThan(0);
    },
  );
});

/* ------------------------------------------------------------------ */
/* The two reported controls, read off the rendered DOM               */
/* ------------------------------------------------------------------ */

/**
 * Scanning the SOURCE would not do here. Both files hold other controls that
 * declare a perfectly good ring — the palette's own result buttons, the
 * sessions page's chips — so a file-level assertion passes while the input
 * itself carries nothing. These render the component and read the class list
 * off the element the user actually focuses.
 */
async function expectPaintedRing(element: Element, where: string) {
  const resolved = await resolveFocusVisibleOutline(
    classTokens(element.className),
  );

  expect(
    resolved.paints,
    `${where} resolves outline-style: ${resolved.style} under :focus-visible, ` +
      `so no ring is painted. Class list: ${element.className}`,
  ).toBe(true);
  expect(resolved.width, `${where} outline-width`).toBe("2px");
  // Not asserted: the colour. `outline-ring` resolves through `--color-ring`,
  // which lives in `app/globals.css`, and the helper compiles against the bare
  // `@import "tailwindcss"` theme — so `resolved.color` is undefined here for
  // every control in the app, correct ones included. The painted colour is
  // read in real Chrome by `e2e/focus-ring.spec.ts`.
}

describe("the ⌘K command palette input", () => {
  function renderPalette() {
    render(
      <DeskCommandPalette
        open
        payload={null}
        onClose={() => {}}
        onOpenTicket={() => {}}
        onSelectProject={() => {}}
      />,
    );
  }

  it("paints a keyboard focus ring", async () => {
    renderPalette();

    await expectPaintedRing(
      screen.getByTestId("desk-command-input"),
      "the ⌘K search input",
    );
  });

  /**
   * The control, and the reason the assertion above reads the DOM instead of
   * the source. This file already declared a correct ring before the fix — on
   * its result buttons — so "some class list in DeskCommandPalette.tsx pairs
   * outline-none with a painting ring" was true the whole time the input
   * carried none. A file-level check would have passed on the wrong element.
   */
  it("is not the element a file-level check would have found", () => {
    const file = "components/desk/DeskCommandPalette.tsx";
    const rings = outlinePairingSites(readFileSync(file, "utf8"), file);

    expect(
      rings.length,
      `${file} is expected to hold more than one ring-declaring class list; ` +
        `with only one, the file-level shortcut would be sound and this test ` +
        `would be pinning nothing`,
    ).toBeGreaterThan(1);

    renderPalette();
    expect(screen.getByTestId("desk-command-input").tagName).toBe("INPUT");
  });
});

describe("the sessions ticket filter input", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [] }),
      })),
    );
  });

  // Found by its accessible name, not its test id: the id is new with this
  // fix, so querying it would make the test red on the merge-base for the
  // wrong reason ("no such element") instead of the right one ("no ring").
  it("paints a keyboard focus ring", async () => {
    render(<SessionsPage />);

    const input = await waitFor(() =>
      screen.getByLabelText("Filter by ticket"),
    );

    expect(input.tagName).toBe("INPUT");
    await expectPaintedRing(input, "the sessions ticket filter");
  });

  /**
   * The affordance has to survive being found by its accessible name, not just
   * by a test id: the field's label is an `sr-only` span, which is exactly the
   * association a refactor breaks silently.
   */
  it("is the field reachable by its accessible name", async () => {
    render(<SessionsPage />);

    const byLabel = await waitFor(() => screen.getByLabelText("Filter by ticket"));

    expect(byLabel).toBe(screen.getByTestId("sessions-ticket-filter"));
  });
});
