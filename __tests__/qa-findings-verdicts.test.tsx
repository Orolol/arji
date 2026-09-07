/**
 * The bottom split of frame 11b: VERDICTS RÉCENTS on sun, LA RUBRIQUE on pool.
 *
 * The verdict arrow is the ONE place on this screen where a colour leans on
 * state, and it is allowed because the arrow names a destination stratum
 * rather than a status.
 *
 * B-arij-S3gpcD1w-ZEB is pinned at the bottom of this file: below `sm` the row
 * folds, because its id chip and its outcome are both unshrinkable and on a
 * phone they leave the verdict itself nothing. jsdom has no layout engine and
 * never loads Tailwind, so what is pinned here is the MARKUP that produced the
 * overflow; the rendered geometry is measured in Chrome by
 * `e2e/qa-findings-responsive.spec.ts`.
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
      verdict({ epicId: "e2", verdictText: "clean after review · 2 findings filed" }),
      verdict({
        epicId: "e3",
        verdictText: "changes requested · 1 finding",
        kind: "attention",
        outcome: "→ your turn",
      }),
      verdict({
        epicId: "e4",
        verdictText: "review unverifiable · findings never received",
        kind: "attention",
        outcome: "→ your turn",
      }),
      verdict({
        epicId: "e5",
        verdictText: "review with no structured verdict",
        outcome: "→ ready",
      }),
    ];
    render(
      <VerdictsBand verdicts={rows} projectsById={projectsById} />,
    );

    for (const row of rows) {
      expect(screen.getByText(row.verdictText)).toBeInTheDocument();
    }
    expect(screen.getByText("Recent verdicts")).toBeInTheDocument();
    expect(screen.getByText("7 days")).toBeInTheDocument();
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
    expect(screen.getByText("Recent verdicts")).toBeInTheDocument();
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
      "+ 4 project rules",
    );
    unmount();

    render(<RubricBand rubric={{ items: ["Tests"], projectRuleCount: 1 }} />);
    expect(screen.getByTestId("qa-rubric-project-rules").textContent).toBe(
      "+ 1 project rule",
    );
  });

  it("keeps the helper, the link and the footnote when the checklist is empty", () => {
    render(<RubricBand rubric={{ items: [], projectRuleCount: 0 }} />);
    expect(screen.queryByTestId("qa-rubric-chip")).toBeNull();
    expect(screen.getByTestId("qa-rubric-helper").textContent).toBe(
      "what every reviewer checks — injected into their prompt",
    );
    expect(screen.getByTestId("qa-rubric-edit")).toHaveAttribute(
      "href",
      "/agents/prompts",
    );
    expect(screen.getByTestId("qa-rubric-footnote").textContent).toBe(
      "Review unverifiable (tests KO) = a verdict of its own: the ticket goes back to Your turn instead of passing.",
    );
  });

  it("keeps the frame's reading order: label, helper, then the link", () => {
    render(<RubricBand rubric={{ items: [], projectRuleCount: 0 }} />);
    const header = screen.getByText("The rubric").parentElement as HTMLElement;
    const text = header.textContent ?? "";
    expect(text.indexOf("The rubric")).toBeLessThan(
      text.indexOf("what every reviewer checks"),
    );
    expect(text.indexOf("what every reviewer checks")).toBeLessThan(
      text.indexOf("edit"),
    );
    expect(within(header).getByTestId("qa-rubric-edit")).toBeInTheDocument();
  });
});

/**
 * B-arij-S3gpcD1w-ZEB — "Verdicts récents" overflows itself on a 320px screen.
 *
 * MEASURED IN CHROME on the unfixed row (2026-09-06, `/qa`, one seeded verdict
 * whose readable id is the longest the generator can make — `E-<slug≤20>-NNN`,
 * 26 characters, 173.1px of Space Mono; see `components/qa/VerdictRow.tsx` for
 * the full table). At 320px the band reported `scrollWidth` 318 against a
 * `clientWidth` of 292 — the 26px `e2e/qa-findings-responsive.spec.ts` fails
 * on — and the verdict text measured 0.0px. It was still 0.0px at 360px and
 * 12.7px at 390px: below `sm` the band drew a ticket id and an arrow, and
 * nothing of what the review concluded.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. jsdom measures nothing, so the
 * three facts below are string- and structure-level facts about the markup:
 * the row may fold, the verdict and its outcome fold TOGETHER, and the fold
 * is undone from `sm` up. That the band then fits, that the text is 148.8px
 * wide at 320px and that the desktop row is unchanged to the byte are visual
 * claims, measured in a real browser by the e2e spec.
 */
