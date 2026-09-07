/**
 * B-arij-M9zsQujUTCoR — the desk's coral actions run off the side of a phone,
 * and READY TO LAND / UP NEXT stay two columns wide enough for nothing.
 *
 * MEASURED IN CHROME on the unfixed desk (1 question · 2 failures · 1 conflict,
 * 2026-09-05, `channel: "chrome"`, http://localhost:3181):
 *
 *   390×844   the ASKS YOU card is 326px wide and its content 570px:
 *             the question span is 0px, `Send` starts at x=355, `Send to dev`
 *             ends at x=561 and the ✕ sits at x=573 — all three past a 390px
 *             viewport. UP NEXT chips: clientWidth 22px against scrollWidth
 *             294px. READY TO LAND rows: 139px wide, the Land pill painted
 *             over UP NEXT.
 *   768×1024  the row fits (scrollWidth 702 in 704) but the question span is
 *             STILL 0px, the land-row title 0px, and the queue chips 69px
 *             against 294–310px of label.
 *   1280/1440 clean — 450px and 610px of question, 153px chips.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
 *
 * jsdom has no layout engine and does not load Tailwind, so it can measure
 * neither a box nor an overflow. What it CAN pin is the mechanism: a single
 * flex line whose six children have no way to fold, a `grid-cols-2` with no
 * breakpoint, and a queue row that shows the same four chips at 290px as at
 * 1216px. Those are string- and structure-level facts about the markup and
 * they all flip with the fix.
 *
 * THE RENDERED GEOMETRY — every control inside the viewport, a legible chip,
 * an exact hidden counter at 0/1/6 signals — is a visual claim and is measured
 * in a real browser by `e2e/desk-mobile-layout.spec.ts`. This file is not a
 * substitute for it.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

import { NowDesk } from "@/components/desk/NowDesk";
import { UpNextBand } from "@/components/desk/UpNextBand";
import { ReadyToLandBand } from "@/components/desk/ReadyToLandBand";
import { YourTurnBand } from "@/components/desk/YourTurnBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type {
  ControlDeskPayload,
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
  DeskLandRow,
  DeskQueueTicket,
} from "@/lib/control-desk/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

const projects = deriveProjects([{ id: "p1", name: "Arij", createdAt: "2026-01-01" }]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

/* ------------------------------------------------------------------ */
/* Class-list helpers                                                  */
/* ------------------------------------------------------------------ */

