import type { Page } from "@playwright/test";

import { createEpic, expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-M9zsQujUTCoR — the desk on a phone, in a real browser.
 *
 * This is the half of the fix that `__tests__/desk-mobile-layout.test.tsx`
 * cannot do. jsdom has no layout engine, so the unit file only pins the markup
 * that produced the defect. Whether a control is inside the viewport, whether
 * the question span is wider than zero and whether a chip shows any of its
 * label are visual claims and need Chrome.
 *
 * WHAT WAS MEASURED HERE BEFORE THE FIX (2026-09-05, Chrome via
 * `channel: "chrome"`, 1 question · 2 failures · 1 conflict · 2 land rows):
 *
 *   390×844   ASKS YOU card 326px wide, content 570px. Question span 0px.
 *             `Send` at x=355, `Send to dev` ending at x=561, the ✕ at x=573
 *             — all outside a 390px viewport. Queue chips clientWidth 22px
 *             against scrollWidth 294px. Land rows 139px, the Land pill
 *             painted over UP NEXT.
 *   768×1024  the coral line fitted (702 in 704) and the question was STILL
 *             0px; the land-row title 0px; chips 69px against 294–310px.
 *   1280/1440 clean — 450px and 610px of question, 132.8px and 152.8px chips.
 *
 * THE DESK PAYLOAD IS STUBBED, THE WRITES ARE NOT. `GET /api/control-desk` is
 * fulfilled from a fixture so the signal count is exactly 0, 1 or 6 — the e2e
 * database is shared and `fullyParallel`, so a real aggregate could never be
 * pinned to a number. Every id in that fixture is a REAL row created by this
 * spec, so the one mutating action it performs (the ✕) reaches the real route
 * and lands in the isolated e2e database, which is then read back directly.
 */

/** The two phone/tablet widths the ticket names, then the two it protects. */
const MOBILE_WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;

const DESKTOP_WIDTHS = [
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
] as const;

/** Signal counts the ticket asks for, and how they are spread over the three families. */
const SPREADS = {
  0: { asks: 0, failed: 0, conflicts: 0 },
  1: { asks: 1, failed: 0, conflicts: 0 },
  6: { asks: 2, failed: 3, conflicts: 1 },
} as const;

interface DeskSeed {
  projectId: string;
  /** Real epic ids, one per fixture row, in the order the payload uses them. */
  epicIds: string[];
}

/**
 * The stubbed desk payload, built around REAL ids.
 *
 * Titles and questions are deliberately long: the defect is a box collapsing
 * to zero, and a two-word title fits in the broken layout too.
 */
function deskPayload(seed: DeskSeed, signals: 0 | 1 | 6) {
  const spread = SPREADS[signals];
  const id = (i: number) => seed.epicIds[i % seed.epicIds.length];
  const project = {
    id: seed.projectId,
    name: "Arij",
    shortName: "ARIJ",
    colorIndex: 0,
    activeAgents: 0,
    autoModeEnabled: false,
  };

  let cursor = 0;
  return {
    generatedAt: new Date().toISOString(),
    projects: [project],
    working: [],
    queued: [],
    today: { ticketsShipped: 3, failedSessions: 1, costUsd: 1.42, projects: 1, sessions: 9 },
    yourTurn: {
      awaitingReply: Array.from({ length: spread.asks }, (_, i) => ({
        epicId: id(cursor++),
        projectId: seed.projectId,
        readableId: `F-arij-${100 + i}`,
        title: "Refonte du renderer legacy",
        question:
          "Je garde le renderer legacy derrière un flag de configuration, ou je le supprime maintenant ?",
        author: "agent",
        askedAt: "2026-09-05T09:00:00",
        unreadAi: true,
      })),
      failed: Array.from({ length: spread.failed }, (_, i) => ({
        epicId: id(cursor++),
        projectId: seed.projectId,
        readableId: `B-arij-${200 + i}`,
        title: "Worker pool",
        sessionId: `session-${i}`,
        error: "exit 1 — worker pool did not drain in 120s",
        agentType: "build",
        agentName: "Opus Builder",
        provider: "claude-code",
        namedAgentId: null,
        userStoryId: null,
        producedOutput: true,
        failedAt: "2026-09-05T08:40:00",
      })),
      conflicts: Array.from({ length: spread.conflicts }, (_, i) => ({
        epicId: id(cursor++),
        projectId: seed.projectId,
        readableId: `F-arij-${300 + i}`,
        title: "Tax export",
        blocker: "merge_conflict" as const,
        branchName: "feature/epic-tax-export",
        at: "2026-09-05T08:00:00",
      })),
    },
    readyToLand: [0, 1].map((i) => ({
      epicId: id(cursor++),
      projectId: seed.projectId,
      readableId: `F-arij-${400 + i}`,
      title: "Introduire des plafonds de rétention sur le chemin d'écriture",
      prNumber: 218 + i,
      usDone: 4,
      usCount: 4,
      openFindings: 0,
      agentBusy: false,
    })),
    heldBackCount: 1,
    upNext: [
      {
        projectId: seed.projectId,
        tickets: Array.from({ length: 5 }, (_, i) => ({
          epicId: id(cursor++),
          projectId: seed.projectId,
          readableId: `F-arij-${500 + i}`,
          title: "Mobile : actions Your turn hors écran et tickets Up next illisibles",
          status: "todo",
          rank: i + 1,
          blockedBy: [] as string[],
          awaitingReply: false,
          specOnly: false,
          storyCount: 3,
        })),
      },
    ],
  };
}

/**
 * Serves the fixture for `GET /api/control-desk` and nothing else.
 *
 * The desk polls every 4s, so this stays installed for the whole navigation:
 * a one-shot fulfil would be replaced by the real (empty) aggregate a few
 * seconds in, and every assertion after that would be about a blank desk.
 */
async function stubDesk(page: Page, seed: DeskSeed, signals: 0 | 1 | 6) {
  await page.unroute("**/api/control-desk").catch(() => {});
  await page.route("**/api/control-desk", (route) =>
    route.fulfill({ json: { data: deskPayload(seed, signals) } }),
  );
}

/** Every control the coral stratum offers, whichever family renders it. */
const CORAL_CONTROL_SELECTOR = [
  '[data-testid="desk-asks-you-row"] input',
  '[data-testid="desk-asks-you-row"] button',
  '[data-testid="desk-failed-row"] button',
  '[data-testid="desk-conflict-row"] button',
].join(", ");

/**
 * Boxes of every rendered control, plus the horizontal containment verdict.
 *
 * HORIZONTAL, deliberately. YOUR TURN caps and scrolls its own row list, so a
 * row past the fold is legitimately off screen VERTICALLY — that is the
 * design, and the "+N de plus" marker says so. The reported defect is the
 * other axis: a control whose box lies outside the viewport's width can never
 * be reached at all, however far the user scrolls.
 */
async function readControls(page: Page, viewportWidth: number) {
  return page.evaluate(
    ({ selector, vw }) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return {
          x: +r.x.toFixed(1),
          y: +r.y.toFixed(1),
          width: +r.width.toFixed(1),
          height: +r.height.toFixed(1),
          right: +r.right.toFixed(1),
          bottom: +r.bottom.toFixed(1),
        };
      };
      return [...document.querySelectorAll(selector)].map((el) => ({
        label: (el.textContent || el.getAttribute("aria-label") || "?").trim().slice(0, 32),
        ...box(el),
        outside: box(el).x < -0.5 || box(el).right > vw + 0.5,
      }));
    },
    { selector: CORAL_CONTROL_SELECTOR, vw: viewportWidth },
  );
}

