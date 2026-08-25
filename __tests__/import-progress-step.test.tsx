import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ImportProgress } from "@/components/import/ImportProgress";

describe("ImportProgress", () => {
  it("defaults to the analysis copy so the local-folder flow is unchanged", () => {
    render(<ImportProgress />);

    expect(screen.getByText("Analyzing project...")).toBeInTheDocument();
    expect(
      screen.getByText("Claude Code is scanning the codebase and generating epics")
    ).toBeInTheDocument();
  });

  it("names the repository being cloned", () => {
    render(<ImportProgress step="cloning" repo="Orolol/arij" />);

    expect(screen.getByText("Cloning Orolol/arij...")).toBeInTheDocument();
    expect(
      screen.getByText("Fetching the full history from GitHub")
    ).toBeInTheDocument();
  });

  it("falls back to a generic clone heading when the repo is unknown", () => {
    render(<ImportProgress step="cloning" />);

    expect(screen.getByText("Cloning repository...")).toBeInTheDocument();
  });

  it("keeps the spinner treatment on both steps", () => {
    const { container, rerender } = render(<ImportProgress step="cloning" />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();

    rerender(<ImportProgress step="analyzing" />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});