function tokens(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

/**
 * Does the class list carry `utility` with NO responsive prefix?
 *
 * The point of the fix is that the desktop desk keeps utilities the phone may
 * not have, so a plain `includes()` would pass on `lg:flex-row` and prove
 * nothing. Only the unprefixed token — the one that applies at 390px — decides.
 */
function hasBaseUtility(element: HTMLElement, utility: string): boolean {
  return tokens(element).includes(utility);
}

/** Does the class list carry `variant:utility` exactly? */
function hasVariant(element: HTMLElement, variant: string, utility: string): boolean {
  return tokens(element).includes(`${variant}:${utility}`);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function asks(overrides: Partial<DeskAwaitingReply> = {}): DeskAwaitingReply {
  return {
    epicId: "e1",
    projectId: "p1",
    readableId: "F-arij-100",
    title: "Refonte du renderer",
    question:
      "Je garde le renderer legacy derrière un flag de configuration, ou je le supprime maintenant ?",
    author: "agent",
    askedAt: "2026-09-05T09:00:00",
    unreadAi: true,
    ...overrides,
  };
}

function failure(overrides: Partial<DeskFailure> = {}): DeskFailure {
  return {
    epicId: "e2",
    projectId: "p1",
    readableId: "B-arij-200",
    title: "Worker pool",
    sessionId: "s9",
    error: "exit 1 — worker pool did not drain in 120s",
    agentType: "build",
    agentName: "Opus Builder",
    provider: "claude-code",
    namedAgentId: "a1",
    userStoryId: null,
    producedOutput: true,
    failedAt: "2026-09-05T08:40:00",
    ...overrides,
  };
}

function conflict(overrides: Partial<DeskConflict> = {}): DeskConflict {
  return {
    epicId: "e3",
    projectId: "p1",
    readableId: "F-arij-300",
    title: "Tax export",
    blocker: "merge_conflict",
    branchName: "feature/epic-tax-export",
    at: "2026-09-05T08:00:00",
    ...overrides,
  };
}

function landRow(overrides: Partial<DeskLandRow> = {}): DeskLandRow {
  return {
    epicId: "l1",
    projectId: "p1",
    readableId: "F-arij-400",
    title: "Introduire des plafonds de rétention sur le chemin d'écriture",
    prNumber: 218,
    usDone: 4,
    usCount: 4,
    openFindings: 0,
    agentBusy: false,
    ...overrides,
  };
}

function queueTicket(index: number): DeskQueueTicket {
  return {
    epicId: `q${index}`,
    projectId: "p1",
    readableId: `F-arij-${500 + index}`,
    title: `Mobile : actions Your turn hors écran ${index}`,
    status: "todo",
    rank: index + 1,
    blockedBy: [],
    awaitingReply: false,
    specOnly: false,
    storyCount: 3,
  };
}

function renderYourTurn() {
  return render(
    <YourTurnBand
      awaitingReply={[asks()]}
      failed={[failure()]}
      conflicts={[conflict()]}
      projectsById={projectsById}
      onReply={vi.fn()}
      onSendToDev={vi.fn()}
      onRetry={vi.fn()}
      onOpenLog={vi.fn()}
      onResolveConflict={vi.fn()}
      onOpenDiff={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

/* ------------------------------------------------------------------ */
/* YOUR TURN                                                           */
/* ------------------------------------------------------------------ */

/** The three coral rows, by the test ids the band has always exposed. */
const CORAL_ROWS = [
  "desk-asks-you-row",
  "desk-failed-row",
  "desk-conflict-row",
] as const;

describe("YOUR TURN — a coral row folds instead of running off the screen", () => {
  /**
   * The reported defect, at its root. Six children on ONE flex line, each of
   * them either `shrink-0` (the stamp, the chip, all three buttons) or floored
   * by `min-w-[120px]` (the field): the line's min-content width is ~544px, so
   * on a 326px card everything past the field is simply painted outside the
   * viewport. A row that cannot become a column cannot fit a phone.
   */
  it.each(CORAL_ROWS)("stacks %s into lines below lg", (testId) => {
    renderYourTurn();
    const row = screen.getByTestId(testId);

    expect(
      hasVariant(row, "max-lg", "flex-col"),
      `${testId} is still a single flex line at every width, so its actions ` +
        `land outside a 390px viewport`,
    ).toBe(true);
    // And the desktop row keeps exactly the geometry it had: one line, centred.
    expect(hasBaseUtility(row, "flex")).toBe(true);
    expect(hasBaseUtility(row, "items-center")).toBe(true);
    expect(hasBaseUtility(row, "gap-3")).toBe(true);
  });

  /**
   * How the fold is expressed: two wrapper groups that are `display: contents`
   * from `lg` up, so above the breakpoint the card still has its original six
   * children as direct flex items and the desktop proportions are unchanged by
   * construction rather than by re-tuning.
   */
  it.each(CORAL_ROWS)("wraps %s in groups that vanish at lg", (testId) => {
    renderYourTurn();
    const row = screen.getByTestId(testId);
    const head = within(row).getByTestId("desk-row-head");
    const actions = within(row).getByTestId("desk-row-actions");

    for (const [name, group] of [
      ["head", head],
      ["actions", actions],
    ] as const) {
      expect(
        hasBaseUtility(group, "contents"),
        `the ${name} group of ${testId} must be display:contents at lg, or the ` +
          `desktop row grows a box it never had`,
      ).toBe(true);
      expect(hasVariant(group, "max-lg", "flex")).toBe(true);
      expect(hasVariant(group, "max-lg", "flex-wrap")).toBe(true);
      expect(hasVariant(group, "max-lg", "min-w-0")).toBe(true);
    }
  });

  /**
   * The message is the row's whole point ("« Je garde le renderer legacy… »")
   * and it measured 0px wide at BOTH 390 and 768. On a phone it takes its own
   * line, where it has the full card width instead of the leftovers.
   */
  it("gives the question and the error their own line on a phone", () => {
    renderYourTurn();
    const question = screen.getByText(/Je garde le renderer legacy/);
    const error = screen.getByText(/worker pool did not drain/);

    for (const [name, node] of [
      ["question", question],
      ["error", error],
    ] as const) {
      expect(
        hasVariant(node as HTMLElement, "max-sm", "basis-full"),
        `the ${name} still shares its line with the identity chips at 390px, ` +
          `where it measured 0px wide`,
      ).toBe(true);
    }
  });

  /**
   * The reply field is pinned at `max-w-[300px] min-w-[120px]` for the desktop
   * row. Below lg that floor is what pushed Send / Send to dev / ✕ off screen,
   * so the field grows from a wrap-friendly basis instead.
   */
  it("lets the reply field wrap onto its own line rather than floor the row", () => {
    renderYourTurn();
    const field = screen.getByLabelText("Reply to the agent") as HTMLElement;

    expect(hasBaseUtility(field, "max-w-[300px]")).toBe(true);
    expect(
      hasVariant(field, "max-lg", "max-w-none"),
      "the 300px desktop cap still applies on a phone",
    ).toBe(true);
    expect(
      tokens(field).some((token) => token.startsWith("max-lg:flex-[")),
      "the field needs a wrap-friendly basis below lg, so the send controls " +
        "can drop to the next line instead of leaving the viewport",
    ).toBe(true);
  });

  /**
   * The whole reason the ticket is a bug and not a polish request: at 390px
   * none of these could be reached. They are asserted by ACCESSIBLE NAME, so
   * the test fails if a fix hides a control instead of re-laying it out.
   */
  it("keeps every coral control named and enabled", () => {
    renderYourTurn();

    expect(screen.getByRole("textbox", { name: "Reply to the agent" })).toBeEnabled();
    for (const name of [
      "Send to dev",
      "Retry",
      "Log",
      "Resolve with agent",
      "Diff",
      "Dismiss this question",
      "Dismiss this failure",
      "Dismiss this conflict",
    ]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    // Send is the one control that is deliberately disabled on an empty draft.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ */
/* READY TO LAND                                                       */
/* ------------------------------------------------------------------ */

describe("READY TO LAND — the row keeps its title on a phone", () => {
  function renderLand() {
    return render(
      <ReadyToLandBand
        rows={[landRow()]}
        heldBackCount={1}
        projectsById={projectsById}
        onLand={vi.fn()}
        onLandAll={vi.fn()}
        onOpenTicket={vi.fn()}
      />,
    );
  }

  /**
   * At 390 the band was 139px wide and the row's title button measured 0px:
   * the identity chip, the `#218 · clean · 4/4 US` meta and the Land pill are
   * all `shrink-0`, so the only flexible child absorbed the whole deficit.
   */
  it("stacks the row below sm and keeps one line above it", () => {
    renderLand();
    const row = screen.getByTestId("desk-land-row");

    expect(
      hasVariant(row, "max-sm", "flex-col"),
      "the land row is still a single line at 390px, where its title measured 0px",
    ).toBe(true);
    expect(hasBaseUtility(row, "flex")).toBe(true);
    expect(hasBaseUtility(row, "items-center")).toBe(true);
    expect(hasBaseUtility(row, "gap-3")).toBe(true);
  });

  it("wraps the row in groups that vanish at sm", () => {
    renderLand();
    const row = screen.getByTestId("desk-land-row");

    for (const testId of ["desk-land-row-head", "desk-land-row-actions"] as const) {
      const group = within(row).getByTestId(testId);
      expect(hasBaseUtility(group, "contents"), `${testId} must vanish at sm`).toBe(true);
      expect(hasVariant(group, "max-sm", "flex")).toBe(true);
      expect(hasVariant(group, "max-sm", "min-w-0")).toBe(true);
    }
  });

  it("keeps the title and the Land action reachable", () => {
    renderLand();
    expect(
      screen.getByRole("button", {
        name: "Introduire des plafonds de rétention sur le chemin d'écriture",
      }),
    ).toBeEnabled();
    expect(screen.getByTestId("desk-land-button")).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ */
/* UP NEXT                                                             */
/* ------------------------------------------------------------------ */

describe("UP NEXT — four chips do not fit a phone, so it shows two", () => {
  function renderQueue(count: number) {
    return render(
      <UpNextBand
        upNext={[
          {
            projectId: "p1",
            tickets: Array.from({ length: count }, (_, i) => queueTicket(i)),
          },
        ]}
        projectsById={projectsById}
        onOpenTicket={vi.fn()}
      />,
    );
  }

  /**
   * At 390 the four-slot row left each chip 22px against a 294px label — a
   * pill with nothing in it. Below lg the row wraps: the project label takes
   * its own line and the chips take the width back.
   */
  it("wraps the queue row and gives the project label its own line below lg", () => {
    renderQueue(2);
    const row = screen.getByTestId("desk-up-next-row");

    expect(
      hasVariant(row, "max-lg", "flex-wrap"),
      "the queue row still keeps the 70px project label and four chips on one " +
        "line at 390px, where each chip measured 22px",
    ).toBe(true);

    const chips = screen.getAllByTestId("desk-queue-chip");
    expect(
      hasVariant(chips[0] as HTMLElement, "max-sm", "basis-full"),
      "a chip must own the full row width at 390px to be readable",
    ).toBe(true);
  });

  /**
   * The desktop row shows four slots; a stacked one shows two and hands the
   * rest to its OWN marker, because the count differs between the two layouts
   * and a single number cannot be right for both.
   */
  it("counts the chips it hides on a phone separately from the desktop marker", () => {
    renderQueue(6);

    const desktop = screen.getByTestId("desk-queue-overflow");
    const mobile = screen.getByTestId("desk-queue-overflow-mobile");

    // Desktop: 3 chips + "+3". Mobile: 2 chips + "+4".
    expect(desktop).toHaveTextContent("+3");
    expect(mobile).toHaveTextContent("+4");
    expect(
      hasVariant(desktop, "max-lg", "hidden"),
      "the desktop +N marker still shows on a phone, where it is wrong",
    ).toBe(true);
    expect(hasVariant(mobile, "lg", "hidden")).toBe(true);

    // The chips the phone does not show are hidden below lg, not unmounted:
    // the desktop layout still needs them.
    const chips = screen.getAllByTestId("desk-queue-chip");
    expect(chips).toHaveLength(3);
    expect(hasVariant(chips[0] as HTMLElement, "max-lg", "hidden")).toBe(false);
    expect(hasVariant(chips[1] as HTMLElement, "max-lg", "hidden")).toBe(false);
    expect(hasVariant(chips[2] as HTMLElement, "max-lg", "hidden")).toBe(true);
  });

  it("raises no mobile marker when the phone shows everything", () => {
    renderQueue(2);
    expect(screen.queryByTestId("desk-queue-overflow-mobile")).toBeNull();
  });

  it("still opens a ticket from a chip", () => {
    renderQueue(2);
    for (const chip of screen.getAllByTestId("desk-queue-chip")) {
      expect(chip).toBeEnabled();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The desk column                                                     */
/* ------------------------------------------------------------------ */

function payload(overrides: Partial<ControlDeskPayload> = {}): ControlDeskPayload {
  return {
    generatedAt: "2026-09-05T09:00:00.000Z",
    projects: [
      {
        id: "p1",
        name: "Arij",
        shortName: "ARIJ",
        colorIndex: 0,
        activeAgents: 0,
        autoModeEnabled: false,
      },
    ],
    working: [],
    queued: [],
    today: { ticketsShipped: 0, failedSessions: 0, costUsd: 0, projects: 1, sessions: 0 },
    yourTurn: { awaitingReply: [], failed: [], conflicts: [] },
    readyToLand: [],
    heldBackCount: 0,
    upNext: [],
    ...overrides,
  };
}

async function renderDesk(data: ControlDeskPayload, projectId?: string) {
  global.fetch = vi.fn(async (url: string) =>
    url === "/api/control-desk"
      ? { ok: true, status: 200, json: async () => ({ data }) }
      : { ok: true, status: 200, json: async () => ({ data: {} }) },
  ) as unknown as typeof fetch;

  const result = render(<NowDesk projectId={projectId} />);
  await waitFor(() => expect(screen.getByText("Your turn")).toBeInTheDocument());
  return result;
}

/** The Ready-to-land / Up-next row, found by the band it wraps. */
function landGrid(): HTMLElement {
  const land = document.querySelector('[data-stratum="land"]');
  expect(land).toBeTruthy();
  return land!.parentElement as HTMLElement;
}

describe("the desk column on a phone", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * `grid-cols-2` with no breakpoint is what left each band 139px at 390 and
   * 328px at 768 — narrow enough that both the queue chips and the land-row
   * titles were reduced to nothing.
   */
  it("stacks Ready to land above Up next below lg", async () => {
    await renderDesk(payload());
    const grid = landGrid();

    expect(
      hasBaseUtility(grid, "grid-cols-2"),
      "the two bands are still side by side at 390px, 139px each",
    ).toBe(false);
    expect(hasBaseUtility(grid, "grid-cols-1")).toBe(true);
    expect(hasVariant(grid, "lg", "grid-cols-2")).toBe(true);
    // The floor and the no-growth rule from desk-strata-balance still hold.
    expect(hasBaseUtility(grid, "shrink-0")).toBe(true);
    expect(grid.className).toContain("min-h-[168px]");
  });

  /**
   * Five strata do not fit in 844px once each of them is legible, and both
   * hosts clip rather than scroll — `/` gives the desk `h-full` inside an
   * `overflow-auto` main, and `/projects/:id` wraps it in an
   * `overflow-hidden` box. So the desk scrolls itself below lg.
   */
  it.each([undefined, "p1"])("scrolls itself below lg (projectId=%s)", async (projectId) => {
    await renderDesk(payload(), projectId);
    const desk = screen.getByTestId("now-desk");

    expect(
      hasVariant(desk, "max-lg", "overflow-y-auto"),
      "the desk cannot scroll on a phone, so a legible Up next is simply cut off",
    ).toBe(true);
    // Unchanged above the breakpoint: the desk is exactly one viewport tall.
    expect(hasBaseUtility(desk, "h-full")).toBe(true);
  });

  /**
   * WORKING is the desk's only growing band, and in a scrolling column a
   * grower with `min-h-0` is squeezed to nothing by its `shrink-0` siblings
   * long before the column ever overflows.
   */
  it("keeps a floor under WORKING once the column scrolls", async () => {
    await renderDesk(payload());
    const working = document.querySelector('[data-stratum="live"]') as HTMLElement;

    expect(
      tokens(working).some((token) => /^max-lg:min-h-\[/.test(token)),
      "WORKING has no floor below lg, so the strata under it crush it to zero",
    ).toBe(true);
  });
});