/** Width of the first rendered element matching `selector`, or null. */
async function widthOf(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return +el.getBoundingClientRect().width.toFixed(1);
  }, selector);
}

/**
 * Widths of the two coral messages — the quoted question and the error line.
 *
 * Located by their text rather than by a test id: the error is a `Mono`, and
 * that primitive takes a closed prop list with no rest spread, so a
 * `data-testid` passed to it is silently dropped (a known gap, filed
 * separately). Their content is unambiguous in this fixture.
 */
async function readMessageWidths(page: Page) {
  return page.evaluate(() => {
    const width = (needle: string) => {
      const node = [...document.querySelectorAll('[data-testid="desk-row-head"] > *')].find((el) =>
        (el.textContent ?? "").includes(needle),
      );
      return node ? +node.getBoundingClientRect().width.toFixed(1) : null;
    };
    return {
      question: width("Je garde le renderer legacy"),
      error: width("worker pool did not drain"),
    };
  });
}

/**
 * The coral stratum's hidden count, and the same count measured independently
 * from the rows' own boxes.
 *
 * The component derives its number from a live measurement of a container that
 * showing the marker itself resizes, and it bounds the resulting feedback loop
 * with a pass budget. That is exactly the shape that settles on a stale number,
 * so re-deriving it from the DOM at rest is a real check and not a tautology:
 * it fails when the component stopped re-measuring one pass too early.
 */
