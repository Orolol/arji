import { createEpic, expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-iL4-FmyXgGr — on a phone, a finding's actions are laid out past the
 * right edge of the screen.
 *
 * MEASURED IN CHROME by this spec against the unfixed screen (2026-09-05, one
 * epic, three seeded findings, a named reviewer, a 74-character path). The
 * blocking row at 320 / 390 / 414px, identically — the row was 717px wide
 * whatever the screen was:
 *   Fix with agent  x=480 → 603
 *   Diff            x=615 → 664
 *   Dismiss         x=676 → 748
 *   description     0.0px
 * At 768px the pills were back inside the screen and the description was still
 * 0px; 1024 / 1280 / 1440 were clean. The report's own figures (407/468/553)
 * are the same defect on its own data.
 *
 * The row is one `flex items-center` line whose stamp, id chip, reviewer meta
 * and three `shrink-0` pills add up to more than a phone is wide, so the pills
 * are simply placed off-screen. They are the ONLY way to act on a blocking
 * finding.
 *
 * WHAT THIS SPEC PROVES that `__tests__/qa-mobile-layout.test.tsx` cannot:
 * jsdom has no layout engine and never loads Tailwind, so the unit file can
 * only pin the MARKUP that produced the defect. Whether a button is actually
 * inside the viewport, whether its tap point is reachable, whether the row is
 * tall enough to read and whether anything scrolls sideways are visual claims
 * and need a real browser.
 *
 * NO AGENT IS DISPATCHED. `Fix with agent` is measured and asserted operable,
 * never clicked — clicking it POSTs to the epic build route. The one click
 * this spec makes is `Dismiss`, which opens a local dialog; it is cancelled
 * with Escape and writes nothing.
 */

/** The band this fix has to hold across, not the single width of the report. */
const WIDTHS = [320, 390, 414, 768, 1024, 1280, 1440] as const;

/** The three the ticket names explicitly, captured as evidence. */
const SCREENSHOT_WIDTHS = new Set([390, 1280, 1440]);

/**
 * A description far longer than the row can draw, and a path deep enough to
 * be the widest thing in it — the ticket's second criterion is that neither
 * pushes a control out of the viewport.
 */
const LONG_TEXT =
  "Le token MCP est écrit en clair dans le journal de session quand le " +
  "processus fils meurt avant d'avoir répondu, ce qui expose la clé à toute " +
  "personne capable de lire le répertoire data/sessions du poste, et le " +
  "correctif doit aussi couvrir la voie de secours qui rejoue le prompt.";
const LONG_PATH =
  "lib/providers/claude-code/session/mcp/injection/temporary-configuration.ts";

/** Every button a row may draw, by the test id the row exposes. */
const ACTION_IDS = ["qa-finding-fix", "qa-finding-diff", "qa-finding-dismiss"] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RowGeometry {
  /** The row's own marker, so a failure names which finding broke. */
  marker: string;
  actions: Array<{ id: string; box: Box }>;
  /** The description cell — the thing the fixed-width siblings squeeze. */
  text: Box | null;
  /** The card itself: a row crushed to a sliver is as unusable as one off-screen. */
  box: Box;
}

interface PageGeometry {
  scrollWidth: number;
  clientWidth: number;
  /** `scrollWidth`/`clientWidth` of the scrolling findings list. */
  listScrollWidth: number;
  listClientWidth: number;
  rows: RowGeometry[];
  filters: Array<{ id: string; box: Box }>;
}

/**
 * Reads the geometry of this spec's own rows only.
 *
 * `/qa` is the cross-project screen and the suite runs four workers, so other
 * tests' findings can share the band. Scoping by marker keeps the assertions
 * about the rows this test seeded; the page-level overflow check below is
 * deliberately global, because a sideways-scrolling page is a defect whoever
 * caused it.
 */
/**
 * Every row enters with `animate-in fade-in slide-in-from-bottom-2`, an 8px
 * translate. A geometry read taken mid-animation reports the row several
 * pixels below where it lands, which is a measurement of the animation rather
 * than of the layout — it cost this spec a 3-to-5px phantom failure.
 *
 * THE INFINITE ONES ARE SKIPPED. A live QA run breathes: `BreathingDot` and
 * `crawl-fill` run forever by design, so "wait for every animation to stop"
 * never returns on a busy screen. Only the finite ones settle, and they are
 * the ones that move a box.
 */
async function settle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const iterations = animation.effect?.getTiming().iterations ?? 1;
      return iterations === Infinity || animation.playState !== "running";
    }),
  );
}

