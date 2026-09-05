import { createEpic, expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-DWd1DEARyLMe — /inbox headed a list of 55 rows with "Agents waiting
 * on you" and "55 waiting", while most of those rows were unread reports on
 * tickets that had already been merged. The rows belong there; the wording
 * turned every one of them into a blocked agent.
 *
 * WHAT THIS SPEC PROVES that __tests__/inbox-page.test.tsx cannot: jsdom has
 * no layout engine and never loads Tailwind, so the unit file pins the words
 * and the markup and nothing else. Whether the two counters are actually on
 * the screen, whether the composer and the "Mark as read" button of a report
 * are reachable on a phone, and whether the page scrolls sideways are visual
 * claims that need a real browser at real widths.
 *
 * NO AGENT IS DISPATCHED and NO TICKET STATUS IS TOUCHED by the app. The one
 * mutation this spec makes through the UI is "Mark as read", which moves the
 * epic's read cursor (POST /api/inbox/read) and nothing else — the spec reads
 * the epic's status back out of the database afterwards to prove it. The
 * question's row does draw "Send to Dev" (its ticket is `in_progress`, which
 * is buildable); it is measured for reach and never clicked, because clicking
 * it POSTs to the epic build route.
 */

/** Phone, tablet and desktop — the two ends the ticket names, plus the middle. */
const WIDTHS = [390, 768, 1440] as const;

/** The evidence captured for the ticket. */
const SCREENSHOT_WIDTHS = new Set([390, 1440]);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RowGeometry {
  epicId: string;
  box: Box;
  /** Every control the row draws, by test id. */
  controls: Array<{ id: string; box: Box }>;
  badges: string[];
  placeholder: string | null;
}

interface PageGeometry {
  scrollWidth: number;
  clientWidth: number;
  /** Text of the headline counters, absent when the category is empty. */
  unreadCounter: { text: string; box: Box } | null;
  awaitingCounter: { text: string; box: Box } | null;
  subtitle: string | null;
  /** How many rows on the whole page carry the awaiting-reply flag. */
  awaitingBadgesOnPage: number;
  rows: RowGeometry[];
}

/**
 * Reads the page chrome plus the geometry of this spec's own rows.
 *
 * /inbox is cross-project and the suite runs four workers, so other specs'
 * tickets share the list. Row assertions are scoped by epic id; the sideways
 * overflow check is deliberately global, because a page that scrolls sideways
 * is a defect whoever put the row there.
 */
async function readGeometry(
  page: import("@playwright/test").Page,
  epicIds: string[]
): Promise<PageGeometry> {
  return page.evaluate((ids: string[]): PageGeometry => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const counter = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!element) return null;
      return { text: element.textContent?.trim() ?? "", box: box(element) };
    };

    const rows: RowGeometry[] = [];
    for (const epicId of ids) {
      const row = document.querySelector(`[data-testid="inbox-item-${epicId}"]`);
      if (!row) continue;
      const controls: Array<{ id: string; box: Box }> = [];
      for (const prefix of [
        "inbox-item-link",
        "inbox-reply-input",
        "inbox-reply-send",
        "inbox-mark-read",
        "inbox-send-to-dev",
      ]) {
        const control = row.querySelector(`[data-testid="${prefix}-${epicId}"]`);
        if (control) controls.push({ id: prefix, box: box(control) });
      }
      const badges: string[] = [];
      for (const prefix of ["inbox-awaiting-badge", "inbox-unread-badge"]) {
        if (row.querySelector(`[data-testid="${prefix}-${epicId}"]`)) {
          badges.push(prefix);
        }
      }
      const input = row.querySelector(`[data-testid="inbox-reply-input-${epicId}"]`);
      rows.push({
        epicId,
        box: box(row),
        controls,
        badges,
        placeholder: input?.getAttribute("placeholder") ?? null,
      });
    }

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      unreadCounter: counter("inbox-count"),
      awaitingCounter: counter("inbox-awaiting-count"),
      subtitle:
        document.querySelector('[data-testid="inbox-subtitle"]')?.textContent?.trim() ??
        null,
      awaitingBadgesOnPage: document.querySelectorAll(
        '[data-testid^="inbox-awaiting-badge-"]'
      ).length,
      rows,
    };
  }, epicIds);
}