describe("VerdictRow — the band stays inside a phone screen", () => {
  /**
   * Does the class list carry `utility` with NO responsive prefix — the one
   * that applies at 320px? A plain `includes()` would match `sm:flex-nowrap`
   * and report the desktop rule as the phone's, which is exactly the confusion
   * this fix is about. Same helper as `__tests__/qa-mobile-layout.test.tsx`.
   */
  function hasBaseUtility(element: HTMLElement, utility: string): boolean {
    return element.className
      .split(/\s+/)
      .filter(Boolean)
      .some((token) => token === utility);
  }

  /** Does it carry the exact token, prefix included (`sm:contents`)? */
  function hasUtility(element: HTMLElement, utility: string): boolean {
    return element.className.split(/\s+/).filter(Boolean).includes(utility);
  }

  function renderRow(overrides: Partial<QaVerdict> = {}) {
    render(
      <VerdictsBand
        verdicts={[
          verdict({
            // The widest id `generateReadableId` can produce: `E-` + a 20-char
            // slug + `-NNN`. This is what measured 173.1px in Chrome.
            readableId: "E-e2e-keeps-every-band-001",
            verdictText: "review unverifiable · findings never received",
            outcome: "→ your turn",
            kind: "attention",
            ...overrides,
          }),
        ]}
        projectsById={projectsById}
      />,
    );
    return screen.getByTestId("qa-verdict-row");
  }

  /**
   * The defect at its root: one flex line that may not wrap, holding a 173px
   * id chip and a 71px outcome that are both `shrink-0`. A line too narrow for
   * their sum does not fold — it overflows, which is the band's own
   * `scrollWidth` running 26px past its `clientWidth` at 320px.
   */
  it("lets the row fold onto a second line on a phone", () => {
    const row = renderRow();

    expect(
      hasBaseUtility(row, "flex-wrap"),
      "the row still lays its icon, id chip, verdict and outcome out on one " +
        "unwrappable line, which is what pushed the band 26px past its own " +
        "edge at 320px",
    ).toBe(true);
    expect(
      hasBaseUtility(row, "flex-nowrap"),
      "the row forbids wrapping at 320px",
    ).toBe(false);
  });

  /**
   * A fold is only a fix if the verdict and its outcome fold TOGETHER: the
   * arrow is the end of the sentence the verdict text starts, and stranding it
   * on a third line of its own would be a worse row than the one being fixed.
   * `basis-full` is what drops the pair off the chip's line; `min-w-0` is what
   * lets the text clamp there instead of pushing the outcome out in turn.
   */
  it("drops the verdict and its outcome onto one line of their own", () => {
    const row = renderRow();
    const line = within(row).getByTestId("qa-verdict-line");

    expect(
      hasBaseUtility(line, "basis-full"),
      "the verdict shares the chip's line, where 320px leaves it nothing",
    ).toBe(true);
    expect(hasBaseUtility(line, "min-w-0")).toBe(true);
    expect(
      within(line).getByText("review unverifiable · findings never received"),
    ).toBeInTheDocument();
    expect(within(line).getByText("→ your turn")).toBeInTheDocument();
    // The chip is NOT in the group: it is the line the verdict folds away from.
    expect(within(line).queryByText("E-e2e-keeps-every-band-001")).toBeNull();
  });

  /**
   * Every phone rule is undone from `sm` up, where the text has 262px and the
   * frame's single line is the right drawing. `sm:contents` dissolves the fold
   * group rather than nesting a second flex level inside the row, so the four
   * items are the direct flex children they always were — the 1280px band
   * screenshot is byte-identical across this fix.
   */
  it("is the frame's single line again from sm up", () => {
    const row = renderRow();
    const line = within(row).getByTestId("qa-verdict-line");

    expect(hasUtility(row, "sm:flex-nowrap")).toBe(true);
    expect(
      hasUtility(line, "sm:contents"),
      "the fold group still takes part in the desktop layout",
    ).toBe(true);
  });

  /**
   * DOM order never changes: the fold is a wrapper, not a reordering, so a
   * screen reader and the desktop row read icon · chip · verdict · outcome
   * at every width.
   */
  it("keeps the frame's reading order at every width", () => {
    const row = renderRow();
    expect(row.textContent).toBe(
      "E-e2e-keeps-every-band-001review unverifiable · findings never received→ your turn",
    );
  });
});
