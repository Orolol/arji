/**
 * B-arij-iL4-FmyXgGr — a finding's actions are laid out past the right edge of
 * a phone screen.
 *
 * MEASURED IN CHROME on the unfixed row (2026-09-05, `/qa`, one epic, three
 * seeded findings, a named reviewer and a 74-character path — see
 * `e2e/qa-findings-responsive.spec.ts` for the harness). The blocking row:
 *   320px  Fix x=480→603, Diff x=615→664, Dismiss x=676→748; description 0.0px
 *   390px  identical — the row is 717px wide whatever the screen is
 *   414px  identical
 *   768px  actions inside the screen, description still 0.0px
 *   1024 / 1280 / 1440  clean
 * and the band's own scrollWidth was 717 against a 256/326/350/704px client
 * width. The PAGE never scrolled sideways at any width: the band is
 * `overflow-y-auto`, which makes its `overflow-x` compute to `auto`, so the
 * row and its three pills simply disappeared inside it.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
 *
 * jsdom has no layout engine and never loads Tailwind, so it can measure
 * neither the off-screen pill nor the crushed description. What it CAN pin is
 * the mechanism that produced both: ONE non-wrapping flex line holding a
 * severity stamp, an id chip, a reviewer meta and three `shrink-0` pills, with
 * only the description allowed to give way — so on a narrow screen the
 * description goes to zero and the pills go past the edge.
 *
 * The three facts below all flip with the fix, and all three are string-level
 * facts about the markup. The RENDERED GEOMETRY — every action inside the
 * viewport from 320px to 1440px, a description that stays readable, and a band
 * that never scrolls sideways — is a visual claim measured in a real browser by
 * `e2e/qa-findings-responsive.spec.ts`. This file is not a substitute for it.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { FindingRow } from "@/components/qa/FindingRow";
import { QaRunsBand } from "@/components/qa/QaRunsBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type { QaFinding, QaRun } from "@/lib/qa/types";

const [project] = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01" },
]);

/** A finding whose description and path are the widest the row ever draws. */
function finding(overrides: Partial<QaFinding> = {}): QaFinding {
  return {
    findingId: "f1",
    epicId: "e1",
    projectId: "p1",
    readableId: "ARJ-113",
    ticketTitle: "Named agents",
    text:
      "Le token MCP est écrit en clair dans le journal de session quand le " +
      "processus fils meurt avant d'avoir répondu",
    filePath:
      "lib/providers/claude-code/session/mcp/injection/temporary-configuration.ts",
    lineNumber: 2140,
    severity: "critical",
    severityLabel: "BLOCKING",
    tier: "blocking",
    blocking: true,
    reviewer: "Sentinelle Sécurité",
    reviewerAgentType: "review_security",
    filedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    fixable: true,
    rawBody: "[critical] Le token MCP est écrit en clair",
    ...overrides,
  };
}

function renderRow(overrides: Partial<QaFinding> = {}) {
  render(<FindingRow finding={finding(overrides)} project={project} />);
  return screen.getByTestId("qa-finding-row");
}

/**
 * Does the class list carry `utility` with NO responsive prefix — the one that
 * applies at 320px?
 *
 * A plain `includes()` would match `lg:flex-nowrap` and report the desktop
 * rule as the phone's, which is exactly the confusion this fix is about.
 */
function hasBaseUtility(element: HTMLElement, utility: string): boolean {
  return element.className
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => token === utility);
}

/** Does it carry the exact token, prefix included (`lg:basis-0`)? */
function hasUtility(element: HTMLElement, utility: string): boolean {
  return element.className.split(/\s+/).filter(Boolean).includes(utility);
}