/** The number a counter chip announces, or null when the chip is absent. */
function counterNumber(counter: { text: string } | null): number | null {
  if (!counter) return null;
  const match = counter.text.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

test("tells unread reports apart from questions actually waiting on the user", async ({
  page,
  project,
  request,
}, testInfo) => {
  const stamp = `w${testInfo.workerIndex}-${Date.now()}`;

  // Three rows, one per case the ticket asks to be tested.
  const report = await createEpic(
    request,
    project.id,
    `Inbox report ${stamp}`,
    "Seeded by e2e/inbox-unread-vs-awaiting.spec.ts"
  );
  const question = await createEpic(
    request,
    project.id,
    `Inbox question ${stamp}`,
    "Seeded by e2e/inbox-unread-vs-awaiting.spec.ts"
  );
  const alreadyRead = await createEpic(
    request,
    project.id,
    `Inbox already read ${stamp}`,
    "Seeded by e2e/inbox-unread-vs-awaiting.spec.ts"
  );

  async function postAgentComment(epicId: string, content: string) {
    const response = await request.post(
      `/api/projects/${project.id}/epics/${epicId}/comments`,
      { data: { author: "agent", content } }
    );
    expect(
      response.ok(),
      `agent comment failed: ${response.status()} ${await response.text()}`
    ).toBeTruthy();
  }

  const REPORT_TEXT =
    `Rapport de fin de chantier ${stamp} — la branche est fusionnée, la ` +
    `revue est verte et le ticket est clos. Rien n'attend de réponse ici.`;
  const QUESTION_TEXT =
    `Question ${stamp} — dois-je router les sessions mécaniques vers ` +
    `l'agent léger, ou garder le modèle configuré pour ce projet ?`;

  await postAgentComment(report.id, REPORT_TEXT);
  await postAgentComment(question.id, QUESTION_TEXT);
  await postAgentComment(alreadyRead.id, `Message déjà lu ${stamp}.`);

  withDatabase((db) => {
    // The report's ticket is FINISHED — exactly the state whose report the old
    // header counted as a blocked agent. Written directly: moving a ticket to
    // Done goes through a merge, and this spec must not run one.
    db.prepare("UPDATE epics SET status = 'done' WHERE id = ?").run(report.id);
    // Where a ticket sits when its agent stopped to ask something.
    db.prepare("UPDATE epics SET status = 'in_progress' WHERE id = ?").run(
      question.id
    );
    db.prepare("UPDATE epics SET status = 'review' WHERE id = ?").run(alreadyRead.id);

    const session = db.prepare(
      `INSERT INTO agent_sessions (id, project_id, epic_id, status, outcome, created_at, ended_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?)`
    );
    // Delivered — the report owes the user nothing.
    session.run(
      `inbox_report_${stamp}`,
      project.id,
      report.id,
      "answered",
      "2026-09-01T09:00:00.000Z",
      "2026-09-01T09:05:00.000Z"
    );
    // Asked, and never answered — the one row genuinely held on the user.
    session.run(
      `inbox_question_${stamp}`,
      project.id,
      question.id,
      "asked_question",
      "2026-09-01T09:00:00.000Z",
      "2026-09-01T09:05:00.000Z"
    );
  });

  // The question has been OPENED but not answered: it stays in the inbox
  // without being an unread message. The third ticket has been read and drops
  // out of the list entirely.
  for (const epicId of [question.id, alreadyRead.id]) {
    const response = await request.post("/api/inbox/read", { data: { epicId } });
    expect(response.ok(), `mark-read failed: ${response.status()}`).toBeTruthy();
  }

  const ownIds = [report.id, question.id, alreadyRead.id];
  const failures: string[] = [];

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/inbox");

    // Wait on the two rows this spec owns, not on a generic spinner: the list
    // is a 5s poll and several specs write to it at once.
    await expect(page.getByTestId(`inbox-item-${report.id}`)).toBeVisible();
    await expect(page.getByTestId(`inbox-item-${question.id}`)).toBeVisible();

    const geometry = await readGeometry(page, ownIds);
    const at = `${width}px`;

    // ---- The wording the ticket is about -------------------------------
    expect(geometry.subtitle, `${at}: the subtitle is gone`).toMatch(/unread/i);
    expect(
      geometry.subtitle,
      `${at}: the subtitle still calls every row a blocked agent`
    ).not.toMatch(/agents waiting on you/i);

    expect(
      geometry.unreadCounter?.text,
      `${at}: the headline counter no longer names unread messages`
    ).toMatch(/^\d+ unread$/);

    // The awaiting counter counts THAT CATEGORY AND NOTHING ELSE. Asserted
    // against the badges actually drawn on the page rather than against this
    // spec's own rows: /inbox is shared, and the invariant is what matters.
    expect(
      counterNumber(geometry.awaitingCounter),
      `${at}: the awaiting counter (${geometry.awaitingCounter?.text}) disagrees ` +
        `with the ${geometry.awaitingBadgesOnPage} awaiting rows on the page`
    ).toBe(geometry.awaitingBadgesOnPage);
    expect(
      geometry.awaitingBadgesOnPage,
      `${at}: this spec's pending question lost its awaiting flag`
    ).toBeGreaterThanOrEqual(1);

    // ---- The rows ------------------------------------------------------
    const byEpic = new Map(geometry.rows.map((row) => [row.epicId, row]));
    const reportRow = byEpic.get(report.id)!;
    const questionRow = byEpic.get(question.id)!;

    expect(
      byEpic.has(alreadyRead.id),
      `${at}: a ticket whose messages were read is still in the inbox`
    ).toBe(false);

    expect(
      reportRow.badges,
      `${at}: the finished ticket's report is flagged as awaiting a reply`
    ).toEqual(["inbox-unread-badge"]);
    expect(
      reportRow.placeholder,
      `${at}: the report's composer still asks the user to reply`
    ).not.toMatch(/reply/i);
    expect(
      reportRow.controls.map((control) => control.id),
      `${at}: the report lost the way to read it away, or gained a dispatch`
    ).toEqual([
      "inbox-item-link",
      "inbox-reply-input",
      "inbox-reply-send",
      "inbox-mark-read",
    ]);

    expect(
      questionRow.badges,
      `${at}: the pending question is not flagged as one`
    ).toEqual(["inbox-awaiting-badge"]);
    expect(
      questionRow.placeholder,
      `${at}: the pending question lost its reply framing`
    ).toMatch(/reply/i);
    // No "Mark as read": reading a pending question would not clear it from
    // the inbox, so the row does not pretend otherwise. "Send to Dev" stays —
    // the ticket is `in_progress`, which is buildable, and this ticket does
    // not touch the dispatch shortcut. It is measured, never clicked.
    expect(
      questionRow.controls.map((control) => control.id),
      `${at}: a pending question offers "Mark as read", which would not clear it`
    ).toEqual([
      "inbox-item-link",
      "inbox-reply-input",
      "inbox-reply-send",
      "inbox-send-to-dev",
    ]);

    // The report is still CONSULTABLE — the excerpt and the deep link stay.
    await expect(
      page.getByTestId(`inbox-item-${report.id}`),
      `${at}: the report's excerpt is no longer shown`
    ).toContainText(`Rapport de fin de chantier ${stamp}`);

    // ---- The layout ----------------------------------------------------
    if (geometry.scrollWidth > geometry.clientWidth + 0.5) {
      failures.push(
        `${at}: the page scrolls sideways — documentElement.scrollWidth ` +
          `${geometry.scrollWidth} vs clientWidth ${geometry.clientWidth}`
      );
    }

    for (const counter of [geometry.unreadCounter, geometry.awaitingCounter]) {
      if (!counter) continue;
      const right = counter.box.x + counter.box.width;
      if (counter.box.x < -0.5 || right > geometry.clientWidth + 0.5) {
        failures.push(
          `${at}: the counter "${counter.text}" is outside the viewport — ` +
            `x=${counter.box.x.toFixed(1)} right=${right.toFixed(1)}`
        );
      }
    }

    for (const row of geometry.rows) {
      for (const control of row.controls) {
        const right = control.box.x + control.box.width;
        if (control.box.x < -0.5 || right > geometry.clientWidth + 0.5) {
          failures.push(
            `${at}: ${control.id} of ${row.epicId} is outside the viewport — ` +
              `x=${control.box.x.toFixed(1)} right=${right.toFixed(1)} ` +
              `viewport=${geometry.clientWidth}`
          );
        }
        // The title is a text link, not a pill: what it owes the user is
        // enough width to name the ticket. 120px is roughly the narrowest a
        // 14px title can be and still say anything — the single-row header
        // left it 30.7px at 390px before this fix.
        if (control.id === "inbox-item-link") {
          if (control.box.width < 120) {
            failures.push(
              `${at}: the title of ${row.epicId} is ${control.box.width.toFixed(1)}px ` +
                `wide — the meta chips took the row`
            );
          }
          continue;
        }
        if (control.box.height < 24 || control.box.width < 24) {
          failures.push(
            `${at}: ${control.id} of ${row.epicId} is too small to tap — ` +
              `${control.box.width.toFixed(1)}×${control.box.height.toFixed(1)}`
          );
        }
      }
    }

    if (SCREENSHOT_WIDTHS.has(width)) {
      await page.screenshot({
        path: testInfo.outputPath(`inbox-${width}.png`),
        fullPage: true,
      });
    }
  }

  expect(
    failures,
    `the inbox does not fit its own screen:\n${failures.join("\n")}`
  ).toEqual([]);

  // ---- Reading a report files it away, and touches nothing else --------
  await page.getByTestId(`inbox-mark-read-${report.id}`).click();
  await expect(page.getByTestId(`inbox-item-${report.id}`)).toHaveCount(0);

  const stored = withDatabase((db) =>
    db
      .prepare("SELECT id, status FROM epics WHERE id IN (?, ?)")
      .all(report.id, question.id)
  ) as Array<{ id: string; status: string }>;
  expect(
    Object.fromEntries(stored.map((row) => [row.id, row.status])),
    "reading a message moved a ticket"
  ).toEqual({ [report.id]: "done", [question.id]: "in_progress" });

  // The question is still there: it was read long before, and only a reply
  // clears it.
  await expect(page.getByTestId(`inbox-item-${question.id}`)).toBeVisible();
});