async function readGeometry(page: import("@playwright/test").Page, markers: string[]) {
  return page.evaluate((ownMarkers: string[]): PageGeometry => {
    const box = (element: Element | null | undefined): Box => {
      const rect = (element as Element).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const list = document.querySelector('[data-testid="qa-findings-list"]');
    const rows = Array.from(
      document.querySelectorAll('[data-testid="qa-finding-row"]'),
    ).flatMap((row): RowGeometry[] => {
      const content = row.textContent ?? "";
      const marker = ownMarkers.find((candidate) => content.includes(candidate));
      if (!marker) return [];
      const actions = ["qa-finding-fix", "qa-finding-diff", "qa-finding-dismiss"]
        .map((id) => ({ id, element: row.querySelector(`[data-testid="${id}"]`) }))
        .filter((entry) => entry.element !== null)
        .map((entry) => ({ id: entry.id, box: box(entry.element) }));
      // The test id is what the fixed row exposes; the direct-child lookup is
      // what makes the SAME spec measurable against the unfixed row, where the
      // description cell carries no id at all.
      const textElement =
        row.querySelector('[data-testid="qa-finding-text"]') ??
        Array.from(row.children).find(
          (child) =>
            child.tagName === "SPAN" && (child.textContent ?? "").includes(marker),
        ) ??
        null;
      return [
        {
          marker,
          actions,
          text: textElement ? box(textElement) : null,
          box: box(row),
        },
      ];
    });

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      listScrollWidth: list ? list.scrollWidth : 0,
      listClientWidth: list ? list.clientWidth : 0,
      rows,
      filters: ["qa-filter-all", "qa-filter-blocking", "qa-filter-security"]
        .map((id) => ({ id, element: document.querySelector(`[data-testid="${id}"]`) }))
        .filter((entry) => entry.element !== null)
        .map((entry) => ({ id: entry.id, box: box(entry.element) })),
    };
  }, markers);
}

