/**
 * The coral stratum: the three things that are blocked on a human.
 *
 * Replaces the deleted `epic-card-failure` / `kanban-unread-ai-indicator` /
 * inbox-side coverage: the failure line and its meta, the awaiting-reply quote,
 * the merge-conflict affordance rule, and the invariant that an empty stratum
 * folds to its label line instead of showing an "all clear" placeholder.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatRelative } from "@/lib/i18n/format";
import { YourTurnBand } from "@/components/desk/YourTurnBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type {
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
} from "@/lib/control-desk/types";

const projects = deriveProjects([{ id: "p1", name: "Arij", createdAt: "2026-01-01" }]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

function asks(overrides: Partial<DeskAwaitingReply> = {}): DeskAwaitingReply {
  return {
    epicId: "e1",
    projectId: "p1",
    readableId: "PXB-24",
    title: "Legacy renderer",
    question: "Je garde le renderer legacy derrière un flag, ou je le supprime ?",
    author: "agent",
    askedAt: "2026-08-28T09:00:00",
    unreadAi: true,
    ...overrides,
  };
}

function failure(overrides: Partial<DeskFailure> = {}): DeskFailure {
  return {
    epicId: "e2",
    projectId: "p1",
    readableId: "NMB-09",
    title: "Worker pool",
    sessionId: "s9",
    error: "exit 1 — worker pool did not drain in 120s",
    agentType: "build",
    agentName: "Opus Builder",
    provider: "claude-code",
    namedAgentId: "a1",
    userStoryId: null,
    producedOutput: true,
    failedAt: new Date(Date.now() - 21 * 60_000).toISOString(),
    ...overrides,
  };
}

function conflict(overrides: Partial<DeskConflict> = {}): DeskConflict {
  return {
    epicId: "e3",
    projectId: "p1",
    readableId: "LDG-71",
    title: "Tax export",
    blocker: "merge_conflict",
    branchName: "epic/ldg-71",
    at: "2026-08-28T09:00:00",
    ...overrides,
  };
}

function renderBand(props: Partial<React.ComponentProps<typeof YourTurnBand>> = {}) {
  const handlers = {
    onReply: vi.fn(),
    onSendToDev: vi.fn(),
    onRetry: vi.fn(),
    onOpenLog: vi.fn(),
    onResolveConflict: vi.fn(),
    onOpenDiff: vi.fn(),
  };
  render(
    <YourTurnBand
      awaitingReply={[]}
      failed={[]}
      conflicts={[]}
      projectsById={projectsById}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("empty stratum", () => {
  it("collapses to its label line — no rows, no counter, no hint", () => {
    renderBand();
    expect(screen.getByText("Your turn")).toBeInTheDocument();
    expect(screen.queryByTestId("desk-your-turn-rows")).not.toBeInTheDocument();
    expect(screen.queryByText(/browse/)).not.toBeInTheDocument();
  });

  it("shows the counter and the keyboard hint as soon as something blocks", () => {
    renderBand({ awaitingReply: [asks()], failed: [failure()] });
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("↹ browse · ⏎ reply")).toBeInTheDocument();
  });
});

describe("ASKS YOU", () => {
  it("quotes the agent's question with French quotation marks", () => {
    renderBand({ awaitingReply: [asks()] });
    expect(
      screen.getByText(
        "« Je garde le renderer legacy derrière un flag, ou je le supprime ? »",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to the ticket title when no comment was captured", () => {
    renderBand({ awaitingReply: [asks({ question: null })] });
    expect(screen.getByText("Legacy renderer")).toBeInTheDocument();
  });

  it("keeps Send disabled until something is typed, then posts the reply", async () => {
    const { onReply } = renderBand({ awaitingReply: [asks()] });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Reply to the agent…"), {
      target: { value: "Supprime-le" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
    expect(onReply.mock.calls[0][1]).toBe("Supprime-le");
  });

  it("submits on Enter from the reply field", async () => {
    const { onReply } = renderBand({ awaitingReply: [asks()] });
    const field = screen.getByPlaceholderText("Reply to the agent…");
    fireEvent.change(field, { target: { value: "Garde-le" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  });

  it("ignores Enter while an IME candidate window is open", () => {
    const { onReply } = renderBand({ awaitingReply: [asks()] });
    const field = screen.getByPlaceholderText("Reply to the agent…");
    fireEvent.change(field, { target: { value: "こんにちは" } });
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onReply).not.toHaveBeenCalled();
  });

  it("routes the typed answer to a builder through Send to dev", () => {
    const { onSendToDev } = renderBand({ awaitingReply: [asks()] });
    fireEvent.change(screen.getByPlaceholderText("Reply to the agent…"), {
      target: { value: "Fais-le" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to dev" }));
    expect(onSendToDev).toHaveBeenCalledTimes(1);
    expect(onSendToDev.mock.calls[0][1]).toBe("Fais-le");
  });

  it("is tab-walkable and ⏎ on the row focuses its reply field", () => {
    renderBand({ awaitingReply: [asks()] });
    const row = screen.getByTestId("desk-asks-you-row");
    expect(row).toHaveAttribute("tabIndex", "0");

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Reply to the agent…"),
    );
  });
});

describe("FAILED", () => {
  it("prints the error and the age · agent meta", () => {
    renderBand({ failed: [failure()] });
    expect(
      screen.getByText("exit 1 — worker pool did not drain in 120s"),
    ).toBeInTheDocument();
    expect(screen.getByText("21m ago · Opus Builder")).toBeInTheDocument();
  });

  it("retries from the button and from ⏎ on the row", () => {
    const { onRetry } = renderBand({ failed: [failure()] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByTestId("desk-failed-row"), { key: "Enter" });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("swaps the WORD while a retry is in flight — it never recolours", () => {
    renderBand({ failed: [failure()], pendingIds: new Set(["e2"]) });
    expect(screen.getByRole("button", { name: "Retrying" })).toBeDisabled();
  });

  it("opens the session log", () => {
    const { onOpenLog } = renderBand({ failed: [failure()] });
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    expect(onOpenLog).toHaveBeenCalledTimes(1);
  });

  it("formats the age in the frame's units", () => {
    // The failure row's stamp is the shared `formatRelative`, counted in
    // seconds while fresh; the row prints an em dash for an unreadable one.
    const now = new Date("2026-08-28T12:00:00.000Z");
    const age = (at: string | null) =>
      formatRelative(at, { locale: "en", now, precision: "second" });
    expect(age("2026-08-28T11:59:30.000Z")).toBe("30s ago");
    expect(age("2026-08-28T11:39:00.000Z")).toBe("21m ago");
    expect(age("2026-08-28T09:00:00.000Z")).toBe("3h ago");
    // SQLite CURRENT_TIMESTAMP has no zone marker and is UTC.
    expect(age("2026-08-28 11:39:00")).toBe("21m ago");
    expect(age(null)).toBe("");
  });
});

describe("CONFLICT", () => {
  it("names the branch that cannot land, in mono", () => {
    renderBand({ conflicts: [conflict()] });
    expect(screen.getByText("epic/ldg-71")).toBeInTheDocument();
    expect(screen.getByTestId("desk-conflict-row")).toHaveTextContent(
      "Conflict with main",
    );
  });

  it("offers the resolution agent for a real merge conflict", () => {
    const { onResolveConflict } = renderBand({ conflicts: [conflict()] });
    fireEvent.click(screen.getByRole("button", { name: "Resolve with agent" }));
    expect(onResolveConflict).toHaveBeenCalledTimes(1);
  });

  it("withholds the agent for committed conflict markers", () => {
    // An agent merging main would find a clean merge and leave the markers in
    // place, so the affordance must not be offered at all.
    renderBand({ conflicts: [conflict({ blocker: "conflict_markers" })] });
    expect(
      screen.queryByRole("button", { name: "Resolve with agent" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("desk-conflict-row")).toHaveTextContent(
      "Committed conflict markers",
    );
    // The way out is still visible.
    expect(screen.getByRole("button", { name: "Diff" })).toBeInTheDocument();
  });

  it("does nothing on ⏎ when there is no resolution to run", () => {
    const { onResolveConflict } = renderBand({
      conflicts: [conflict({ blocker: "conflict_markers" })],
    });
    fireEvent.keyDown(screen.getByTestId("desk-conflict-row"), { key: "Enter" });
    expect(onResolveConflict).not.toHaveBeenCalled();
  });
});

describe("row order", () => {
  it("puts questions first, then failures, then conflicts", () => {
    renderBand({
      awaitingReply: [asks()],
      failed: [failure()],
      conflicts: [conflict()],
    });
    const stamps = screen
      .getAllByTestId(/desk-(asks-you|failed|conflict)-row/)
      .map((row) => row.textContent?.slice(0, 8));
    expect(stamps[0]).toContain("ASKS");
    expect(stamps[1]).toContain("FAILED");
    expect(stamps[2]).toContain("CONFLICT");
  });
});

/**
 * Give the coral stratum's scroll container a fold, and its rows a height.
 *
 * jsdom has no layout: every height is 0, so the band measures "nothing
 * overflows". These tests install the one thing a viewport would provide —
 * a container whose rect ends at `foldPx` and rows of `ROW_HEIGHT` each.
 */
