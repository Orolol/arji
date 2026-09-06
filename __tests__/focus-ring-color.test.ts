/**
 * The focus-ring unit sweep could never see the ring's colour.
 *
 * THE GAP. `__tests__/helpers/tailwind-outline.ts` compiled the class list
 * under test from a bare `@import "tailwindcss"`. `focus-visible:outline-ring`
 * takes its colour from `--color-ring`, and that token is the app's, not the
 * framework's: `app/globals.css` declares it (`@theme inline { --color-ring:
 * var(--ring) }`) and gives `--ring` one value under `:root` (day) and another
 * under `.dark` (night). Against the bare theme the utility emitted nothing at
 * all, and `resolved.color` read `undefined` for every control in the app —
 * the correct ones included. Measured on the unfixed helper, adding
 * `expect(resolved.color).toBeDefined()` to the two inputs pinned by
 * `focus-ring-undeclared.test.tsx`:
 *
 *     × the ⌘K search input outline-color: expected undefined to be defined
 *     × the sessions ticket filter outline-color: expected undefined to be defined
 *
 * WHY IT MATTERED. `focus-ring-paints.test.tsx` sweeps 50 sites and asserts
 * `outline-style` and `outline-width`. A ring needs a third thing to be seen:
 * a colour that is not transparent. A control given
 * `focus-visible:outline-transparent`, or a `--ring` blanked in one theme,
 * kept `outline-style: solid` and `outline-width: 2px` and passed all 50
 * assertions while painting nothing — the focus-ring epic's own defect, one
 * property over.
 *
 * WHAT THIS FILE PINS. The helper now compiles the app's real stylesheet, so
 * the colour is declared, and resolves every `var(--…)` in it once per theme.
 * This file pins that mechanism on hand-written class lists and hand-written
 * sheets; the per-site colour assertions live with the sweeps
 * (`focus-ring-paints.test.tsx`, `focus-ring-undeclared.test.tsx`,
 * `chat-thread-pane-focus-ring.test.tsx`, `story-detail-panel-labels.test.tsx`).
 *
 * WHAT IT DOES NOT PROVE. A colour that resolves to an opaque literal is not
 * yet a colour that contrasts with the ground the control sits on. That is a
 * claim about a rendered page in a real browser, and `e2e/focus-ring-inputs.spec.ts`
 * is where it is made, in both themes.
 */

import { describe, expect, it } from "vitest";

import {
  THEMES,
  colorPaints,
  resolveFocusVisibleOutline,
  substituteVars,
  themeVariables,
} from "./helpers/tailwind-outline";

/** The ring every Piscine control declares. */
const RING = [
  "outline-none",
  "focus-visible:outline-2",
  "focus-visible:outline-solid",
  "focus-visible:outline-offset-2",
  "focus-visible:outline-ring",
];