test("keeps every finding action inside the viewport, from 320px to 1440px", async ({
  page,
  project,
  request,
}, testInfo) => {
  const epic = await createEpic(
    request,
    project.id,
    "QA mobile — findings actions",
    "Seeded by e2e/qa-findings-responsive.spec.ts",
  );

  /** Unique per worker: the band is cross-project and shared with the suite. */
  const stamp = `w${testInfo.workerIndex}-${Date.now()}`;
  const markers = {
    blocking: `MARK-BLOCKING-${stamp}`,
    major: `MARK-MAJOR-${stamp}`,
    minor: `MARK-MINOR-${stamp}`,
  };
  const sessionId = `qaresp_${stamp}`;

  withDatabase((db) => {
    // A real filing session, so the row's reviewer meta is a named agent
    // rather than the em-dash a session-less finding prints. `Sentinelle
    // Sécurité` is deliberately long: the meta is one of the fixed-width
    // items competing with the buttons for the row.
    db.prepare(
      `INSERT INTO agent_sessions (id, project_id, epic_id, status, agent_type, named_agent_name, review_verdict, created_at, completed_at)
       VALUES (?, ?, ?, 'completed', 'review_security', 'Sentinelle Sécurité', 'changes_requested', ?, ?)`,
    ).run(sessionId, project.id, epic.id, "2026-09-01T09:00:00Z", "2026-09-01T09:05:00Z");

    const insert = db.prepare(
      `INSERT INTO review_comments (id, epic_id, file_path, line_number, body, author, status, agent_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'agent', 'open', ?, ?)`,
    );
    insert.run(
      `f_blocking_${stamp}`,
      epic.id,
      LONG_PATH,
      2140,
      `[critical] ${markers.blocking} ${LONG_TEXT}`,
      sessionId,
      "2026-09-01T09:06:00Z",
    );
    insert.run(
      `f_major_${stamp}`,
      epic.id,
      LONG_PATH,
      88,
      `[major] ${markers.major} ${LONG_TEXT}`,
      sessionId,
      "2026-09-01T09:07:00Z",
    );
    insert.run(
      `f_minor_${stamp}`,
      epic.id,
      "app/api/qa/findings/route.ts",
      31,
      `[minor] ${markers.minor} ${LONG_TEXT}`,
      sessionId,
      "2026-09-01T09:08:00Z",
    );
  });

  const ownMarkers = Object.values(markers);
  const failures: string[] = [];

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/qa");

    // The rows come from a poll of /api/qa/findings; wait for all three of
    // THIS test's rows so the band is measured at its real width.
    //
    // ON THE ROW, NOT ON THE TEXT. `toBeVisible()` on the description cell
    // reports `hidden` at 320px on the unfixed row — the cell is squeezed to
    // zero width — which would end the test on the wait instead of on the
    // measurement it exists to take.
    for (const marker of ownMarkers) {
      await expect(
        page.getByTestId("qa-finding-row").filter({ hasText: marker }),
      ).toHaveCount(1);
    }

    await settle(page);
    const geometry = await readGeometry(page, ownMarkers);
    const at = `${width}px`;

    expect(
      geometry.rows.map((row) => row.marker).sort(),
      `${at}: the three seeded rows were not all measured`,
    ).toEqual([...ownMarkers].sort());

    if (geometry.scrollWidth > geometry.clientWidth + 0.5) {
      failures.push(
        `${at}: the page scrolls sideways — documentElement.scrollWidth ` +
          `${geometry.scrollWidth} vs clientWidth ${geometry.clientWidth}`,
      );
    }

    // A button reachable only by scrolling the band sideways is not reachable:
    // the list is `overflow-y-auto`, which makes its overflow-x `auto` too, so
    // an over-wide row hides inside it without touching the page's scrollWidth.
    if (geometry.listScrollWidth > geometry.listClientWidth + 0.5) {
      failures.push(
        `${at}: the findings list scrolls sideways — scrollWidth ` +
          `${geometry.listScrollWidth} vs clientWidth ${geometry.listClientWidth}`,
      );
    }

    for (const row of geometry.rows) {
      // The other half of the report: the row does not solve its width problem
      // by crushing the finding out of existence. 120px is roughly the
      // narrowest a 13.5px description can be and still say anything.
      if (row.box.height < 40) {
        failures.push(
          `${at}: ${row.marker} is ${row.box.height.toFixed(1)}px tall — the row ` +
            `was crushed, not folded`,
        );
      }

      if (row.text === null) {
        failures.push(`${at}: no description cell found on ${row.marker}`);
      } else if (row.text.width < 120) {
        failures.push(
          `${at}: the description of ${row.marker} is ${row.text.width.toFixed(1)}px ` +
            `wide — the fixed-width siblings took the row`,
        );
      }

      for (const action of row.actions) {
        const right = action.box.x + action.box.width;
        if (action.box.x < -0.5 || right > geometry.clientWidth + 0.5) {
          failures.push(
            `${at}: ${action.id} of ${row.marker} is outside the viewport — ` +
              `x=${action.box.x.toFixed(1)} right=${right.toFixed(1)} ` +
              `viewport=${geometry.clientWidth}`,
          );
        }
        // Touch: the pill has to keep its own height, not be squashed to a
        // sliver by a row that ran out of room.
        if (action.box.height < 24 || action.box.width < 24) {
          failures.push(
            `${at}: ${action.id} of ${row.marker} is too small to tap — ` +
              `${action.box.width.toFixed(1)}×${action.box.height.toFixed(1)}`,
          );
        }
      }
    }

    // The minor row offers Dismiss only; the two heavy rows offer all three.
    const byMarker = new Map(geometry.rows.map((row) => [row.marker, row]));
    expect(
      byMarker.get(markers.blocking)?.actions.map((action) => action.id),
      `${at}: the blocking row lost one of its three actions`,
    ).toEqual([...ACTION_IDS]);
    expect(
      byMarker.get(markers.minor)?.actions.map((action) => action.id),
      `${at}: the minor row should offer Dismiss and nothing else`,
    ).toEqual(["qa-finding-dismiss"]);

    // The filters are the other control the ticket names.
    for (const filter of geometry.filters) {
      const right = filter.box.x + filter.box.width;
      if (filter.box.x < -0.5 || right > geometry.clientWidth + 0.5) {
        failures.push(
          `${at}: ${filter.id} is outside the viewport — x=` +
            `${filter.box.x.toFixed(1)} right=${right.toFixed(1)}`,
        );
      }
    }

    if (SCREENSHOT_WIDTHS.has(width)) {
      await page.screenshot({
        path: testInfo.outputPath(`qa-findings-${width}.png`),
        fullPage: true,
      });
    }
  }

  expect(failures, `finding actions off-screen:\n${failures.join("\n")}`).toEqual([]);
});

