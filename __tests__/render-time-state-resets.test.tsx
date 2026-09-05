/**
 * The two reset-on-prop-change effects that the React Compiler conversion
 * exposed, pinned as BEHAVIOUR rather than as lint output.
 *
 * Both components used to clear their field from a `useEffect` keyed on the
 * prop that changed. That is a `set-state-in-effect` violation, and it was
 * invisible while the files called their hooks as `React.useEffect` — see
 * `react-compiler-namespaced-hooks.test.ts`. Both now adjust during render,
 * which is what React documents for "a prop changed, drop the derived state".
 *
 * That test proves the compiler rules read these files. It cannot prove the
 * rewrite kept the semantics, and the existing suites do not either: the QA
 * suite exercises the dismiss flow but never opens the dialog on a SECOND
 * finding, which is the exact case the reset exists for. Hence this file.
 *
 * WHAT THESE ASSERTIONS DO NOT SHOW. They pass on the OLD effect-based
 * implementation too — measured, by reverting both components on disk and
 * re-running. `rerender` is wrapped in `act`, which flushes passive effects
 * before the assertion, so jsdom cannot see the frame that separates the two
 * forms. The paint-timing argument for adjusting during render (the new
 * finding's first paint is already empty, where an effect clears it one commit
 * later) is a real-browser property and is NOT evidenced here.
 *
 * What they do show is that the reset still happens and is still keyed
 * correctly — the part a rewrite can silently break. Confirmed non-vacuous by
 * mutation: dropping `open` from `DismissDialog`'s reset key fails the reopen
 * case, and deleting the palette's reset fails its case.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DeskCommandPalette } from "@/components/desk/DeskCommandPalette";
import { DismissDialog } from "@/components/qa/DismissDialog";
import type { QaFinding } from "@/lib/qa/types";

function finding(overrides: Partial<QaFinding> = {}): QaFinding {
  return {
    findingId: "f1",
    epicId: "e1",
    projectId: "p1",
    readableId: "ARJ-113",
    ticketTitle: "Named agents",
    text: "Le token MCP est loggé en clair quand la session échoue",
    filePath: "lib/agents/session.ts",
    lineNumber: 214,
    severity: "critical",
    severityLabel: "BLOCKING",
    tier: "blocking",
    blocking: true,
    reviewer: "Security CC",
    reviewerAgentType: "review_security",
    filedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    fixable: true,
    rawBody: "[critical] Le token MCP est loggé en clair quand la session échoue",
    ...overrides,
  };
}

const reasonField = () => screen.getByTestId("qa-dismiss-reason") as HTMLInputElement;

describe("DismissDialog clears the reason when the finding changes", () => {
  const noop = () => {};

  it("does not carry a typed reason onto the next finding", () => {
    const { rerender } = render(
      <DismissDialog
        finding={finding()}
        open
        onOpenChange={noop}
        onConfirm={noop}
      />,
    );

    fireEvent.change(reasonField(), { target: { value: "déjà corrigé ailleurs" } });
    expect(reasonField().value).toBe("déjà corrigé ailleurs");

    rerender(
      <DismissDialog
        finding={finding({ findingId: "f2", text: "Autre finding" })}
        open
        onOpenChange={noop}
        onConfirm={noop}
      />,
    );

    // The second finding gets an empty box, not the previous one's reason.
    expect(reasonField().value).toBe("");
  });

  it("clears the reason when the dialog is reopened on the same finding", () => {
    const same = finding();
    const { rerender } = render(
      <DismissDialog finding={same} open onOpenChange={noop} onConfirm={noop} />,
    );

    fireEvent.change(reasonField(), { target: { value: "une raison" } });
    expect(reasonField().value).toBe("une raison");

    // `open` is part of the reset key, so closing and reopening the SAME
    // finding starts from an empty field too.
    rerender(
      <DismissDialog
        finding={same}
        open={false}
        onOpenChange={noop}
        onConfirm={noop}
      />,
    );
    rerender(
      <DismissDialog finding={same} open onOpenChange={noop} onConfirm={noop} />,
    );

    expect(reasonField().value).toBe("");
  });
});

describe("DeskCommandPalette clears its query when it closes", () => {
  const noop = () => {};

  it("starts empty when a mounted palette is reopened", () => {
    /*
      TopBar unmounts the palette on close, so this path is not reachable from
      today's only call site — the reset is kept for a caller that holds the
      component mounted and drives `open`, which the prop invites. Rendering it
      that way is the only way to exercise the branch at all.
    */
    const { rerender } = render(
      <DeskCommandPalette
        open
        onClose={noop}
        payload={null}
        onOpenTicket={noop}
        onSelectProject={noop}
      />,
    );

    fireEvent.change(screen.getByTestId("desk-command-input"), {
      target: { value: "inline review" },
    });
    expect((screen.getByTestId("desk-command-input") as HTMLInputElement).value).toBe(
      "inline review",
    );

    rerender(
      <DeskCommandPalette
        open={false}
        onClose={noop}
        payload={null}
        onOpenTicket={noop}
        onSelectProject={noop}
      />,
    );
    // Closed renders nothing at all, which is why the reset cannot live in the
    // markup and has to survive the round trip in state.
    expect(screen.queryByTestId("desk-command-palette")).toBeNull();

    rerender(
      <DeskCommandPalette
        open
        onClose={noop}
        payload={null}
        onOpenTicket={noop}
        onSelectProject={noop}
      />,
    );

    expect((screen.getByTestId("desk-command-input") as HTMLInputElement).value).toBe("");
  });
});