describe("the ring colour resolves through app/globals.css", () => {
  /**
   * The observation the ticket was filed on, kept in the shape it was made:
   * the helper compiled against the bare theme, `outline-ring` emitted
   * nothing, and this read `undefined` for a correct control.
   */
  it("is declared for focus-visible:outline-ring", async () => {
    const resolved = await resolveFocusVisibleOutline(RING);

    expect(
      resolved.color,
      "outline-color declared by focus-visible:outline-ring",
    ).toBeDefined();
  });

  it("resolves to a literal that paints, in each theme", async () => {
    const resolved = await resolveFocusVisibleOutline(RING);

    for (const theme of THEMES) {
      const color = resolved.colorIn[theme];
      expect(color, `outline-color in ${theme}`).toBeDefined();
      // Fully resolved: a `var(--…)` left standing would mean the token is
      // undefined in that theme, which is exactly a ring nobody can see.
      expect(color, `outline-color in ${theme}`).not.toMatch(/var\(/);
      expect(colorPaints(color), `${color} paints in ${theme}`).toBe(true);
    }
  });

  /**
   * `--ring` is one value under `:root` and another under `.dark`. This is a
   * control on the modelling — the two readings come from two variable sets,
   * not from one set read twice — and not a palette pin: if the palette ever
   * gave both themes the same ring, the palette would be right and this test
   * would need the edit.
   */
  it("reads the two themes from two different variable sets", async () => {
    const resolved = await resolveFocusVisibleOutline(RING);

    expect(resolved.colorIn.night).not.toBe(resolved.colorIn.day);
  });

  /**
   * `app/globals.css` gives every element `outline-ring/50` in `@layer base`,
   * so a ring with no colour utility of its own is not colourless — it is the
   * base layer's half-strength ring. Reporting `undefined` for it would accuse
   * a control that Chrome does paint; resolving it says what is really drawn.
   */
  it("falls back to the base layer's ring when no utility names a colour", async () => {
    const resolved = await resolveFocusVisibleOutline([
      "outline-none",
      "focus-visible:outline-2",
      "focus-visible:outline-solid",
    ]);

    expect(resolved.color, "no utility declares outline-color").toBeUndefined();
    for (const theme of THEMES) {
      expect(resolved.colorIn[theme], `base-layer ring in ${theme}`).toBeDefined();
      expect(resolved.colorIn[theme]).not.toMatch(/var\(/);
      expect(colorPaints(resolved.colorIn[theme])).toBe(true);
    }
  });
});

describe("what the colour assertion catches", () => {
  /**
   * Both shapes keep `outline-style: solid` and `outline-width: 2px`, so the
   * sweep's original assertions pass on them. Only the colour tells.
   */
  it("a ring declared transparent", async () => {
    const resolved = await resolveFocusVisibleOutline([
      ...RING,
      "focus-visible:outline-transparent",
    ]);

    expect(resolved.paints).toBe(true);
    expect(resolved.width).toBe("2px");
    for (const theme of THEMES) {
      expect(resolved.colorIn[theme], `outline-color in ${theme}`).toBe(
        "transparent",
      );
      expect(colorPaints(resolved.colorIn[theme])).toBe(false);
    }
  });

  /**
   * `outline-ring/0` compiles to `outline-color: var(--ring)` with a nested
   * `@supports (color: color-mix(…))` override to a 0% mix. Every browser the
   * e2e specs measure takes the override, so the resolver does too — reading
   * only the fallback would call this ring opaque.
   */
  it("a ring whose colour is mixed down to nothing", async () => {
    const resolved = await resolveFocusVisibleOutline([
      ...RING,
      "focus-visible:outline-ring/0",
    ]);

    expect(resolved.paints).toBe(true);
    for (const theme of THEMES) {
      expect(resolved.colorIn[theme], `outline-color in ${theme}`).toMatch(
        /^color-mix\(/,
      );
      expect(colorPaints(resolved.colorIn[theme])).toBe(false);
    }
  });

  /** The control: a mix that keeps some of the ring still paints. */
  it("but not a ring merely mixed down", async () => {
    const resolved = await resolveFocusVisibleOutline([
      ...RING,
      "focus-visible:outline-ring/50",
    ]);

    for (const theme of THEMES) {
      expect(resolved.colorIn[theme]).toMatch(/^color-mix\(/);
      expect(colorPaints(resolved.colorIn[theme])).toBe(true);
    }
  });
});

describe("per-theme variable resolution", () => {
  /**
   * A hand-written sheet in the shape the compiler emits: Tailwind's own
   * theme variables in `@layer theme`, the app's day tokens under `:root`,
   * the night overrides under `.dark`, and an alias that resolves per theme.
   */
  const SHEET = `
    @layer theme, base, utilities;
    @layer theme {
      :root, :host {
        --color-red-500: oklch(63.7% 0.237 25.331);
      }
    }
    :root {
      --ring: #24907a;
      --alias: var(--ring);
      --border: #e0d8c2;
    }
    .dark {
      --ring: transparent;
    }
    @media (prefers-reduced-motion: reduce) {
      .piscine-band { transition: none; }
    }
  `;

  it("overlays .dark on :root for night and leaves day alone", () => {
    const vars = themeVariables(SHEET);

    expect(vars.day.get("--ring")).toBe("#24907a");
    expect(vars.night.get("--ring")).toBe("transparent");
    // Not overridden: night inherits it from :root.
    expect(vars.night.get("--border")).toBe("#e0d8c2");
    // Tailwind's own theme layer is part of the day set.
    expect(vars.day.get("--color-red-500")).toBe("oklch(63.7% 0.237 25.331)");
  });

  it("follows an alias to the theme that is on", () => {
    const vars = themeVariables(SHEET);

    expect(substituteVars("var(--alias)", vars.day)).toBe("#24907a");
    expect(substituteVars("var(--alias)", vars.night)).toBe("transparent");
  });

  /**
   * The failure the sweep exists to catch, in miniature: a token blanked in
   * one theme only. Day is fine; night paints nothing.
   */
  it("exposes a token blanked in one theme only", () => {
    const vars = themeVariables(SHEET);

    expect(colorPaints(substituteVars("var(--ring)", vars.day))).toBe(true);
    expect(colorPaints(substituteVars("var(--ring)", vars.night))).toBe(false);
  });

  it("takes the fallback of a var() the theme does not define", () => {
    const vars = themeVariables(SHEET);

    expect(substituteVars("var(--missing, red)", vars.day)).toBe("red");
    expect(substituteVars("var(--missing, var(--ring))", vars.day)).toBe(
      "#24907a",
    );
    // Commas inside the fallback belong to the fallback.
    expect(substituteVars("var(--missing, rgb(1, 2, 3))", vars.day)).toBe(
      "rgb(1, 2, 3)",
    );
  });

  it("leaves a var() nothing defines standing, so it reads as not painting", () => {
    const vars = themeVariables(SHEET);
    const unresolved = substituteVars(
      "color-mix(in oklab, var(--missing) 50%, transparent)",
      vars.day,
    );

    expect(unresolved).toContain("var(--missing)");
    expect(colorPaints(unresolved)).toBe(false);
  });

  it("substitutes inside a longer value", () => {
    const vars = themeVariables(SHEET);

    expect(
      substituteVars(
        "color-mix(in oklab, var(--alias) 50%, var(--border))",
        vars.day,
      ),
    ).toBe("color-mix(in oklab, #24907a 50%, #e0d8c2)");
  });

  it("survives a self-referencing token", () => {
    const vars = new Map([["--loop", "var(--loop)"]]);

    expect(substituteVars("var(--loop)", vars)).toBe("var(--loop)");
  });
});

describe("colorPaints", () => {
  it.each([
    "transparent",
    "TRANSPARENT",
    "rgba(0, 0, 0, 0)",
    "rgb(0 0 0 / 0)",
    "rgb(0 0 0 / 0%)",
    "hsla(120, 50%, 50%, 0.0)",
    "oklch(0.7 0.1 180 / 0)",
    "#0000",
    "#24907a00",
    "color-mix(in oklab, #24907a 0%, transparent)",
    "color-mix(in oklab, transparent, transparent)",
    "var(--ring)",
    "",
    undefined,
  ])("rejects %s", (color) => {
    expect(colorPaints(color)).toBe(false);
  });

  it.each([
    "#24907a",
    "#6fcbb4",
    "#fff8",
    "rgb(36, 144, 122)",
    "rgba(36, 144, 122, 0.5)",
    "rgb(36 144 122 / 40%)",
    "hsl(170 60% 35%)",
    "oklch(0.7 0.1 180)",
    "currentcolor",
    "red",
    "color-mix(in oklab, #24907a 50%, transparent)",
    "color-mix(in oklab, transparent, #24907a 40%)",
    "color-mix(in oklab, rgb(1, 2, 3) 40%, transparent)",
  ])("accepts %s", (color) => {
    expect(colorPaints(color)).toBe(true);
  });
});
