/**
 * The bottom split of frame 11b: VERDICTS RÉCENTS on sun, LA RUBRIQUE on pool.
 *
 * The verdict arrow is the ONE place on this screen where a colour leans on
 * state, and it is allowed because the arrow names a destination stratum
 * rather than a status.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { RubricBand } from "@/components/qa/RubricBand";
import { VerdictsBand } from "@/components/qa/VerdictsBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type { QaVerdict } from "@/lib/qa/types";

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01" },
]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

function verdict(overrides: Partial<QaVerdict> = {}): QaVerdict {
  return {
    epicId: "e1",
    projectId: "p1",
    readableId: "ARJ-107",
    title: "One",
    verdictText: "review clean · 0 findings",
    kind: "clean",
    outcome: "→ landed",
    at: "2026-08-30T09:00:00.000Z",
    ...overrides,
  };
}

describe("VerdictsBand", () => {
  it("prints the five verdict texts as the route derived them", () => {
    const rows: QaVerdict[] = [
      verdict(),
      verdict({ epicId: "e2", verdictText: "clean après review · 2 findings filed" }),
      verdict({
        epicId: "e3",
        verdictText: "changes requested · 1 finding",
        kind: "attention",
        outcome: "→ your turn",
      }),
      verdict({
        epicId: "e4",
        verdictText: "review unverifiable · findings jamais reçues",
        kind: "attention",
        outcome: "→ your turn",
      }),
      verdict({
        epicId: "e5",
        verdictText: "review sans verdict structuré",
        outcome: "→ ready",
      }),
    ];
    render(
      <VerdictsBand verdicts={rows} projectsById={projectsById} />,
    );

    for (const row of rows) {
      expect(screen.getByText(row.verdictText)).toBeInTheDocument();
    }
    expect(screen.getByText("Verdicts récents")).toBeInTheDocument();
    expect(screen.getByText("7 jours")).toBeInTheDocument();
  });

  it("paints '→ your turn' in the coral deep and the others muted", () => {
    render(
      <VerdictsBand
        verdicts={[
          verdict(),
          verdict({ epicId: "e2", outcome: "→ ready" }),
          verdict({ epicId: "e3", outcome: "→ your turn", kind: "attention" }),
        ]}
        projectsById={projectsById}
      />,
    );
    expect(screen.getByText("→ landed").className).toContain(
      "text-muted-foreground",
    );
    expect(screen.getByText("→ ready").className).toContain(
      "text-muted-foreground",
    );
    expect(screen.getByText("→ your turn").className).toContain(
      "text-strata-you-deep",
    );
  });

  it("folds to its label line when no review completed in the window", () => {
    render(<VerdictsBand verdicts={[]} projectsById={projectsById} />);
    expect(screen.getByText("Verdicts récents")).toBeInTheDocument();
    expect(screen.queryByTestId("qa-verdict-row")).toBeNull();
  });

  it("marks attention rows so the icon can differ without a colour switch", () => {
    render(
      <VerdictsBand
        verdicts={[verdict(), verdict({ epicId: "e2", kind: "attention" })]}
        projectsById={projectsById}
      />,
    );
    const kinds = screen
      .getAllByTestId("qa-verdict-row")
      .map((row) => row.dataset.kind);
    expect(kinds).toEqual(["clean", "attention"]);
  });
});

describe("RubricBand", () => {
  it("renders the checklist headings as chips", () => {
    render(
      <RubricBand
        rubric={{ items: ["Tests", "Integration"], projectRuleCount: 0 }}
      />,
    );
    const chips = screen.getAllByTestId("qa-rubric-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Tests", "Integration"]);
    expect(screen.queryByTestId("qa-rubric-project-rules")).toBeNull();
  });

  it("adds the project-rules chip only when there are project rules", () => {
    const { unmount } = render(
      <RubricBand rubric={{ items: ["Tests"], projectRuleCount: 4 }} />,
    );
    expect(screen.getByTestId("qa-rubric-project-rules").textContent).toBe(
      "+ 4 règles projet",
    );
    unmount();

    render(<RubricBand rubric={{ items: ["Tests"], projectRuleCount: 1 }} />);
    expect(screen.getByTestId("qa-rubric-project-rules").textContent).toBe(
      "+ 1 règle projet",
    );
  });

  it("keeps the helper, the link and the footnote when the checklist is empty", () => {
    render(<RubricBand rubric={{ items: [], projectRuleCount: 0 }} />);
    expect(screen.queryByTestId("qa-rubric-chip")).toBeNull();
    expect(screen.getByTestId("qa-rubric-helper").textContent).toBe(
      "ce que chaque reviewer vérifie — injectée dans son prompt",
    );
    expect(screen.getByTestId("qa-rubric-edit")).toHaveAttribute(
      "href",
      "/agents/prompts",
    );
    expect(screen.getByTestId("qa-rubric-footnote").textContent).toBe(
      "Review unverifiable (tests KO) = verdict à part : le ticket remonte en Your turn au lieu de passer.",
    );
  });

  it("keeps the frame's reading order: label, helper, then the link", () => {
    render(<RubricBand rubric={{ items: [], projectRuleCount: 0 }} />);
    const header = screen.getByText("La rubrique").parentElement as HTMLElement;
    const text = header.textContent ?? "";
    expect(text.indexOf("La rubrique")).toBeLessThan(
      text.indexOf("ce que chaque reviewer"),
    );
    expect(text.indexOf("ce que chaque reviewer")).toBeLessThan(
      text.indexOf("éditer"),
    );
    expect(within(header).getByTestId("qa-rubric-edit")).toBeInTheDocument();
  });
});
