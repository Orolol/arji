import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "../page";

vi.mock("@/components/dashboard/ProjectGrid", () => ({
  ProjectGrid: () => <div data-testid="project-grid">Projects Grid</div>,
}));

describe("Home page", () => {
  it("renders project grid shell", () => {
    render(<Home />);
    expect(screen.getByTestId("project-grid")).toBeInTheDocument();
    expect(screen.getByText("Projects Grid")).toBeInTheDocument();
  });
});
