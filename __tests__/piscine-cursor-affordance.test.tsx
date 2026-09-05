/**
 * Tailwind v4 dropped `cursor: pointer` from the preflight `<button>` reset, so
 * every button in the Piscine redesign shipped with the default arrow. The fix
 * belongs in the PRIMITIVES — `PillButton` alone backs 40-odd call sites, and
 * patching them one by one is what this suite exists to prevent.
 *
 * The disabled case is asserted too: `disabled:pointer-events-none` is what
 * keeps the hand off a dead control, so it has to survive alongside the new
 * `cursor-pointer` rather than be silently displaced by it.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Button } from "@/components/ui/button";
import {
  PillButton,
  QuietDangerAction,
  QuietLink,
  SegmentedControl,
  SelectPill,
  pillButtonVariants,
} from "@/components/piscine";

describe("pointer affordance on the shared primitives", () => {
  it("puts cursor-pointer in the pillButtonVariants BASE recipe, not in a variant", () => {
    // Every combination must carry it — that is what "base recipe" means, and
    // a variant-scoped rule would leave the other combinations bare.
    for (const variant of ["filled", "outline"] as const) {
      for (const size of ["sm", "md", "lg"] as const) {
        expect(pillButtonVariants({ variant, size })).toContain("cursor-pointer");
      }
    }
  });

  it("renders PillButton with the hand and keeps the disabled guard", () => {
    const { rerender } = render(<PillButton>Lancer</PillButton>);
    const button = screen.getByRole("button", { name: "Lancer" });
    expect(button.className).toContain("cursor-pointer");
    expect(button.className).toContain("disabled:pointer-events-none");

    rerender(<PillButton disabled>Lancer</PillButton>);
    // pointer-events:none means the hand can never be painted on a dead button.
    expect(screen.getByRole("button", { name: "Lancer" })).toBeDisabled();
  });

  it("covers the other Piscine controls", () => {
    render(
      <>
        <SegmentedControl
          options={[
            { value: "a", label: "Écrire" },
            { value: "b", label: "Prévisualiser" },
          ]}
          value="a"
          onChange={() => {}}
        />
        <SelectPill label="Claude Code">
          <div />
        </SelectPill>
        <QuietLink onClick={() => {}}>open diff →</QuietLink>
        <QuietDangerAction onClick={() => {}}>Delete agent</QuietDangerAction>
        <Button>Save</Button>
      </>,
    );

    for (const name of [
      "Écrire",
      "Prévisualiser",
      "Claude Code",
      "open diff →",
      "Delete agent",
      "Save",
    ]) {
      expect(screen.getByRole("button", { name }).className).toContain("cursor-pointer");
    }
  });

  it("keeps a disabled segment and a disabled select pill unhoverable", () => {
    render(
      <>
        <SegmentedControl
          options={[
            { value: "a", label: "Actif" },
            { value: "b", label: "Indisponible", disabled: true },
          ]}
          value="a"
          onChange={() => {}}
        />
        <SelectPill label="Aucun agent" disabled>
          <div />
        </SelectPill>
      </>,
    );

    const segment = screen.getByRole("button", { name: "Indisponible" });
    expect(segment).toBeDisabled();
    expect(segment.className).toContain("disabled:pointer-events-none");

    const pill = screen.getByRole("button", { name: "Aucun agent" });
    expect(pill).toBeDisabled();
    expect(pill.className).toContain("disabled:pointer-events-none");
  });
});
