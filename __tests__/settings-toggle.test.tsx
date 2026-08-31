/**
 * SettingToggle — the on/off pill frame 11c draws and the frozen Piscine set
 * does not provide.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SettingToggle } from "@/components/settings-piscine";

function knob(): HTMLElement {
  const found = document.querySelector('[data-slot="setting-toggle-knob"]');
  if (!found) throw new Error("no knob rendered");
  return found as HTMLElement;
}

describe("SettingToggle", () => {
  it("is a switch, not a checkbox", () => {
    render(<SettingToggle on={false} onChange={() => {}} label="Full Auto" />);
    const toggle = screen.getByRole("switch", { name: "Full Auto" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("type", "button");
  });

  it("reports its state through aria-checked", () => {
    const { rerender } = render(
      <SettingToggle on={false} onChange={() => {}} label="Dream" />
    );
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    rerender(<SettingToggle on onChange={() => {}} label="Dream" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("asks for the opposite of what it currently is", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SettingToggle on={false} onChange={onChange} label="Dream" />
    );

    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<SettingToggle on onChange={onChange} label="Dream" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(<SettingToggle on={false} onChange={onChange} label="Dream" disabled />);

    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("puts the knob right when on and left when off", () => {
    const { rerender } = render(
      <SettingToggle on={false} onChange={() => {}} label="Dream" />
    );
    expect(knob().className).toContain("left-[2.5px]");
    expect(knob().className).not.toContain("right-[2.5px]");

    rerender(<SettingToggle on onChange={() => {}} label="Dream" />);
    expect(knob().className).toContain("right-[2.5px]");
  });

  it("paints ON with the one loud accent and OFF with a neutral, never a colour", () => {
    const { rerender } = render(
      <SettingToggle on onChange={() => {}} label="Dream" />
    );
    expect(screen.getByRole("switch").className).toContain("bg-strata-live-fill");

    rerender(<SettingToggle on={false} onChange={() => {}} label="Dream" />);
    expect(screen.getByRole("switch").className).toContain("bg-border-strong");
  });

  it("sizes the band-header master larger than a row toggle", () => {
    const { rerender } = render(
      <SettingToggle on onChange={() => {}} label="Full Auto" size="lg" />
    );
    expect(screen.getByRole("switch").className).toContain("h-[20px]");

    rerender(<SettingToggle on onChange={() => {}} label="Full Auto" size="md" />);
    expect(screen.getByRole("switch").className).toContain("h-[18px]");
  });

  it("neutralises its transitions under prefers-reduced-motion", () => {
    render(<SettingToggle on onChange={() => {}} label="Dream" />);
    expect(screen.getByRole("switch").className).toContain(
      "motion-reduce:transition-none"
    );
    expect(knob().className).toContain("motion-reduce:transition-none");
  });
});
