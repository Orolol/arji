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
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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

/**
 * The bar was not the only place the pairing occurred — it was 41 files.
 *
 * THIS SCAN UNDER-REPORTS, on purpose rather than by accident. It groups
 * ADJACENT string literals, which is the shape of a `cn(…)` argument list and
 * of a `cva` base array, so it sees `outline-none` and a focus ring written on
 * two different lines of the same element. It does NOT see a base class and a
 * conditional variant separated by an expression (`CheckMark.tsx` is that
 * shape), and it cannot see a class list composed across components at all.
 * Every site it does find is a real one; "no sites left" would not prove the
 * codebase is clean. The rendered assertions above are what cover composition.
 */
const SOURCE_ROOTS = ["app", "components", "hooks"];
/** Vendored shadcn: its focus affordance is `ring-*` (a box-shadow), not an outline. */
const VENDORED = path.join("components", "ui");

function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => path.join(root, entry))
      .filter((file) => /\.tsx?$/.test(file) && !file.startsWith(VENDORED)),
  ).sort();
}

/**
 * Adjacent string literals separated only by commas, whitespace or comments are
 * one class list: that is the shape of a `cn(…)` argument list and of a `cva`
 * base array, where `outline-none` and the focus ring routinely sit on
 * different lines of the same element's classes.
 */
const LITERAL = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const JOINABLE = /^(?:\s|,|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*$/;

type Site = { file: string; line: number; classes: string[] };

function classListsPairingOutlineNone(file: string): Site[] {
  const source = readFileSync(file, "utf8");
  const literals = [...source.matchAll(LITERAL)];

  const clusters: (typeof literals)[] = [];
  for (const [index, literal] of literals.entries()) {
    const previous = literals[index - 1];
    const gap =
      previous === undefined
        ? null
        : source.slice(previous.index + previous[0].length, literal.index);
    if (gap !== null && JOINABLE.test(gap)) clusters.at(-1)!.push(literal);
    else clusters.push([literal]);
  }

  const sites: Site[] = [];
  for (const cluster of clusters) {
    const classes = classTokens(cluster.map((m) => m[2]).join(" "));
    if (!classes.includes("outline-none")) continue;
    if (!classes.some((c) => /^focus-visible:outline-\d/.test(c))) continue;
    sites.push({
      file,
      line: source.slice(0, cluster[0].index).split("\n").length,
      classes,
    });
  }
  return sites;
}

const sites = sourceFiles().flatMap(classListsPairingOutlineNone);

describe("every class list that pairs outline-none with an outline focus ring", () => {
  /**
   * Guards the guard: if the scan stops finding sites — a refactor moves the
   * classes into a variable, a glob goes stale — `it.each` over an empty array
   * would report a green run over nothing.
   */
  it("finds the sites to check", () => {
    expect(sites.length).toBeGreaterThanOrEqual(40);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line}`, s] as const))(
    "%s",
    async (_label, site) => {
      const resolved = await resolveFocusVisibleOutline(site.classes);

      expect(
        resolved.paints,
        `outline-none cancels the focus ring here: outline-style resolves to ` +
          `${resolved.style} under :focus-visible. State the style explicitly ` +
          `(focus-visible:outline-solid) or drop outline-none.`,
      ).toBe(true);
    },
  );
});