/**
 * The ticket's fourth criterion, on a screen with something in every band.
 *
 * The findings band is not alone on 11b: QA RUNS draws a three-column grid and
 * the bottom split draws two. A grid column's implicit `min-width: auto` does
 * not shrink below its content, so those are the other two places the screen
 * can push a control out of reach on a phone — and a band that overflows
 * itself is the same defect as the row that started this ticket.
 *
 * VERDICTS RÉCENTS IS SEEDED HERE, and that seeding is part of the fix for
 * B-arij-S3gpcD1w-ZEB. The band is workspace-wide, so this test used to draw
 * whatever verdicts the rest of the suite happened to have left in the shared
 * database: alone it drew an empty band and passed, and under `--workers=4` it
 * drew another spec's rows and failed. A band this test does not populate is
 * not a band this test measures — the seeded review below is what makes the
 * 26px overflow (`scrollWidth` 318 vs `clientWidth` 292 at 320px) reproduce on
 * its own, whatever else is running.
 */
test("keeps every band inside the phone screen when the whole screen is busy", async ({
  page,
  project,
  request,
}, testInfo) => {
  const epic = await createEpic(
    request,
    project.id,
    "QA mobile — a busy screen",
    "Seeded by e2e/qa-findings-responsive.spec.ts",
  );

  const stamp = `w${testInfo.workerIndex}-${Date.now()}`;
  const marker = `MARK-BUSY-${stamp}`;

  withDatabase((db) => {
    const session = db.prepare(
      `INSERT INTO agent_sessions (id, project_id, epic_id, status, agent_type, named_agent_name, last_non_empty_text, started_at, created_at)
       VALUES (?, ?, ?, ?, 'review_feature', ?, ?, ?, ?)`,
    );
    // Two live reviews and one queued: the runs grid draws a card per live
    // session plus the queued tile, which is its widest state.
    session.run(
      `qabusy_run1_${stamp}`,
      project.id,
      epic.id,
      "running",
      "Relecteur Fonctionnel",
      "Analyse de lib/providers/claude-code/session/mcp/injection/temporary-configuration.ts",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    session.run(
      `qabusy_run2_${stamp}`,
      project.id,
      epic.id,
      "running",
      "Sentinelle Sécurité",
      "Relecture du chemin de secours qui rejoue le prompt",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    session.run(
      `qabusy_queued_${stamp}`,
      project.id,
      epic.id,
      "queued",
      "Relecteur Fonctionnel",
      null,
      null,
      new Date().toISOString(),
    );

    // The verdict this screen's fourth band draws, and the widest row it can
    // draw: a `completed` ordinary review carrying a structured verdict, on an
    // epic whose status is still `backlog`, so `outcomeArrow` returns the
    // longest of the three arrows ("→ your turn"). The readable id beside it is
    // `E-<slug≤20>-NNN` — 26 characters of Space Mono, 173px — because the
    // fixture names a project after this test's own title.
    db.prepare(
      `INSERT INTO agent_sessions (id, project_id, epic_id, status, agent_type, named_agent_name, review_verdict, started_at, completed_at, created_at)
       VALUES (?, ?, ?, 'completed', 'review_feature', ?, 'changes_requested', ?, ?, ?)`,
    ).run(
      `qabusy_verdict_${stamp}`,
      project.id,
      epic.id,
      "Relecteur Fonctionnel",
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO review_comments (id, epic_id, file_path, line_number, body, author, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'agent', 'open', ?)`,
    ).run(
      `f_busy_${stamp}`,
      epic.id,
      LONG_PATH,
      2140,
      `[critical] ${marker} ${LONG_TEXT}`,
      "2026-09-01T09:06:00Z",
    );
  });

  const failures: string[] = [];

  for (const width of [320, 390, 768] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/qa");
    await expect(
      page.getByTestId("qa-finding-row").filter({ hasText: marker }),
    ).toHaveCount(1);
    await expect(page.getByTestId("qa-runs-grid")).toBeVisible();
    // At least one — the band is workspace-wide and capped at six, so the
    // number of rows belongs to the whole suite. What this test owns is that
    // the band is not empty, which is what makes the measurement below mean
    // anything.
    await expect(page.getByTestId("qa-verdict-row").first()).toBeVisible();
    await settle(page);

    const overflow = await page.evaluate(() => {
      const bands = Array.from(
        document.querySelectorAll('[data-slot="strata-band"]'),
      ).map((band) => ({
        label:
          band.querySelector('[data-slot="band-label"]')?.textContent ?? "?",
        scrollWidth: band.scrollWidth,
        clientWidth: band.clientWidth,
      }));
      const list = document.querySelector('[data-testid="qa-findings-list"]');
      const row = document.querySelector('[data-testid="qa-finding-row"]');
      return {
        page: {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        },
        bands,
        list: list
          ? { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight }
          : null,
        rowHeight: row ? row.getBoundingClientRect().height : 0,
      };
    });

    /**
     * THE OTHER WAY TO LOSE THE ACTIONS, and the one the first attempt at this
     * fix walked straight into: the coral band is the one band on 11b that
     * grows, which on a phone means it is handed whatever the taller bands
     * leave — nothing. The row was then drawn inside a zero-height scroller,
     * every rectangle in the test above still correct and the screen still
     * unusable. On a phone the band draws its rows in full and the PAGE
     * scrolls.
     */
    if (overflow.rowHeight < 40) {
      failures.push(
        `${width}px: a finding row is ${overflow.rowHeight.toFixed(1)}px tall — ` +
          `the band was crushed rather than folded`,
      );
    }
    if (
      overflow.list &&
      overflow.list.scrollHeight > overflow.list.clientHeight + 1
    ) {
      failures.push(
        `${width}px: the findings list hides ` +
          `${(overflow.list.scrollHeight - overflow.list.clientHeight).toFixed(0)}px ` +
          `of rows inside its own scroller instead of letting the page scroll`,
      );
    }

    if (overflow.page.scrollWidth > overflow.page.clientWidth + 0.5) {
      failures.push(
        `${width}px: the page scrolls sideways — ${overflow.page.scrollWidth} ` +
          `vs ${overflow.page.clientWidth}`,
      );
    }
    for (const band of overflow.bands) {
      if (band.scrollWidth > band.clientWidth + 0.5) {
        failures.push(
          `${width}px: the ${band.label} band overflows itself — scrollWidth ` +
            `${band.scrollWidth} vs clientWidth ${band.clientWidth}`,
        );
      }
    }

    if (width === 390) {
      await page.screenshot({
        path: testInfo.outputPath("qa-busy-390.png"),
        fullPage: true,
      });
    }
  }

  expect(failures, `bands overflowing:\n${failures.join("\n")}`).toEqual([]);
});

test("lets a phone user work the actions by touch and by keyboard", async ({
  page,
  project,
  request,
}, testInfo) => {
  const epic = await createEpic(
    request,
    project.id,
    "QA mobile — findings actions, operable",
    "Seeded by e2e/qa-findings-responsive.spec.ts",
  );

  const stamp = `w${testInfo.workerIndex}-${Date.now()}`;
  const marker = `MARK-OPERABLE-${stamp}`;

  withDatabase((db) => {
    db.prepare(
      `INSERT INTO review_comments (id, epic_id, file_path, line_number, body, author, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'agent', 'open', ?)`,
    ).run(
      `f_operable_${stamp}`,
      epic.id,
      LONG_PATH,
      2140,
      `[critical] ${marker} ${LONG_TEXT}`,
      "2026-09-01T09:06:00Z",
    );
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/qa");

  const row = page
    .getByTestId("qa-finding-row")
    .filter({ hasText: marker });
  await expect(row).toHaveCount(1);

  /**
   * MEASURED BEFORE ANY INTERACTION, and this is the whole point.
   *
   * `click()` and `focus()` both scroll the target into view first — including
   * SIDEWAYS inside the band, which is `overflow-y-auto` and therefore
   * `overflow-x: auto`. An off-screen pill is duly scrolled to and pressed, so
   * a spec that only clicks passes on the broken row and proves nothing but
   * Playwright's ability to scroll. What a phone user has is the untouched
   * screen, which is what this reads.
   */
  await settle(page);
  const resting = await readGeometry(page, [marker]);
  expect(resting.rows, "the seeded row was not measured").toHaveLength(1);
  for (const action of resting.rows[0].actions) {
    const right = action.box.x + action.box.width;
    expect(
      action.box.x >= -0.5 && right <= resting.clientWidth + 0.5,
      `${action.id} sits outside the 390px screen before anything is scrolled: ` +
        `x=${action.box.x.toFixed(1)} right=${right.toFixed(1)}`,
    ).toBe(true);
  }

  // TOUCH. `click()` refuses an element another one covers, so this is the
  // reachability claim on top of the rectangles above. Dismiss is the only
  // safe one to press: it opens a local dialog and writes nothing until the
  // reason is confirmed.
  await row.getByTestId("qa-finding-dismiss").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("qa-dismiss-dialog-390.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // KEYBOARD. `Fix with agent` is never clicked — it dispatches a build — so
  // its keyboard reachability is asserted by focusing it and checking that
  // taking focus did not have to drag the band sideways to show it.
  for (const id of ACTION_IDS) {
    const button = row.getByTestId(id);
    await expect(button).toBeEnabled();
    await button.focus();
    const focused = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const list = document.querySelector('[data-testid="qa-findings-list"]');
      return {
        isActive: document.activeElement === element,
        left: rect.left,
        right: rect.right,
        viewport: document.documentElement.clientWidth,
        listScrollLeft: list ? list.scrollLeft : 0,
      };
    });
    expect(focused.isActive, `${id} did not take focus`).toBe(true);
    expect(
      focused.left >= -0.5 && focused.right <= focused.viewport + 0.5,
      `${id} takes focus outside the viewport: left=${focused.left.toFixed(1)} ` +
        `right=${focused.right.toFixed(1)} viewport=${focused.viewport}`,
    ).toBe(true);
    expect(
      focused.listScrollLeft,
      `focusing ${id} scrolled the findings band sideways by ` +
        `${focused.listScrollLeft}px, which is what an off-screen control does`,
    ).toBe(0);
  }

  // The filters, from the same phone.
  for (const id of ["qa-filter-all", "qa-filter-blocking", "qa-filter-security"]) {
    await page.getByTestId(id).click();
  }
  await page.getByTestId("qa-filter-all").click();
  await expect(row).toBeVisible();
});
