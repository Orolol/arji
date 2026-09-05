/**
 * A Piscine primitive that declares its props explicitly and spreads no
 * `...rest` swallows every attribute the caller did not anticipate —
 * `data-testid` first among them. `Mono` and `StrataBand` lose it silently;
 * `QuietDangerAction` at least fails to compile, which turns the hole into
 * friction: the id is written, TypeScript refuses it, and the test falls back
 * to a role+name query.
 *
 * `QuietLink` settled the shape next door: an explicit `testId` prop placed on
 * the INTERACTIVE ELEMENT. It cannot live on a wrapper — a test has to be able
 * to click the thing it looked up. These tests pin that placement for both.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Trash2 } from "lucide-react";

import { QuietDangerAction, QuietLink } from "@/components/piscine";

describe("QuietDangerAction testId", () => {
  it("puts the id on the button itself, so the test can click what it found", () => {
    const onClick = vi.fn();
    render(
      <QuietDangerAction icon={Trash2} onClick={onClick} testId="delete-ticket">
        Supprimer
      </QuietDangerAction>,
    );

    const found = screen.getByTestId("delete-ticket");
    // Not a wrapper: the queried node is the control that fires the action.
    expect(found.tagName).toBe("BUTTON");
    expect(found).toHaveAttribute("data-slot", "quiet-danger-action");
    expect(found).toBe(screen.getByRole("button", { name: "Supprimer" }));

    fireEvent.click(found);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the id additive — the rest of the contract is untouched", () => {
    render(
      <QuietDangerAction
        onClick={() => {}}
        size={11.5}
        className="ml-auto"
        testId="discard"
      >
        jeter
      </QuietDangerAction>,
    );

    const found = screen.getByTestId("discard");
    expect(found.className).toContain("text-[11.5px]");
    expect(found.className).toContain("ml-auto");
    expect(found.className).toContain("text-destructive");
  });

  it("writes no attribute at all when no testId is passed", () => {
    render(<QuietDangerAction onClick={() => {}}>Supprimer</QuietDangerAction>);

    // `data-testid="undefined"` would be worse than nothing: it matches a
    // stray query and reads as a real id in the DOM.
    expect(screen.getByRole("button", { name: "Supprimer" })).not.toHaveAttribute(
      "data-testid",
    );
  });
});

describe("QuietLink testId — the in-file precedent", () => {
  it("lands on the anchor when the link has an href", () => {
    render(
      <QuietLink href="/projects/x" testId="open-diff">
        open diff →
      </QuietLink>,
    );

    const found = screen.getByTestId("open-diff");
    expect(found.tagName).toBe("A");
    expect(found).toHaveAttribute("href", "/projects/x");
  });

  it("lands on the button when the link is a bare onClick", () => {
    const onClick = vi.fn();
    render(
      <QuietLink onClick={onClick} testId="regenerate">
        régénérer
      </QuietLink>,
    );

    const found = screen.getByTestId("regenerate");
    expect(found.tagName).toBe("BUTTON");
    fireEvent.click(found);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