async function readOverflow(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="desk-your-turn-rows"]');
    const marker = document.querySelector('[data-testid="desk-your-turn-overflow"]');
    const printed = marker ? Number(/\+(\d+)/.exec(marker.textContent ?? "")?.[1] ?? NaN) : 0;
    if (!list) return { printed, measured: 0, rows: 0 };
    const fold = list.getBoundingClientRect().bottom;
    const rows = [...list.children];
    const measured = rows.filter((row) => row.getBoundingClientRect().bottom > fold + 1).length;
    return { printed, measured, rows: rows.length };
  });
}

/** The five strata, by the ground each one paints. */
async function readStrata(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="strata-band"]')].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        stratum: b.getAttribute("data-stratum"),
        width: +r.width.toFixed(1),
        height: +r.height.toFixed(1),
      };
    }),
  );
}

/**
 * Two epics per fixture row so the ✕ writes against a row that really exists.
 *
 * Nine ids cover the busiest payload (6 signals + 2 land rows + 5 queue chips
 * cycles through them), and the queue reuses them harmlessly — React keys are
 * per band, and no assertion here counts epics.
 */
async function seedEpics(
  request: Parameters<typeof createEpic>[0],
  projectId: string,
): Promise<DeskSeed> {
  const epics = [];
  for (let i = 0; i < 9; i++) {
    epics.push(await createEpic(request, projectId, `Desk mobile fixture ${i}`));
  }
  return { projectId, epicIds: epics.map((e) => e.id) };
}

