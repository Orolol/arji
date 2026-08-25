import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GitHubUrlSelector } from "@/components/import/GitHubUrlSelector";

function renderSelector() {
  const onImport = vi.fn();
  render(<GitHubUrlSelector onImport={onImport} />);
  const input = screen.getByLabelText("GitHub repository URL");
  const button = screen.getByRole("button", { name: "Import" });
  return { onImport, input, button };
}

describe("GitHubUrlSelector", () => {
  it("starts with the Import button disabled, like FolderSelector", () => {
    const { button } = renderSelector();
    expect(button).toBeDisabled();
  });

  it("keeps the button disabled while the value does not parse, with inline feedback", () => {
    const { input, button } = renderSelector();

    fireEvent.change(input, { target: { value: "https://gitlab.com/owner/repo" } });

    expect(button).toBeDisabled();
    expect(screen.getByText(/Not a GitHub repository/i)).toBeInTheDocument();
  });

  it("shows no error for an empty field", () => {
    const { input } = renderSelector();

    fireEvent.change(input, { target: { value: "owner/repo" } });
    fireEvent.change(input, { target: { value: "   " } });

    expect(screen.queryByText(/Not a GitHub repository/i)).not.toBeInTheDocument();
  });

  it.each([
    ["https://github.com/Orolol/arij", "Orolol/arij"],
    ["https://github.com/Orolol/arij.git", "Orolol/arij"],
    ["https://github.com/Orolol/arij/tree/main", "Orolol/arij"],
    ["git@github.com:Orolol/arij.git", "Orolol/arij"],
    ["github.com/Orolol/arij", "Orolol/arij"],
    ["Orolol/arij", "Orolol/arij"],
  ])("enables the button and reports %s as %s", (input, ownerRepo) => {
    const { input: field, button } = renderSelector();

    fireEvent.change(field, { target: { value: input } });

    expect(button).toBeEnabled();
    expect(screen.getByText(`Will clone ${ownerRepo}`)).toBeInTheDocument();
  });

  it("hands the raw value and the parsed owner/repo to the parent", () => {
    const { onImport, input, button } = renderSelector();

    fireEvent.change(input, {
      target: { value: "  https://github.com/Orolol/arij/pull/12  " },
    });
    fireEvent.click(button);

    expect(onImport).toHaveBeenCalledWith({
      url: "https://github.com/Orolol/arij/pull/12",
      ownerRepo: "Orolol/arij",
    });
  });

  it("submits on Enter once the value parses", () => {
    const { onImport, input } = renderSelector();

    fireEvent.change(input, { target: { value: "not a repo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Orolol/arij" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});
