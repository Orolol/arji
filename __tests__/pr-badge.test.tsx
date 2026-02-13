import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrBadge } from "@/components/github/PrBadge";

describe("PrBadge", () => {
  it("renders draft status with yellow styling", () => {
    render(<PrBadge status="draft" number={1} />);
    const badge = screen.getByText(/Draft/);
    expect(badge).toBeInTheDocument();
    expect(badge.closest("[class]")?.className).toContain("yellow");
  });

  it("renders open status with green styling", () => {
    render(<PrBadge status="open" number={42} />);
    const badge = screen.getByText(/Open/);
    expect(badge).toBeInTheDocument();
    expect(badge.closest("[class]")?.className).toContain("green");
  });

  it("renders closed status with red styling", () => {
    render(<PrBadge status="closed" number={10} />);
    const badge = screen.getByText(/Closed/);
    expect(badge).toBeInTheDocument();
    expect(badge.closest("[class]")?.className).toContain("red");
  });

  it("renders merged status with purple styling", () => {
    render(<PrBadge status="merged" number={5} />);
    const badge = screen.getByText(/Merged/);
    expect(badge).toBeInTheDocument();
    expect(badge.closest("[class]")?.className).toContain("purple");
  });

  it("displays PR number when provided", () => {
    render(<PrBadge status="open" number={123} />);
    expect(screen.getByText(/#123/)).toBeInTheDocument();
  });

  it("renders without PR number when not provided", () => {
    render(<PrBadge status="open" />);
    expect(screen.getByText(/Open/)).toBeInTheDocument();
    expect(screen.queryByText(/#/)).toBeNull();
  });

  it("renders as a link when url is provided", () => {
    render(<PrBadge status="open" number={42} url="https://github.com/owner/repo/pull/42" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders without link when url is not provided", () => {
    render(<PrBadge status="open" number={42} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