describe("FindingRow — the actions stay on the phone screen", () => {
  /**
   * The defect, at its root: one flex line that may not wrap. The stamp, the
   * chip, the meta and the three pills are each `shrink-0`, so a line too
   * narrow for their sum does not fold — it overflows, and everything after
   * the description lands past the right edge.
   */
  it("lets the row fold onto a second line on a phone", () => {
    const row = renderRow();

    expect(
      hasBaseUtility(row, "flex-wrap"),
      "the row still lays its stamp, chip, description, meta and three pills " +
        "out on one unwrappable line, which is what pushed the pills off a " +
        "390px screen",
    ).toBe(true);
    expect(
      hasBaseUtility(row, "flex-nowrap"),
      "the row forbids wrapping at 320px",
    ).toBe(false);
  });

  /**
   * A fold is only a fix if the actions fold TOGETHER. Three loose pills would
   * wrap one at a time and leave `Dismiss` alone on a line of its own; the
   * group is also what carries the row's right alignment once it has a line to
   * itself.
   */
  it("keeps the three actions in one group that can take its own line", () => {
    const row = renderRow();
    const actions = within(row).getByTestId("qa-finding-actions");

    expect(actions.parentElement).toBe(row);
    for (const id of ["qa-finding-fix", "qa-finding-diff", "qa-finding-dismiss"]) {
      expect(
        within(actions).getByTestId(id),
        `${id} is not inside the action group, so it wraps on its own`,
      ).toBeInTheDocument();
    }

    expect(
      hasBaseUtility(actions, "basis-full"),
      "the action group does not claim a full line on a phone",
    ).toBe(true);
    expect(
      hasBaseUtility(actions, "flex-wrap"),
      "the group cannot fold its own pills at 320px, where the three of them " +
        "are wider than the card",
    ).toBe(true);
  });

  /**
   * The other half of the report. On the unfixed row the description was the
   * ONLY flexible item, so it absorbed the whole shortfall and measured 0px
   * wide at 390px — the finding was invisible and its actions were off-screen.
   */
  it("gives the description its own line rather than crushing it to nothing", () => {
    const row = renderRow();
    const text = within(row).getByTestId("qa-finding-text");

    expect(hasBaseUtility(text, "basis-full")).toBe(true);
    expect(
      hasBaseUtility(text, "min-w-0"),
      "the description must still be allowed to shrink inside the desktop row",
    ).toBe(true);
  });

  /**
   * The reviewer meta is a named agent's name — arbitrary length, and
   * `shrink-0` on the unfixed row. On a phone it shares the first line with the
   * stamp and the chip, so it has to be allowed to give way there.
   */
  it("lets a long reviewer name give way on a phone and hold its width on desktop", () => {
    const row = renderRow();
    const meta = within(row).getByTestId("qa-finding-meta");

    expect(hasBaseUtility(meta, "shrink-0")).toBe(false);
    expect(hasUtility(meta, "lg:shrink-0")).toBe(true);
    expect(
      hasBaseUtility(meta, "truncate"),
      "a reviewer name too long for the first line would widen the card",
    ).toBe(true);
  });

  /**
   * "une simple règle overflow-hidden ne constitue pas une correction" — the
   * ticket says so in as many words. Clipping the row would hide the pills
   * instead of moving them, and this is the assertion that says so out loud.
   *
   * A CONTROL: it passes on the unfixed row too. It is here to fail on a
   * future "fix" that reaches for the clip.
   */
  it("does not clip the row instead of folding it", () => {
    const row = renderRow();

    for (const utility of [
      "overflow-hidden",
      "overflow-x-hidden",
      "overflow-x-auto",
      "overflow-x-scroll",
    ]) {
      expect(
        hasBaseUtility(row, utility),
        `the row carries "${utility}": the actions would be hidden, not reachable`,
      ).toBe(false);
    }
  });
});

