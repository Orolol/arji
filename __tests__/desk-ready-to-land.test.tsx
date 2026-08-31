/**
 * The sun stratum: what a merge click would land right now.
 *
 * Replaces the merge-affordance half of the deleted `epic-card-*` suites — the
 * rule that any session owning a ticket (queued included) withholds the Land
 * button, that the batch action is a sequential loop rather than a parallel
 * one, and that the footer counts what is held back.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ReadyToLandBand, landMeta } from "@/components/desk/ReadyToLandBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type { DeskLandRow } from "@/lib/control-desk/types";

const projects = deriveProjects([{ id: "p1", name: "Arij", createdAt: "2026-01-01" }]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

function row(overrides: Partial<DeskLandRow> & { epicId: string }): DeskLandRow {
  return {
    projectId: "p1",
    readableId: `ARJ-${overrides.epicId}`,
    title: "Project rail: breathing dots per project",
    prNumber: 218,
    usDone: 4,
    usCount: 4,
    openFindings: 0,
    agentBusy: false,
    ...overrides,
  };
}

function renderBand(
  props: Partial<React.ComponentProps<typeof ReadyToLandBand>> = {},
) {
  const onLand = vi.fn();
  const onLandAll = vi.fn();
  render(
    <ReadyToLandBand
      rows={[]}
      heldBackCount={0}
      projectsById={projectsById}
      onLand={onLand}
      onLandAll={onLandAll}
      {...props}
    />,
  );
  return { onLand, onLandAll };
}

describe("empty stratum", () => {
  it("collapses to its label line", () => {
    renderBand();
    expect(screen.getByText("Ready to land")).toBeInTheDocument();
    expect(screen.queryByTestId("desk-land-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desk-land-all")).not.toBeInTheDocument();
  });
});

describe("land rows", () => {
  it("prints the PR number, the finding state and the story tally", () => {
    renderBand({ rows: [row({ epicId: "107" })] });
    expect(screen.getByText("#218 · clean · 4/4 US")).toBeInTheDocument();
  });

  it("omits the PR number when there is no PR", () => {
    expect(landMeta(row({ epicId: "83", prNumber: null, usCount: 3, usDone: 3 }))).toBe(
      "clean · 3/3 US",
    );
  });

  it("names the open findings without refusing the merge", () => {
    // The merge IS the approval and resolves whatever is left, so a finding is
    // information on the row, not a gate.
    renderBand({ rows: [row({ epicId: "107", openFindings: 2 })] });
    expect(screen.getByText("#218 · 2 findings · 4/4 US")).toBeInTheDocument();
    expect(screen.getByTestId("desk-land-button")).toBeEnabled();
  });

  it("lands a single ticket", () => {
    const { onLand } = renderBand({ rows: [row({ epicId: "107" })] });
    fireEvent.click(screen.getByTestId("desk-land-button"));
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(onLand.mock.calls[0][0].epicId).toBe("107");
  });

  it("withholds Land while ANY session owns the ticket", () => {
    // Queued counts: merging removes the worktree a queued build would land in.
    renderBand({ rows: [row({ epicId: "107", agentBusy: true })] });
    expect(screen.queryByTestId("desk-land-button")).not.toBeInTheDocument();
    expect(screen.getByText("agent au travail")).toBeInTheDocument();
  });

  it("locks every other row while one merge is in flight", () => {
    // Merges share the project's base checkout; two at once collide on
    // git's index.lock.
    renderBand({
      rows: [row({ epicId: "1" }), row({ epicId: "2" })],
      landingEpicId: "1",
    });
    const buttons = screen.getAllByTestId("desk-land-button");
    expect(buttons[0]).toHaveTextContent("Landing…");
    expect(buttons[1]).toBeDisabled();
  });
});

describe("batch land", () => {
  it("offers 'Land both' for exactly two landable rows", () => {
    renderBand({ rows: [row({ epicId: "1" }), row({ epicId: "2" })] });
    expect(screen.getByTestId("desk-land-all")).toHaveTextContent("Land both");
  });

  it("counts itself past two", () => {
    renderBand({
      rows: [row({ epicId: "1" }), row({ epicId: "2" }), row({ epicId: "3" })],
    });
    expect(screen.getByTestId("desk-land-all")).toHaveTextContent("Land all 3");
  });

  it("never offers a batch for a single row", () => {
    renderBand({ rows: [row({ epicId: "1" })] });
    expect(screen.queryByTestId("desk-land-all")).not.toBeInTheDocument();
  });

  it("excludes busy rows from the batch it dispatches", () => {
    const { onLandAll } = renderBand({
      rows: [
        row({ epicId: "1" }),
        row({ epicId: "2" }),
        row({ epicId: "3", agentBusy: true }),
      ],
    });
    fireEvent.click(screen.getByTestId("desk-land-all"));
    expect(onLandAll.mock.calls[0][0].map((r: DeskLandRow) => r.epicId)).toEqual([
      "1",
      "2",
    ]);
  });

  it("swaps the word while the batch runs", () => {
    renderBand({
      rows: [row({ epicId: "1" }), row({ epicId: "2" })],
      landingAll: true,
    });
    expect(screen.getByTestId("desk-land-all")).toHaveTextContent("Landing…");
  });
});

describe("held back", () => {
  it("reports how many to_merge tickets a blocker holds back", () => {
    renderBand({ rows: [row({ epicId: "1" })], heldBackCount: 2 });
    expect(
      screen.getByText("2 autres bloqués par des findings ouverts →"),
    ).toBeInTheDocument();
  });

  it("agrees with itself in the singular", () => {
    renderBand({ heldBackCount: 1 });
    expect(
      screen.getByText("1 autre bloqué par des findings ouverts →"),
    ).toBeInTheDocument();
  });

  it("says nothing when nothing is held back", () => {
    renderBand({ rows: [row({ epicId: "1" })] });
    expect(screen.queryByText(/bloqué/)).not.toBeInTheDocument();
  });
});