const ROW_HEIGHT = 96;

function stubLayout(foldPx: number) {
  const list = screen.getByTestId("desk-your-turn-rows");
  const rows = Array.from(list.children) as HTMLElement[];

  Object.defineProperty(list, "clientHeight", { value: foldPx, configurable: true });
  Object.defineProperty(list, "scrollHeight", {
    value: rows.length * ROW_HEIGHT,
    configurable: true,
  });
  list.getBoundingClientRect = () => ({ top: 0, bottom: foldPx }) as DOMRect;
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () =>
      ({
        top: index * ROW_HEIGHT,
        bottom: (index + 1) * ROW_HEIGHT,
      }) as DOMRect;
  });
  // Re-run the component's measure(): the effect subscribes to scroll.
  fireEvent.scroll(list);
}

/**
 * The coral stratum used to spread one or two rows over 40vh (`justify-around`)
 * and crush READY TO LAND / UP NEXT underneath. It now sizes to its content and
 * admits when it is hiding rows.
 */
describe("band sizing", () => {
  const band = () => document.querySelector('[data-slot="strata-band"]');

  function manyAsks(n: number): DeskAwaitingReply[] {
    return Array.from({ length: n }, (_, i) =>
      asks({ epicId: `e-${i}`, title: `Ticket ${i}` }),
    );
  }

  it("keeps an empty band folded to its header — no floor, no filler", () => {
    renderBand();
    expect(screen.queryByTestId("desk-your-turn-rows")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desk-your-turn-overflow")).not.toBeInTheDocument();
    // Never grows: WORKING is the desk's only growing band.
    expect(band()!.className).toContain("shrink-0");
    expect(band()!.className).not.toContain("flex-1");
  });

  it("stops spreading rows over the whole band", () => {
    renderBand({ awaitingReply: [asks()] });
    const rows = screen.getByTestId("desk-your-turn-rows");
    expect(rows.className).toContain("justify-start");
    // The regression this whole story is about.
    expect(rows.className).not.toContain("justify-around");
    expect(rows.className).not.toContain("flex-1");
  });

  it("caps at 30vh and scrolls rather than pushing WORKING off screen", () => {
    renderBand({ awaitingReply: manyAsks(6) });
    expect(band()!.className).toContain("max-h-[30vh]");
    expect(band()!.className).not.toContain("max-h-[40vh]");
    expect(screen.getByTestId("desk-your-turn-rows").className).toContain("overflow-y-auto");
  });

  it("stays quiet when nothing is cut off", () => {
    renderBand({ awaitingReply: manyAsks(3) });
    stubLayout(4 * ROW_HEIGHT);
    expect(screen.queryByTestId("desk-your-turn-overflow")).not.toBeInTheDocument();
  });

  it("counts the hidden rows in the overflow line", () => {
    renderBand({ awaitingReply: manyAsks(6) });
    stubLayout(3 * ROW_HEIGHT);
    expect(screen.getByTestId("desk-your-turn-overflow")).toHaveTextContent("+3 more");
  });

  it("counts overflow across all three families, not just one", () => {
    // Four rows spanning the three families; the fold sits after three, so the
    // count must span families rather than counting one list.
    renderBand({
      awaitingReply: [asks({ epicId: "a1" }), asks({ epicId: "a2" })],
      failed: [failure({ epicId: "f1" })],
      conflicts: [conflict({ epicId: "c1" })],
    });
    stubLayout(3 * ROW_HEIGHT);
    expect(screen.getByTestId("desk-your-turn-overflow")).toHaveTextContent("+1 more");
  });
});

/**
 * Dismissing a signal.
 *
 * The band hands the row's OWN timestamp back up, not the moment of the click:
 * that is what lets the server bring the row back when a newer question,
 * failure or conflict lands on the same epic.
 */
describe("dismiss", () => {
  it("offers the action on all three families", () => {
    renderBand({
      awaitingReply: [asks()],
      failed: [failure()],
      conflicts: [conflict()],
      onDismiss: vi.fn(),
    });
    expect(screen.getAllByTestId("desk-dismiss")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Dismiss this question" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss this failure" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss this conflict" })).toBeInTheDocument();
  });

  it("stays hidden when the host wires no dismissal store", () => {
    renderBand({ awaitingReply: [asks()] });
    expect(screen.queryByTestId("desk-dismiss")).not.toBeInTheDocument();
  });

  it.each([
    ["asks", "Dismiss this question", "e1", "2026-08-28T09:00:00"],
    ["conflict", "Dismiss this conflict", "e3", "2026-08-28T08:00:00"],
  ])("reports the %s signal's own timestamp", (kind, label, epicId, signalAt) => {
    const onDismiss = vi.fn();
    renderBand({
      awaitingReply: [asks({ askedAt: "2026-08-28T09:00:00" })],
      conflicts: [conflict({ at: "2026-08-28T08:00:00" })],
      onDismiss,
    });
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onDismiss).toHaveBeenCalledWith(kind, { epicId, signalAt });
  });

  it("reports the failure's failedAt", () => {
    const onDismiss = vi.fn();
    const item = failure({ failedAt: "2026-08-28T07:30:00" });
    renderBand({ failed: [item], onDismiss });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this failure" }));
    expect(onDismiss).toHaveBeenCalledWith("failed", {
      epicId: item.epicId,
      signalAt: "2026-08-28T07:30:00",
    });
  });

  it("is reachable and operable from the keyboard", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderBand({ awaitingReply: [asks()], onDismiss });

    const button = screen.getByRole("button", { name: "Dismiss this question" });
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("goes quiet while the row has a mutation in flight", () => {
    renderBand({
      awaitingReply: [asks()],
      pendingIds: new Set(["e1"]),
      onDismiss: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Dismiss this question" })).toBeDisabled();
  });
});

/**
 * The overflow marker states a COUNT, so the count has to be true.
 *
 * It used to be `count - 3` on the assumption that three rows fit. jsdom has no
 * layout, so these tests install one: a fold at a chosen height and rows of a
 * known height, which is exactly what a viewport gives the real component.
 */
describe("YourTurnBand overflow marker", () => {
  function renderRows(n: number, foldPx: number) {
    const rows = Array.from({ length: n }, (_, i) =>
      asks({ epicId: `e${i}`, readableId: `PXB-${i}` }),
    );
    render(
      <YourTurnBand
        awaitingReply={rows}
        failed={[]}
        conflicts={[]}
        projectsById={projectsById}
        onReply={vi.fn()}
        onSendToDev={vi.fn()}
        onRetry={vi.fn()}
        onOpenLog={vi.fn()}
        onResolveConflict={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    stubLayout(foldPx);
  }

  it("counts the rows past the fold on a short viewport", () => {
    // 30vh of 950px ≈ 285px ≈ 3 rows of 96px. 6 rows ⇒ 3 hidden.
    renderRows(6, 3 * ROW_HEIGHT);
    expect(screen.getByTestId("desk-your-turn-overflow")).toHaveTextContent("+3 more");
  });

  it("says +2, not +3, on the taller viewport where a fourth row fits", () => {
    // The measured regression: at 1440x1300 the band grows to ~390px and shows
    // a fourth row, but the old fixed VISIBLE_ROWS = 3 still claimed "+3".
    renderRows(6, 4 * ROW_HEIGHT);
    expect(screen.getByTestId("desk-your-turn-overflow")).toHaveTextContent("+2 more");
  });

  it("stays silent when every row is on screen", () => {
    renderRows(3, 4 * ROW_HEIGHT);
    expect(screen.queryByTestId("desk-your-turn-overflow")).toBeNull();
  });

  it("keeps the marker outside the scroll container", () => {
    renderRows(6, 3 * ROW_HEIGHT);
    const marker = screen.getByTestId("desk-your-turn-overflow");
    expect(screen.getByTestId("desk-your-turn-rows").contains(marker)).toBe(false);
  });
});
