/**
 * Session detail "Arij actions" list — compact rendering of the structured
 * board effects an agent session had (status changes, comments, questions,
 * findings, raw tool calls).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ArijActionsList,
  type ArijActionItem,
} from "@/components/shared/ArijActionsList";

const actions: ArijActionItem[] = [
  {
    kind: "tool_call",
    summary: "Read ticket state (get_ticket)",
    at: "2026-08-17T10:00:00.000Z",
  },
  {
    kind: "status_change",
    summary: "Ticket moved in_progress → review",
    detail: "Agent MCP: update_ticket_status",
    at: "2026-08-17T10:02:00.000Z",
  },
  {
    kind: "comment",
    summary: "Posted a comment",
    detail: "Implemented the schema change.",
    at: "2026-08-17T10:03:00.000Z",
  },
  {
    kind: "question",
    summary: "Asked the user a question",
    detail: "Should I migrate the legacy rows too?",
    at: null,
  },
  {
    kind: "findings",
    summary: "Submitted review findings (changes requested)",
    at: "2026-08-17T10:04:00.000Z",
  },
  {
    kind: "artifact",
    summary: "Attached visual proof",
    detail: "Checkout confirmation after payment",
    at: "2026-08-17T10:05:00.000Z",
  },
];

describe("ArijActionsList", () => {
  it("renders one entry per action with summary and detail", () => {
    render(<ArijActionsList actions={actions} />);

    expect(screen.getByTestId("arij-actions")).toBeInTheDocument();
    expect(screen.getByText("Arij actions")).toBeInTheDocument();

    expect(screen.getByTestId("arij-action-tool_call")).toHaveTextContent(
      "Read ticket state (get_ticket)"
    );
    expect(screen.getByTestId("arij-action-status_change")).toHaveTextContent(
      "Ticket moved in_progress → review"
    );
    expect(screen.getByTestId("arij-action-comment")).toHaveTextContent(
      "Implemented the schema change."
    );
    expect(screen.getByTestId("arij-action-question")).toHaveTextContent(
      "Should I migrate the legacy rows too?"
    );
    expect(screen.getByTestId("arij-action-findings")).toHaveTextContent(
      "Submitted review findings (changes requested)"
    );
    expect(screen.getByTestId("arij-action-artifact")).toHaveTextContent(
      "Checkout confirmation after payment"
    );
  });

  it("renders nothing when the session had no Arij actions", () => {
    const { container: empty } = render(<ArijActionsList actions={[]} />);
    expect(empty).toBeEmptyDOMElement();

    const { container: absent } = render(<ArijActionsList actions={null} />);
    expect(absent).toBeEmptyDOMElement();

    const { container: undef } = render(<ArijActionsList />);
    expect(undef).toBeEmptyDOMElement();
  });
});
