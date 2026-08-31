/**
 * The coral stratum of frame 11b: severity stamps, the row grammar, the filter
 * pills and the footnote that explains the link to Ready to land.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { FindingsBand } from "@/components/qa/FindingsBand";
import {
  applyFindingFilter,
  type FindingFilter,
} from "@/components/qa/FindingFilterPills";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type { QaFinding } from "@/lib/qa/types";

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01" },
  { id: "p2", name: "Ledger", createdAt: "2026-01-02" },
]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

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

function renderBand(
  rows: QaFinding[],
  filter: FindingFilter = "all",
  props: Partial<React.ComponentProps<typeof FindingsBand>> = {},
) {
  return render(
    <FindingsBand
      findings={rows}
      visible={applyFindingFilter(rows, filter)}
      filter={filter}
      onFilterChange={() => {}}
      projectsById={projectsById}
      {...props}
    />,
  );
}

describe("FindingsBand — the row grammar", () => {
  it("stamps each tier with the frame's word", () => {
    renderBand([
      finding(),
      finding({ findingId: "f2", tier: "major", severityLabel: "MAJOR" }),
      finding({ findingId: "f3", tier: "minor", severityLabel: "MINOR" }),
    ]);
    expect(screen.getByText("BLOCKING")).toBeInTheDocument();
    expect(screen.getByText("MAJOR")).toBeInTheDocument();
    expect(screen.getByText("MINOR")).toBeInTheDocument();
  });

  it("gives a minor row a translucent ground, no Fix and no Diff", () => {
    renderBand([
      finding({ findingId: "f3", tier: "minor", severityLabel: "MINOR" }),
    ]);
    const row = screen.getByTestId("qa-finding-row");
    expect(row.className).toContain("bg-card-translucent");
    expect(within(row).queryByTestId("qa-finding-fix")).toBeNull();
    expect(within(row).queryByTestId("qa-finding-diff")).toBeNull();
    expect(within(row).getByTestId("qa-finding-dismiss")).toBeInTheDocument();
  });

  it("prints file:line for a heavy row and drops it on a minor one", () => {
    const heavy = renderBand([finding()]);
    expect(
      screen.getByText(/lib\/agents\/session\.ts:214/),
    ).toBeInTheDocument();
    heavy.unmount();

    renderBand([
      finding({ findingId: "f3", tier: "minor", severityLabel: "MINOR" }),
    ]);
    expect(screen.queryByText(/lib\/agents\/session\.ts:214/)).toBeNull();
  });

  it("withholds Fix on an unfixable ticket, keeping Diff and Dismiss", () => {
    renderBand([finding({ fixable: false })]);
    const row = screen.getByTestId("qa-finding-row");
    expect(within(row).queryByTestId("qa-finding-fix")).toBeNull();
    expect(within(row).getByTestId("qa-finding-diff")).toBeInTheDocument();
  });

  it("prints an em-dash — never a guess — for a finding with no reviewer or stamp", () => {
    renderBand([finding({ reviewer: null, filedAt: null })]);
    expect(screen.getByText("— · —")).toBeInTheDocument();
  });

  it("dispatches exactly one filled action per row", () => {
    const onFix = vi.fn();
    renderBand([finding()], "all", { onFix });
    const row = screen.getByTestId("qa-finding-row");
    const filled = within(row)
      .getAllByRole("button")
      .filter((button) => button.dataset.variant === "filled");
    expect(filled).toHaveLength(1);
    fireEvent.click(within(row).getByTestId("qa-finding-fix"));
    expect(onFix).toHaveBeenCalledTimes(1);
  });
});

describe("FindingsBand — counters, filters and the footnote", () => {
  const rows = [
    finding(),
    finding({
      findingId: "f2",
      projectId: "p2",
      tier: "major",
      severityLabel: "MAJOR",
      blocking: false,
      reviewerAgentType: "review_code",
      reviewer: "Review CC",
    }),
    finding({
      findingId: "f3",
      tier: "minor",
      severityLabel: "MINOR",
      blocking: false,
      reviewerAgentType: "review_code",
    }),
  ];

  it("counts the UNFILTERED set, whatever the filter shows", () => {
    const { rerender } = renderBand(rows, "all");
    expect(screen.getByText("3 open · 1 blocking")).toBeInTheDocument();

    rerender(
      <FindingsBand
        findings={rows}
        visible={applyFindingFilter(rows, "blocking")}
        filter="blocking"
        onFilterChange={() => {}}
        projectsById={projectsById}
      />,
    );
    expect(screen.getByText("3 open · 1 blocking")).toBeInTheDocument();
    expect(screen.getAllByTestId("qa-finding-row")).toHaveLength(1);
  });

  it("selects blocking rows and security rows", () => {
    expect(applyFindingFilter(rows, "blocking").map((r) => r.findingId)).toEqual([
      "f1",
    ]);
    expect(applyFindingFilter(rows, "security").map((r) => r.findingId)).toEqual([
      "f1",
    ]);
    expect(applyFindingFilter(rows, "all")).toHaveLength(3);
  });

  it("marks the active pill and reports a change", () => {
    const onFilterChange = vi.fn();
    renderBand(rows, "all", { onFilterChange });
    expect(screen.getByTestId("qa-filter-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("qa-filter-blocking")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByTestId("qa-filter-security"));
    expect(onFilterChange).toHaveBeenCalledWith("security");
  });

  it("says so, quietly, when the filter selects nothing", () => {
    render(
      <FindingsBand
        findings={rows}
        visible={[]}
        filter="security"
        onFilterChange={() => {}}
        projectsById={projectsById}
      />,
    );
    expect(screen.getByText("Aucun finding pour ce filtre.")).toBeInTheDocument();
    expect(screen.queryAllByTestId("qa-finding-row")).toHaveLength(0);
  });

  it("renders the footnote verbatim, accents and French spacing included", () => {
    renderBand([]);
    const footnote = screen.getByTestId("qa-findings-footnote");
    expect(footnote.textContent).toBe(
      "Un finding blocking retire le ticket de Ready to land ; Fix with agent relance un build ciblé sur le finding.",
    );
    expect(within(footnote).getByText("blocking").tagName).toBe("STRONG");
  });

  it("collapses to header + footnote when nothing is open", () => {
    renderBand([]);
    expect(screen.queryByTestId("qa-findings-list")).toBeNull();
    expect(screen.getByText("0 open · 0 blocking")).toBeInTheDocument();
    expect(screen.getByTestId("qa-findings-footnote")).toBeInTheDocument();
  });
});
