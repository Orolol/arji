/**
 * ANATOMIE DU PROMPT (frame 8b, bottom band).
 *
 * The load-bearing behaviour is the width maths: percentages are computed
 * against the LARGEST row total on screen, not against each row's own total.
 * That is what makes the bars comparable across rows, which is the whole point
 * of the band ("élaguer ici paie partout").
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { PromptAnatomyBand } from "@/components/spec/PromptAnatomyBand";
import type { PromptAnatomyRow } from "@/components/spec/spec-format";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));

function row(over: Partial<PromptAnatomyRow> = {}): PromptAnatomyRow {
  const segments = {
    system: 0,
    persona: 0,
    spec: 0,
    memory: 0,
    ticket: 0,
    docs: 0,
    ...(over.segments ?? {}),
  };
  const total = Object.values(segments).reduce((a, b) => a + b, 0);
  return {
    agentId: "agent-1",
    agentName: "Opus Builder",
    role: "BUILD",
    annotations: {},
    sampledAt: null,
    sessionId: null,
    ...over,
    segments,
    total: over.total ?? total,
  };
}

/** The frame's three rows, to the token. */
const OPUS_BUILDER = row({
  agentId: "a1",
  agentName: "Opus Builder",
  role: "BUILD",
  segments: {
    system: 1300,
    persona: 400,
    spec: 3100,
    memory: 1100,
    ticket: 5800,
    docs: 2500,
  },
  annotations: { ticket: "epic + 5 stories" },
});

const CODEX_FAST = row({
  agentId: "a2",
  agentName: "Codex Fast",
  role: "BUG FIX",
  segments: {
    system: 1200,
    persona: 200,
    spec: 3100,
    memory: 1100,
    ticket: 4200,
    docs: 0,
  },
});

function widthOf(element: Element): number {
  return Number.parseFloat((element as HTMLElement).style.width);
}

describe("PromptAnatomyBand", () => {
  it("renders the six legend names, in the frame's order", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER]} />);

    const legend = screen.getByTestId("prompt-anatomy-legend");
    expect(legend.textContent).toBe(
      "SYSTEMPERSONASPECMEMORYTICKET / DIFFDOCS",
    );
  });

  it("scales every bar against the largest row total, not its own", () => {
    render(
      <PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER, CODEX_FAST]} />,
    );

    const [widest, narrower] = screen.getAllByTestId("prompt-bar-row");

    // The widest row fills the bar exactly and grows no tail.
    const widestSegments = within(widest)
      .getAllByTestId(/^prompt-bar-segment-/)
      .map(widthOf);
    expect(widestSegments.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    expect(within(widest).queryByTestId("prompt-bar-tail")).toBeNull();

    // The 9.8k row against a 14.2k max fills ~69% and leaves a ~31% tail.
    const narrowerSegments = within(narrower)
      .getAllByTestId(/^prompt-bar-segment-/)
      .map(widthOf);
    expect(narrowerSegments.reduce((a, b) => a + b, 0)).toBeCloseTo(
      (9800 / 14200) * 100,
      5,
    );
    expect(within(narrower).getByTestId("prompt-bar-tail")).toBeInTheDocument();
  });

  it("orders the segments SYSTEM → PERSONA → SPEC → MEMORY → TICKET → DOCS", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER]} />);

    const bar = screen.getByTestId("prompt-bar-row");
    expect(
      within(bar)
        .getAllByTestId(/^prompt-bar-segment-/)
        .map((node) => node.getAttribute("data-testid")),
    ).toEqual([
      "prompt-bar-segment-system",
      "prompt-bar-segment-persona",
      "prompt-bar-segment-spec",
      "prompt-bar-segment-memory",
      "prompt-bar-segment-ticket",
      "prompt-bar-segment-docs",
    ]);
  });

  it("labels a segment only above 7.5% of the bar", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER]} />);

    // PERSONA is 400/14200 ≈ 2.8% — drawn, but bare.
    expect(screen.getByTestId("prompt-bar-segment-persona")).toHaveTextContent("");
    // SPEC is 3100/14200 ≈ 21.8%.
    expect(screen.getByTestId("prompt-bar-segment-spec")).toHaveTextContent("3.1k");
  });

  it("appends a derivable annotation inside its segment", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER]} />);

    expect(screen.getByTestId("prompt-bar-segment-ticket")).toHaveTextContent(
      "5.8k — epic + 5 stories",
    );
  });

  it("renders nothing at all for a zero segment", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[CODEX_FAST]} />);

    expect(screen.queryByTestId("prompt-bar-segment-docs")).toBeNull();
    expect(screen.getByTestId("prompt-bar-row").textContent).not.toContain("0k");
  });

  it("prints the row total as the sum, right-aligned", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER]} />);
    expect(screen.getByTestId("prompt-bar-row")).toHaveTextContent("14.2k");
  });

  it("collapses to its label line plus one sentence when there are no rows", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[]} />);

    expect(screen.getByText("Anatomie du prompt")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-anatomy-legend")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-anatomy-empty")).toHaveTextContent(
      "Aucune session n'a encore enregistré son prompt — la première dispatche remplira ce tableau.",
    );
    expect(screen.queryAllByTestId("prompt-bar-row")).toHaveLength(0);
  });

  it("ships the corrected colour words in the footnote", () => {
    render(<PromptAnatomyBand projectId="proj-1" rows={[OPUS_BUILDER]} />);

    expect(screen.getByText(/vert tilleul/)).toBeInTheDocument();
    expect(screen.getByText(/turquoise/)).toBeInTheDocument();
    expect(screen.queryByText(/\(jaune\)/)).toBeNull();
  });
});
