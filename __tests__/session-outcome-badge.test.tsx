/**
 * Delivery-verdict badge shown on the sessions list and session detail pages.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionOutcomeBadge } from "@/components/shared/SessionOutcomeBadge";

describe("SessionOutcomeBadge", () => {
  it.each([
    ["answered", "Answered"],
    ["asked_question", "Asked a question"],
    ["silent", "Silent"],
    ["error", "Error"],
    ["transition_refused", "Transition held"],
  ] as const)("renders the %s verdict as '%s'", (outcome, label) => {
    render(<SessionOutcomeBadge outcome={outcome} />);
    const badge = screen.getByTestId(`session-outcome-${outcome}`);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(label);
  });

  it("renders nothing for unclassified sessions", () => {
    const { container } = render(<SessionOutcomeBadge outcome={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for undefined and unknown values", () => {
    const { container: none } = render(<SessionOutcomeBadge />);
    expect(none).toBeEmptyDOMElement();

    const { container: unknown } = render(
      <SessionOutcomeBadge outcome="mystery" />
    );
    expect(unknown).toBeEmptyDOMElement();
  });
});