describe("FindingRow — the desktop row is unchanged", () => {
  /**
   * Every phone rule is undone at `lg`, so 1024px and up keep the frame's own
   * single line: stamp · chip · description · meta · exactly one filled button
   * then the outline ones.
   */
  it("puts the row back on one line from lg up", () => {
    const row = renderRow();
    const actions = within(row).getByTestId("qa-finding-actions");
    const text = within(row).getByTestId("qa-finding-text");

    expect(hasUtility(row, "lg:flex-nowrap")).toBe(true);
    expect(hasUtility(actions, "lg:basis-auto")).toBe(true);
    expect(hasUtility(actions, "lg:order-none")).toBe(true);
    expect(hasUtility(text, "lg:basis-0")).toBe(true);
    expect(hasUtility(text, "lg:order-none")).toBe(true);
  });

  /** The frame's reading order, which the phone layout reorders with `order-*`. */
  it("keeps the frame's DOM order: stamp, chip, description, meta, actions", () => {
    const row = renderRow();
    const order = Array.from(row.children).map(
      (child) =>
        child.getAttribute("data-testid") ??
        child.getAttribute("data-slot") ??
        child.tagName.toLowerCase(),
    );

    expect(order).toEqual([
      "stamp",
      "identity-chip",
      "qa-finding-text",
      "qa-finding-meta",
      "qa-finding-actions",
    ]);
  });

  /** The row grammar the band's own test pins, still true through the group. */
  it("still draws exactly one filled button, and only Dismiss on a minor row", () => {
    const heavy = render(<FindingRow finding={finding()} project={project} />);
    const filled = within(heavy.getByTestId("qa-finding-actions"))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("data-variant") === "filled");
    expect(filled).toHaveLength(1);
    expect(filled[0]).toHaveAttribute("data-testid", "qa-finding-fix");
    heavy.unmount();

    const light = render(
      <FindingRow
        finding={finding({ tier: "minor", severityLabel: "MINOR" })}
        project={project}
      />,
    );
    const minorActions = light.getByTestId("qa-finding-actions");
    expect(within(minorActions).getAllByRole("button")).toHaveLength(1);
    expect(
      within(minorActions).getByTestId("qa-finding-dismiss"),
    ).toBeInTheDocument();
  });
});

/**
 * The findings row is not alone on 11b, and the ticket's fourth criterion is
 * about the PAGE. `QaRunsBand` draws the other fixed-column grid; measured in
 * Chrome with two live reviews and one queued tile, its three columns came to
 * 384px inside a 292px band at 320px, and 431px inside 362px at 390px — the
 * third card, and the Stop control on it, outside the screen.
 *
 * The bottom split (`VERDICTS RÉCENTS` | `LA RUBRIQUE`, in `QaScreen`) folds
 * for the same reason and is pinned in the browser rather than here:
 * rendering the whole screen needs the poll stubbed, and
 * `e2e/qa-findings-responsive.spec.ts` already measures every band of a busy
 * screen at 320/390/768.
 */
describe("QaRunsBand — the run grid folds on a phone", () => {
  const run: QaRun = {
    sessionId: "s1",
    projectId: "p1",
    epicId: "e1",
    readableId: "ARJ-113",
    title: "Named agents",
    agentName: "Relecteur Fonctionnel",
    startedAt: new Date().toISOString(),
    lastLine: "Analyse de lib/providers/claude-code/session/mcp/injection.ts",
    findingsFiled: 2,
    blockingFiled: 1,
  };

  it("draws one column on a phone and the frame's three from lg", () => {
    render(
      <QaRunsBand
        runs={[run, { ...run, sessionId: "s2" }]}
        queued={[]}
        projectsById={new Map([[project.id, project]])}
      />,
    );
    const grid = screen.getByTestId("qa-runs-grid");

    expect(
      hasBaseUtility(grid, "grid-cols-3"),
      "three fixed columns at 320px is what pushed the third run card out of " +
        "the band",
    ).toBe(false);
    expect(hasBaseUtility(grid, "grid-cols-1")).toBe(true);
    expect(hasUtility(grid, "lg:grid-cols-3")).toBe(true);
  });
});
