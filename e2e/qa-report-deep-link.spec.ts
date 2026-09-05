import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * The unit suite (`__tests__/qa-report-deep-link-consumption.test.tsx`) models
 * the App Router: a mocked `router.replace` that rewrites the URL only once a
 * fake RSC round-trip lands. This spec is the same claim without the model —
 * real Chrome, real dev server, real router.
 *
 * WHY THE RSC ROUND-TRIP IS HELD. Consuming the parameter through
 * `router.replace()` is a *navigation*, so the address bar catches up when the
 * destination's RSC payload arrives. Measured here against a warm `next dev`
 * on the unfixed page: the report was on screen 689ms after `goto`, with
 * `?reportId=` still live, and the URL only cleared 132ms and two `_rsc=`
 * requests later. Cold, the board page's equivalent took 3406ms.
 *
 * 132ms is a real stale window — long enough to click a report and reload
 * inside — but far too short to assert on without racing Playwright's own
 * polling: a retrying `toBeVisible()` routinely resolves after the navigation
 * has landed, and the spec then passes on the broken page. Holding every
 * `_rsc=` response for five seconds turns that race into the condition the bug
 * report describes (a cold or loaded server) and makes the assertion
 * deterministic: a page that consumes the deep link through the history API
 * never waits on that round-trip, a page that navigates waits on all of it.
 *
 * Read-only: QA reports are seeded as rows, so nothing here dispatches an agent.
 */

/** `ReportDetail` titles a report `<label> #<id.slice(0, 8)>`. */
const LINKED_ID_PREFIX = "LINKEDrp";
const NEWEST_ID_PREFIX = "NEWESTrp";
const LINKED_HEADING = `Failure Digest #${LINKED_ID_PREFIX}`;
const NEWEST_HEADING = `Tech Check #${NEWEST_ID_PREFIX}`;

/** Longer than any assertion here waits, shorter than the test timeout. */
const RSC_HOLD_MS = 5_000;

test("consumes ?reportId= without a navigation, so a reload cannot replay it", async ({
  page,
  project,
}, testInfo) => {
  const linkedId = `${LINKED_ID_PREFIX}_${project.id}`;
  const newestId = `${NEWEST_ID_PREFIX}_${project.id}`;

  withDatabase((db) => {
    const insert = db.prepare(
      "INSERT INTO qa_reports (id, project_id, status, report_content, summary, check_type, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // The deep link names the OLDER report: the page falls back to the newest
    // one, so a selection that merely looks right cannot pass by accident.
    insert.run(linkedId, project.id, "completed", "Body of the linked report.", "Linked report", "failure_digest", "2026-09-01T10:00:00Z", "2026-09-01T10:01:00Z");
    insert.run(newestId, project.id, "completed", "Body of the newest report.", "Newest report", "tech_check", "2026-09-02T10:00:00Z", "2026-09-02T10:01:00Z");
  });

  // Only the router's own payload fetches. The page's data comes from
  // /api/projects/... through plain fetch and is untouched.
  const heldRscRequests: string[] = [];
  await page.route(/_rsc=/, async (route) => {
    heldRscRequests.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, RSC_HOLD_MS));
    await route.continue();
  });

  const qaUrl = `/projects/${project.id}/qa`;
  await page.goto(`${qaUrl}?reportId=${linkedId}`);

  // The deep link does its job...
  await expect(page.getByRole("heading", { name: LINKED_HEADING })).toBeVisible();

  // ...and is already spent by then. Read once, with no polling: the whole bug
  // is the window between the selection and the address bar catching up, so an
  // assertion that retries would wait the defect away.
  expect(new URL(page.url()).search).toBe("");

  // The user moves on, then reloads — the URL is what a reload replays.
  await page.getByRole("button", { name: /Newest report/ }).click();
  await expect(page.getByRole("heading", { name: NEWEST_HEADING })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: NEWEST_HEADING })).toBeVisible();
  await expect(page.getByRole("heading", { name: LINKED_HEADING })).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("qa-report-deep-link.png"),
    fullPage: true,
  });
});
