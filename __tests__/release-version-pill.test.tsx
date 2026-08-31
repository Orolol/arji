import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VersionPill } from "@/components/releases/VersionPill";

/**
 * The version pill's free-text field is now the `GhostInputPill` primitive
 * rather than a hand-transcribed copy of its class recipe. That swap moves the
 * keyboard contract: `GhostInputPill` spreads `{...props}` AFTER its own
 * `onKeyDown`, so the caller that needs `stopPropagation` (Radix's menu
 * typeahead would otherwise eat every keystroke) necessarily owns Enter too.
 *
 * These tests pin the behaviour that swap could silently drop.
 */

const BUMPS = { patch: "0.4.3", minor: "0.5.0", major: "1.0.0" };

describe("VersionPill", () => {
  it("renders the read-only pill without a trigger", () => {
    render(
      <VersionPill version="0.4.2" bumps={BUMPS} onSelect={vi.fn()} readOnly />,
    );

    expect(screen.getByTestId("release-version-pill")).toHaveTextContent(
      "v0.4.2",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("commits a typed version on Enter, stripping a leading v", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<VersionPill version="0.4.2" bumps={BUMPS} onSelect={onSelect} />);

    await user.click(screen.getByRole("button"));
    const input = await screen.findByTestId("release-version-input");

    // The server names the tag `v${version}`, so a stored leading v would
    // produce "vv1.2.3" everywhere downstream.
    await user.type(input, "v1.2.3{Enter}");

    expect(onSelect).toHaveBeenCalledWith("1.2.3");
  });

  it("ignores Enter on an empty field rather than committing nothing", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<VersionPill version="0.4.2" bumps={BUMPS} onSelect={onSelect} />);

    await user.click(screen.getByRole("button"));
    const input = await screen.findByTestId("release-version-input");
    await user.type(input, "{Enter}");

    expect(onSelect).not.toHaveBeenCalled();
  });

  /*
   * NOT a guard on the `stopPropagation` call: deleting that line leaves this
   * test green, because jsdom + Radix do not reproduce the menu typeahead
   * stealing focus. It pins the plain "the field is a working text field"
   * contract, which the primitive swap could have broken outright.
   */
  it("keeps the typed value and the focus in the field", async () => {
    const user = userEvent.setup();
    render(<VersionPill version="0.4.2" bumps={BUMPS} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button"));
    const input = await screen.findByTestId("release-version-input");
    await user.type(input, "2.0.0");

    expect(input).toHaveValue("2.0.0");
    expect(input).toHaveFocus();
  });

  it("offers the computed bumps and selects one", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<VersionPill version="0.4.2" bumps={BUMPS} onSelect={onSelect} />);

    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByText("minor · 0.5.0"));

    expect(onSelect).toHaveBeenCalledWith("0.5.0");
  });

  it("drops the bump list entirely when there is no previous release", async () => {
    const user = userEvent.setup();
    render(<VersionPill version="0.1.0" bumps={null} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button"));
    await screen.findByTestId("release-version-input");

    expect(screen.queryByText(/^patch · /)).not.toBeInTheDocument();
  });
});
