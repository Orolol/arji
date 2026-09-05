import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";

/**
 * The New Bug dialog is the main bug-entry surface: its fields must be
 * reachable by their visible label, not only by placeholder. Query through the
 * accessible name on purpose — a test id would pass while the label
 * association stayed broken.
 */
describe("New Bug dialog accessibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function renderDialog() {
    render(
      <BugCreateDialog
        projectId="proj-1"
        open={true}
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    );
  }

  it("names the text fields through their visible labels", () => {
    renderDialog();

    expect(screen.getByLabelText("Title *")).toBe(
      screen.getByPlaceholderText("Bug title...")
    );
    expect(screen.getByLabelText("Description")).toBe(
      screen.getByPlaceholderText(
        "Steps to reproduce, expected vs actual behavior..."
      )
    );
  });

  it("names the priority select through its visible label", () => {
    renderDialog();

    expect(screen.getByLabelText("Priority")).toBe(
      screen.getByRole("combobox")
    );
  });

  it("drives the title field through its label", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Create Bug" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title *"), {
      target: { value: "App crashes on save" },
    });
    expect(screen.getByRole("button", { name: "Create Bug" })).toBeEnabled();
  });

  it("names the screenshots group and exposes its hint as a description", () => {
    renderDialog();

    const group = screen.getByRole("group", { name: "Screenshots" });
    expect(group).toHaveAccessibleDescription(
      "Paste a screenshot with Ctrl/Cmd+V, drop an image here, or attach one."
    );
  });
});