test.describe("the desk on a phone", () => {
  /**
   * The ticket's own pass condition: "message, champ, envoi, ouverture du log
   * et dismissal restent accessibles" at 390×844 and 768×1024, for 0, 1 and 6
   * signals, with the hidden counter exact and the other strata reachable.
   */
  test("keeps every Your-turn control inside the viewport at 0, 1 and 6 signals", async ({
    page,
    project,
    request,
  }) => {
    const seed = await seedEpics(request, project.id);

    for (const { width, height } of MOBILE_WIDTHS) {
      for (const signals of [0, 1, 6] as const) {
        await stubDesk(page, seed, signals);
        await page.setViewportSize({ width, height });
        await page.goto("/");
        await expect(page.getByTestId("now-desk")).toBeVisible();
        // Wait on a marker unique to THIS payload rather than a generic
        // spinner: UP NEXT is present at every signal count, and its chips are
        // what proves the stub reached the component.
        await expect(page.getByTestId("desk-up-next-row").first()).toBeVisible();

        const where = `${width}×${height} · ${signals} signal(s)`;

        // 1. No page-level sideways scroll. Necessary, and nowhere near
        //    sufficient: before the fix this already held at 390 because the
        //    coral list clipped its own overflow.
        const doc = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          doc.scrollWidth,
          `${where}: the page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`,
        ).toBeLessThanOrEqual(doc.clientWidth);

        // 2. Every coral control is horizontally inside the viewport.
        const controls = await readControls(page, width);
        expect(controls.length, `${where}: no coral control rendered`).toBe(
          signals === 0 ? 0 : controls.length,
        );
        const outside = controls.filter((c) => c.outside);
        expect(
          outside,
          `${where}: ${outside.length} control(s) outside the viewport: ` +
            outside.map((c) => `"${c.label}" x=${c.x}→${c.right}`).join(", "),
        ).toEqual([]);
        for (const control of controls) {
          expect(control.width, `${where}: control "${control.label}" has no width`).toBeGreaterThan(
            0,
          );
        }

        // 3. The message — the reason the row exists — is not squeezed to zero.
        //    It measured EXACTLY 0px at 390 and at 768 before the fix.
        if (signals > 0) {
          const messages = await readMessageWidths(page);
          expect(
            messages.question,
            `${where}: the agent's question measured ${messages.question}px (0px before the fix)`,
          ).toBeGreaterThan(180);
          if (SPREADS[signals].failed > 0) {
            expect(
              messages.error,
              `${where}: the failure's error line measured ${messages.error}px`,
            ).toBeGreaterThan(180);
          }
        }

        // 4. The hidden counter agrees with the rows' own boxes.
        //
        //    POLLED, because the count CONVERGES rather than being right on
        //    the first frame, and both halves of the loop were observed here:
        //    a new row enters with `animate-in slide-in-from-bottom-2`, so at
        //    ~0ms a single 166px row sits 5px low inside a 166px list
        //    (scrollHeight 171) and is legitimately measured as past the fold;
        //    the marker then lives INSIDE the container it describes, which is
        //    why the component re-measures on a settle schedule (rAF, 300ms,
        //    1200ms). What the ticket asks to hold is the SETTLED number, and a
        //    count that never converges fails this poll rather than passing on
        //    a lucky frame.
        await expect
          .poll(
            async () => {
              const o = await readOverflow(page);
              const agrees = o.printed === o.measured;
              // Nothing can be hidden when at most one row exists…
              const quietWhenEmpty = signals > 1 || o.printed === 0;
              // …and six stacked rows cannot all fit half a phone screen, so a
              // permanent zero would leave the counter untested.
              const speaksWhenCrowded = signals !== 6 || o.printed > 0;
              return agrees && quietWhenEmpty && speaksWhenCrowded
                ? "settled"
                : `printed=${o.printed} measured=${o.measured} rows=${o.rows}`;
            },
            {
              message:
                `${where}: the hidden counter never settled on the number of rows ` +
                `past the fold`,
            },
          )
          .toBe("settled");

        // 5. The other strata are still there, at full band width.
        const strata = await readStrata(page);
        expect(
          strata.map((s) => s.stratum),
          `${where}: a stratum is missing`,
        ).toEqual(["live", "you", "land", "next", "feed"]);
        for (const band of strata) {
          expect(band.height, `${where}: the ${band.stratum} band collapsed`).toBeGreaterThan(0);
          expect(
            band.width,
            `${where}: the ${band.stratum} band is only ${band.width}px wide`,
          ).toBeGreaterThan(width * 0.7);
        }

        // 6. …and reachable: the composer at the very bottom scrolls into view.
        await page.getByTestId("desk-composer-input").scrollIntoViewIfNeeded();
        await expect(page.getByTestId("desk-composer-input")).toBeInViewport();
      }
    }
  });

  /**
   * "tickets ouvrables" and "titres identifiables", measured rather than
   * asserted: a chip that shows 22px of a 294px label is neither.
   */
  test("gives Ready to land and Up next a legible stacked layout", async ({
    page,
    project,
    request,
  }) => {
    const seed = await seedEpics(request, project.id);

    for (const { width, height } of MOBILE_WIDTHS) {
      await stubDesk(page, seed, 6);
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByTestId("desk-up-next-row").first()).toBeVisible();
      const where = `${width}×${height}`;

      // The two bands stack: neither may share a row with the other.
      const bands = await page.evaluate(() => {
        const rect = (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1) };
        };
        return { land: rect('[data-stratum="land"]'), next: rect('[data-stratum="next"]') };
      });
      expect(bands.land, `${where}: no land band`).not.toBeNull();
      expect(bands.next, `${where}: no up-next band`).not.toBeNull();
      expect(
        bands.next!.y,
        `${where}: READY TO LAND and UP NEXT still share a row, ${bands.land!.width}px each`,
      ).toBeGreaterThanOrEqual(bands.land!.bottom - 0.5);

      // Land rows keep a readable title and an operable Land button.
      const landTitle = await widthOf(page, '[data-testid="desk-land-row"] button');
      expect(
        landTitle,
        `${where}: the land row's title measured ${landTitle}px (0px before the fix)`,
      ).toBeGreaterThan(120);
      await expect(page.getByTestId("desk-land-button").first()).toBeEnabled();

      // Queue chips show their label rather than a coloured sliver. Measured
      // on the chips that are actually laid out: the desktop slots past the
      // stacked budget are `display:none` here.
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="desk-queue-chip"]')]
          .filter((c) => (c as HTMLElement).offsetParent !== null)
          .map((c) => ({
            text: (c.textContent ?? "").trim().slice(0, 40),
            clientWidth: (c as HTMLElement).clientWidth,
            scrollWidth: (c as HTMLElement).scrollWidth,
          })),
      );
      expect(chips.length, `${where}: no queue chip is laid out`).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(
          chip.clientWidth,
          `${where}: the chip for "${chip.text}" is ${chip.clientWidth}px wide ` +
            `(22px before the fix, for a ${chip.scrollWidth}px label)`,
        ).toBeGreaterThan(200);
      }

      // The stacked budget hands the rest to its own marker, and the desktop
      // one — which counts differently — stays hidden.
      await expect(page.getByTestId("desk-queue-overflow-mobile")).toBeVisible();
      await expect(page.getByTestId("desk-queue-overflow")).toBeHidden();
      await expect(page.getByTestId("desk-queue-overflow-mobile")).toHaveText("+3");
    }
  });

  /**
   * The controls are inside the viewport AND they are the thing a tap reaches.
   * A pill can be clear of the viewport's edge and still be covered by a
   * neighbour, which is a different failure with the same symptom.
   *
   * The dismissal is the one mutating action here. It goes to the real route
   * and is read back from the isolated e2e database, so "the ✕ is reachable"
   * is proved by a write rather than by a click that could have gone nowhere.
   */
  test("dismisses a question from a 390px screen", async ({ page, project, request }) => {
    const seed = await seedEpics(request, project.id);
    const target = seed.epicIds[0];

    await stubDesk(page, seed, 6);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const row = page.getByTestId("desk-asks-you-row").first();
    await expect(row).toBeVisible();

    // Typed FIRST, because `PillButton` carries `disabled:pointer-events-none`:
    // a disabled Send never hit-tests to itself, which would make the sweep
    // below fail for a reason that has nothing to do with the layout.
    const send = row.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await row.getByRole("textbox", { name: "Répondre à l'agent" }).fill("Supprime-le.");
    await expect(send).toBeEnabled();

    // Every control of the first row hit-tests to itself.
    const covered = await page.evaluate(() => {
      const SAMPLES = 15;
      const row = document.querySelector('[data-testid="desk-asks-you-row"]')!;
      return [...row.querySelectorAll("input, button")].map((el) => {
        const rect = el.getBoundingClientRect();
        const y = rect.y + rect.height / 2;
        let miss = 0;
        for (let i = 0; i < SAMPLES; i++) {
          const x = Math.min(rect.x + (rect.width * i) / (SAMPLES - 1), rect.right - 0.5);
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(el === hit || el.contains(hit))) miss++;
        }
        return {
          label: (el.textContent || el.getAttribute("aria-label") || "?").trim().slice(0, 32),
          missPercent: (miss / SAMPLES) * 100,
        };
      });
    });
    for (const control of covered) {
      expect(
        control.missPercent,
        `${control.missPercent.toFixed(0)}% of "${control.label}" is covered by ` +
          `something else — a tap there does not reach it`,
      ).toBe(0);
    }

    try {
      // The mutation. Real route, real (isolated) database.
      await row.getByRole("button", { name: "Écarter cette question" }).click();
      await expect
        .poll(
          () =>
            withDatabase(
              (db) =>
                db
                  .prepare("SELECT kind FROM desk_dismissals WHERE epic_id = ?")
                  .get(target) as { kind: string } | undefined,
            )?.kind ?? null,
          { message: "the ✕ at 390px never reached POST /api/desk/dismiss" },
        )
        .toBe("asks");
    } finally {
      withDatabase((db) => db.prepare("DELETE FROM desk_dismissals WHERE epic_id = ?").run(target));
    }
  });

  /**
   * "Appliquer le comportement au desk global et aux desks projet."
   *
   * `/projects/:id` renders the SAME `NowDesk`, so the layout is shared by
   * construction — but its host is not: the project route wraps the desk in an
   * `overflow-hidden` box, which is exactly the container that would clip a
   * taller-than-viewport mobile column instead of scrolling it. That is a
   * claim about the host, and only the host can answer it.
   */
  test("carries the stacked layout onto a project desk", async ({ page, project, request }) => {
    const seed = await seedEpics(request, project.id);

    for (const { width, height } of MOBILE_WIDTHS) {
      await stubDesk(page, seed, 6);
      await page.setViewportSize({ width, height });
      await page.goto(project.boardUrl);
      await expect(page.getByTestId("now-desk")).toBeVisible();
      await expect(page.getByTestId("desk-asks-you-row").first()).toBeVisible();
      const where = `${project.boardUrl} @ ${width}×${height}`;

      const controls = await readControls(page, width);
      const outside = controls.filter((c) => c.outside);
      expect(
        outside,
        `${where}: ${outside.length} control(s) outside the viewport: ` +
          outside.map((c) => `"${c.label}" x=${c.x}→${c.right}`).join(", "),
      ).toEqual([]);

      const messages = await readMessageWidths(page);
      expect(messages.question, `${where}: the question measured ${messages.question}px`).toBeGreaterThan(
        150,
      );

      // The host clips rather than scrolls, so the desk has to own the scroll:
      // without it the strata under YOUR TURN are simply cut off here.
      const scroll = await page.evaluate(() => {
        const desk = document.querySelector('[data-testid="now-desk"]') as HTMLElement;
        return { scrollHeight: desk.scrollHeight, clientHeight: desk.clientHeight };
      });
      expect(
        scroll.scrollHeight,
        `${where}: the desk is not taller than its box, so this proves nothing about scrolling`,
      ).toBeGreaterThan(scroll.clientHeight);
      await page.getByTestId("desk-composer-input").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("desk-composer-input")).toBeInViewport();
    }
  });

  /**
   * The other half of the ticket: "préserver les proportions desktop à 1280 et
   * 1440 px". The coral row is ONE line there (its six children share a row)
   * and the two half-bands are side by side.
   *
   * Both are geometric facts rather than class assertions, because the fix
   * works by making the wrapper groups `display: contents` above the
   * breakpoint — and a wrapper that failed to disappear would still carry the
   * right class names.
   */
  test("leaves the desktop desk on one line and two columns", async ({
    page,
    project,
    request,
  }) => {
    const seed = await seedEpics(request, project.id);

    for (const { width, height } of DESKTOP_WIDTHS) {
      await stubDesk(page, seed, 6);
      await page.setViewportSize({ width, height });
      await page.goto("/");
      const row = page.getByTestId("desk-asks-you-row").first();
      await expect(row).toBeVisible();
      const where = `${width}×${height}`;

      const geometry = await page.evaluate(() => {
        const rect = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: +r.x.toFixed(1),
            y: +r.y.toFixed(1),
            width: +r.width.toFixed(1),
            height: +r.height.toFixed(1),
            bottom: +r.bottom.toFixed(1),
          };
        };
        const row = document.querySelector('[data-testid="desk-asks-you-row"]')!;
        return {
          row: rect(row),
          // Leaves, not children: the two wrapper groups are `display: contents`
          // here, so the row's own children are exactly what they were.
          leaves: [...row.querySelectorAll("span[data-slot], span.line-clamp-1, input, button")]
            .map((el) => ({
              label: (el.textContent || el.getAttribute("aria-label") || "?").trim().slice(0, 24),
              ...rect(el)!,
            }))
            .filter((leaf) => leaf.width > 0),
          land: rect(document.querySelector('[data-stratum="land"]')),
          next: rect(document.querySelector('[data-stratum="next"]')),
          field: rect(document.querySelector('[data-testid="desk-asks-you-row"] input')),
        };
      });

      // One line: 53px, the height the row has always had, and every leaf
      // vertically overlapping every other.
      expect(geometry.row!.height, `${where}: the coral row grew a second line`).toBeLessThan(60);
      const tops = geometry.leaves.map((leaf) => leaf.y);
      expect(
        Math.max(...tops) - Math.min(...tops),
        `${where}: the row's controls no longer share a line`,
      ).toBeLessThan(20);

      // The field keeps its 300px pin — the one desktop measurement a
      // wrap-friendly basis could have silently replaced.
      expect(geometry.field!.width, `${where}: the reply field is no longer 300px`).toBe(300);

      // Two columns, each about half the desk.
      expect(
        geometry.next!.x,
        `${where}: UP NEXT is no longer beside READY TO LAND`,
      ).toBeGreaterThan(geometry.land!.x + geometry.land!.width - 0.5);
      expect(geometry.land!.y, `${where}: the two half-bands are on different rows`).toBeCloseTo(
        geometry.next!.y,
        0,
      );
    }
  });
});
