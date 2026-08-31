import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

/**
 * "/" is the control desk now, not the project grid: `app/page.tsx` mounts the
 * ticket-overlay provider and the desk, and nothing else. The provider matters
 * — without it a ticket click on the desk would silently no-op.
 */
vi.mock("@/components/desk/NowDesk", () => ({
  NowDesk: () => <div data-testid="now-desk">Control desk</div>,
}));

describe("Home page", () => {
  it("renders the control desk", () => {
    render(<Home />);
    expect(screen.getByTestId("now-desk")).toBeInTheDocument();
  });
});
