/**
 * The registry row at phone and tablet widths.
 *
 * THE DEFECT (audit of 2026-09-05, Chrome via Playwright at 390×844, real
 * data): `REGISTRY_GRID` declared seven tracks —
 * `112px 1fr 130px 96px 120px 170px 110px` — at every width. The six FIXED
 * ones sum to 738px before the 6×12px gaps, so on a 390px screen (326px of
 * usable row after the page's 14px and the card's 18px padding) the `1fr`
 * title track was pushed to zero and every column after it ran out of the
 * card. `RegistryTable`'s `overflow-hidden` clipped the result, which is why
 * the screen looked "cropped" rather than broken.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. jsdom has no layout engine and
 * loads no Tailwind, so it can measure neither the collapsed title rectangle
 * nor the overflow. What it CAN pin is the mechanism that produced both — the
 * unprefixed seven-track template — and the two things the fix must not do
 * instead: drop the desktop table, or "fix" the phone by hiding columns.
 *
 * The RENDERED GEOMETRY — the title's real rectangle at 390 / 768 / 1280 /
 * 1440, no horizontal overflow, and a row that still opens its ticket — is a
 * visual claim and is measured in a real browser by
 * `e2e/tickets-registry-responsive.spec.ts`. This file is not a substitute
 * for it.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RegistryTable } from "@/components/tickets-registry/RegistryTable";
import type { DeskProject } from "@/lib/control-desk/types";
import type { RegistryGroup, RegistryRow } from "@/lib/tickets-registry/types";

function row(overrides: Partial<RegistryRow> & { epicId: string }): RegistryRow {
  return {
    projectId: "p1",
    readableId: `ARJ-${overrides.epicId}`,
    title:
      "Registre mobile : les titres des tickets disparaissent et les colonnes débordent",
    status: "todo",
    type: "feature",
    priority: 2,
    group: "waiting",
    taskType: null,
    startedAt: null,
    yourTurnKind: null,
    queueLabel: "To Do",
    queueRank: 1,
    blockedBy: [],
    isDraft: false,
    isQueued: false,
    mergeReady: false,
    mergeBlockerLine: null,
    releaseVersion: null,
    usDone: 2,
    usCount: 5,
    activity: "updated · 1d ago",
    activityAt: null,
    activityTone: "muted",
    costUsd: 0.84,
    projectName: "Arij",
    ...overrides,
  };
}

const EMPTY: Record<RegistryGroup, RegistryRow[]> = {
  active: [],
  your_turn: [],
  waiting: [],
  done: [],
  released: [],
};

function renderTable(rows: RegistryRow[] = [row({ epicId: "1" })]) {
  const rowsByGroup = { ...EMPTY, waiting: rows };
  return render(
    <RegistryTable
      sort="activite"
      direction="desc"
      onSortChange={() => {}}
      rowsByGroup={rowsByGroup}
      groupTotals={{ ...EMPTY, waiting: rows.length } as unknown as Record<RegistryGroup, number>}
      projectsById={new Map<string, DeskProject>()}
      collapsedGroups={new Set()}
      expandedGroups={new Set()}
      onToggleGroup={() => {}}
      onShowAll={() => {}}
      onOpenTicket={() => {}}
      footerStatus="1 ticket · 1 projet"
      cost30dUsd={12.5}
      exportCount={rows.length}
      onExportCsv={() => {}}
    />,
  );
}

/**
 * The `grid-cols-[…]` tracks a class string declares, keyed by breakpoint
 * (`base` for the unprefixed one). Tailwind spells a space as `_` inside an
 * arbitrary value, so splitting on it recovers the track list —
 * `minmax(0,1fr)` has a comma, never a space, and survives intact.
 */
function gridTemplates(className: string): Map<string, string[]> {
  const templates = new Map<string, string[]>();
  for (const token of className.split(/\s+/)) {
    const match = /^(?:([a-z0-9]+):)?grid-cols-\[(.+)\]$/.exec(token);
    if (!match) continue;
    templates.set(match[1] ?? "base", match[2].split("_"));
  }
  return templates;
}

/** The unprefixed utilities of a class string — what a 390px screen gets. */
function baseClasses(className: string): string[] {
  return className.split(/\s+/).filter((token) => token.length > 0 && !token.includes(":"));
}

describe("the registry row's grid", () => {
  it("does not impose the six fixed desktop columns on a phone", () => {
    renderTable();
    const templates = gridTemplates(screen.getByTestId("tickets-row").className);
    const base = templates.get("base");

    expect(base, "the row declares no unprefixed grid template").toBeDefined();
    // 112 + 130 + 96 + 120 + 170 + 110 = 738px of FIXED track, plus 72px of
    // gaps, against 326px of usable row at 390px. Two tracks (the identity
    // chip and the title) is what fits; anything beyond it is the defect.
    expect(
      base!.length,
      `the phone row still declares ${base!.length} tracks: ${base!.join(" ")}`,
    ).toBeLessThanOrEqual(2);
  });

  it("keeps the seven-column desktop table from lg up", () => {
    renderTable();
    const templates = gridTemplates(screen.getByTestId("tickets-row").className);

    expect(
      templates.get("lg"),
      "the desktop table's seven columns are not declared at lg",
    ).toEqual(["112px", "minmax(0,1fr)", "130px", "96px", "120px", "170px", "110px"]);
  });

  it("gives the title a track that can shrink but never collapses to auto", () => {
    renderTable();
    const templates = gridTemplates(screen.getByTestId("tickets-row").className);

    // `1fr` takes `auto` as its automatic minimum, so a long title can push
    // the track wider than the card; `minmax(0,1fr)` is the track that both
    // fills the row and yields. The title is the second cell at every width.
    for (const [breakpoint, tracks] of templates) {
      expect(
        tracks[1],
        `the title track at ${breakpoint} is "${tracks[1]}", not minmax(0,1fr)`,
      ).toBe("minmax(0,1fr)");
    }
  });

  it("still renders every column's content on a phone — nothing is merely hidden", () => {
    renderTable();
    const ticketRow = screen.getByTestId("tickets-row");

    // The criterion is explicit: the other information stays consultable
    // through the responsive layout or the ticket detail — `display: none` on
    // a phone is not a fix, it is the same data loss with a tidier edge.
    for (const element of ticketRow.querySelectorAll("*")) {
      expect(
        baseClasses(element.className.toString()),
        `a cell of the row is display:none on a phone: ${element.textContent}`,
      ).not.toContain("hidden");
    }

    // And the figures themselves are there to be read.
    expect(ticketRow.textContent).toContain("2/5");
    expect(ticketRow.textContent).toContain("$0.84");
    expect(ticketRow.textContent).toContain("1d ago");
  });
});

describe("the column header row", () => {
  it("stands down below lg, where the sort pill carries sorting instead", () => {
    renderTable();
    const header = screen.getByRole("row");

    // Seven sort buttons over two phone-width tracks is four wrapped rows of
    // kickers above every group. The filter row's `sort:` pill offers the same
    // seven sorts and the same direction toggle, at touch size.
    const classes = baseClasses(header.className);
    expect(classes, "the header row is still laid out on a phone").toContain("hidden");
    expect(header.className.split(/\s+/), "the header row never comes back").toContain(
      "lg:grid",
    );
  });

  it("keeps all seven accented labels for the widths that draw the table", () => {
    renderTable();
    for (const label of [
      "Ticket",
      "Titre",
      "État",
      "Stories",
      "Priorité",
      "Dernière activité",
      "Coût",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
