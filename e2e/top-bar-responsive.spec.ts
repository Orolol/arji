import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";

/**
 * B-arij-164 — the bar's three groups, in a real browser, at five widths.
 *
 * This is the half of the fix that `__tests__/top-bar-responsive.test.tsx`
 * cannot do. jsdom has no layout engine, so the unit file can only pin the
 * MARKUP that produced the defect (`absolute` centring, an inline
 * `calc(50% - 235px)` that goes negative below 470px). Whether the groups
 * actually overlap, and whether the page actually scrolls sideways, is a
 * visual claim and needs Chrome.
 *
 * WHAT WAS MEASURED HERE BEFORE THE FIX (2026-09-05, two projects, five island
 * pills, Chrome via `channel: "chrome"`):
 *
 *   320  documentElement.scrollWidth 380 vs clientWidth 320, island over the
 *        right cluster by 266px, left zone 0px wide
 *   390  scrollWidth 415 vs 390, same 266px overlap, left zone 0px wide
 *   768  no page scroll, island over the right cluster by 122px
 *   1280 clean
 *   1440 clean
 *
 * TWO PROJECTS, NOT ONE. The left zone is the chips, and a single short chip
 * never reaches far enough right to be interesting; the second one is what
 * makes "the chips are still there and still reachable" a real assertion.
 *
 * THE BAR IS SHARED CHROME, so the widths are swept on more than one route:
 * a regression that only shows on `/agents` would still be on every screen.
 *
 * B-arij-hEtMTczybUgx re-measured this on the fixed bar and found nothing to
 * fix: it reported the same collision at 390×844, but on `/projects/:id`, and
 * against the bar as it stood BEFORE `052e062` — the ticket even names the
 * retired mechanism ("une île en position absolue"). Re-measured in Chrome on
 * six projects across `/`, `/projects/:id`, `/settings` and `/agents` at 17
 * widths from 320 to 1280: no overlap, no page scroll, no covered pill. What
 * the report did expose is that the route it names was never swept, so
 * `ROUTES` now includes the project board.
 */

/** The audit's five widths (the ticket's own 320/390, plus the comment's). */
const WIDTHS = [320, 390, 768, 1280, 1440] as const;

/**
 * The bar is mounted by `app/layout.tsx`; these prove "every screen".
 *
 * `null` is the project board, `/projects/:id` — the fixture's own id is not a
 * constant, so it is substituted per run. It is here because B-arij-hEtMTczybUgx
 * reported the collision on that route specifically, at 390×844, and the three
 * static routes above never visit it. It is also the one route where a project
 * chip is ACTIVE: an active chip wears a pastel fill and is the widest the left
 * zone ever draws, which is exactly what the retired `calc(50% - 235px)` cap
 * used to govern. That defect is fixed (see this spec's header), but the route
 * the report was filed against was never swept, and an unswept route is where
 * the next one lands.
 */
const ROUTES = ["/", "/agents", "/tickets", null] as const;

/**
 * B-arij-Gr4WgnOaRDQs — the band the sweep above jumps straight over.
 *
 * `WIDTHS` steps 768 → 1280, and the report's collision lived entirely inside
 * that gap: it measured the onset at ~1002px on a route whose island carries an
 * active chevron, and ~981px on one at rest. Five widths that skip the whole
 * 769–1279 range cannot see it, so the sweep above passing said nothing about
 * the range the report was actually about.
 *
 * These are the report's own measured widths, plus the two edges of the
 * transition: 1024 (`lg`, where the island rejoins the row and the clearance is
 * at its tightest) and 1272 (`components/ticket/TicketOverlay.tsx` handles
 * `max-[1272px]` explicitly, so it is a width the app claims to support).
 */
const GUARDRAIL_WIDTHS = [820, 900, 960, 980, 1002, 1024, 1100, 1272] as const;

/**
 * `/settings` FIRST, because its island is the widest the bar ever draws — the
 * active category wears a chevron, which the resting island does not. Measured
 * in Chrome at 1024: 439.7px on `/settings` against 421.2px on `/`, and it is
 * the widest island that collides first. `/` is kept as the contrasting
 * resting case.
 */
const GUARDRAIL_ROUTES = ["/settings", "/"] as const;

/** The five island pills, by the test ids the bar exposes. */
const ISLAND_PILLS = ["now", "work", "chat", "agents", "settings"] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BarGeometry {
  scrollWidth: number;
  clientWidth: number;
  left: Box | null;
  island: Box | null;
  right: Box | null;
  /** Boxes of the two chips this spec owns, keyed by project id. */
  chips: Record<string, Box | null>;
}

/**
 * Horizontal overlap of two boxes in px, or 0 when they are clear of each
 * other. Sub-pixel touching (a shared 0.5px edge from a fractional layout) is
 * not a collision, so the threshold is half a pixel rather than zero.
 */
function overlapPx(a: Box | null, b: Box | null): number {
  if (!a || !b) return 0;
  const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (horizontal <= 0.5 || vertical <= 0.5) return 0;
  return horizontal;
}

async function readBar(page: Page, chipIds: string[]): Promise<BarGeometry> {
  return page.evaluate((ids: string[]) => {
    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const chips = document.querySelector('[data-testid="top-bar-project-chips"]');
    const island = document.querySelector('[data-testid="top-bar-island"]');
    // The right zone has no test id of its own; it is the cluster holding New.
    const right = document.querySelector('[data-testid="top-bar-new"]')?.parentElement;

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      left: box(chips?.parentElement),
      island: box(island),
      right: box(right),
      chips: Object.fromEntries(
        ids.map((id) => [id, box(document.querySelector(`[data-testid="top-bar-project-${id}"]`))]),
      ),
    };
  }, chipIds);
}

/**
 * A second project, created exactly as the fixture creates the first: a real
 * repository with an initial commit, because `POST /api/projects` validates the
 * path. Same shape as `e2e/top-bar-project-scope.spec.ts`.
 */
async function createScratchProject(request: APIRequestContext, name: string) {
  const rootPath = mkdtempSync(path.join(tmpdir(), "arij-e2e-responsive-"));
  const repoPath = path.join(rootPath, "repo");
  mkdirSync(repoPath);

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.email", "e2e@arij.local");
  git("config", "user.name", "Arij E2E");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "initial");

  const created = await request.post("/api/projects", {
    data: { name, gitRepoPath: repoPath },
  });
  expect(
    created.ok(),
    `second project creation failed: ${created.status()} ${await created.text()}`,
  ).toBeTruthy();

  const { data } = (await created.json()) as { data: { id: string } };
  return { id: data.id, rootPath };
}

test.describe("TopBar — responsive geometry", () => {
  test("never scrolls the page sideways and never overlaps its own groups", async ({
    page,
    project,
    request,
  }) => {
    const second = await createScratchProject(request, "Piscine Design");

    try {
      for (const entry of ROUTES) {
        // `null` is the project board — resolved here because the fixture's
        // project id only exists at run time.
        const route = entry ?? project.boardUrl;
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(route);
          await expect(page.getByTestId("top-bar")).toBeVisible();
          // The chips render from `useProjects`; wait for BOTH so the left zone
          // is measured at its real width and not mid-fetch. `toBeAttached`,
          // not `toBeVisible`: a chip scrolled out of the rail is still
          // reachable, and whether the rail collapsed is asserted below.
          await expect(page.getByTestId(`top-bar-project-${project.id}`)).toBeAttached();
          await expect(page.getByTestId(`top-bar-project-${second.id}`)).toBeAttached();

          const bar = await readBar(page, [project.id, second.id]);
          const where = `${route} @ ${width}px`;

          expect(bar.left, `${where}: no left zone`).not.toBeNull();
          expect(bar.island, `${where}: no island`).not.toBeNull();
          expect(bar.right, `${where}: no right cluster`).not.toBeNull();

          // The ticket's pass condition, verbatim.
          expect(
            bar.scrollWidth,
            `${where}: the page scrolls horizontally ` +
              `(scrollWidth ${bar.scrollWidth} > clientWidth ${bar.clientWidth})`,
          ).toBeLessThanOrEqual(bar.clientWidth);

          // The audit's addition: a correct scrollWidth is not enough, the
          // groups must also be clear of each other.
          expect(
            overlapPx(bar.left, bar.island),
            `${where}: the project chips and the nav island overlap`,
          ).toBe(0);
          expect(
            overlapPx(bar.island, bar.right),
            `${where}: the nav island and the ⌘K/Auto/New cluster overlap`,
          ).toBe(0);
          expect(
            overlapPx(bar.left, bar.right),
            `${where}: the project chips and the ⌘K/Auto/New cluster overlap`,
          ).toBe(0);

          // "Projets toujours sélectionnables": below 470px the old inline cap
          // computed negative, so the left zone was zero-width and the chips
          // were not merely cramped — they were unreachable.
          expect(
            bar.left!.width,
            `${where}: the left zone collapsed, so no project chip is reachable`,
          ).toBeGreaterThan(0);
          // The chips this spec owns, by id — NOT a count of every chip in the
          // bar. The e2e database is shared and `fullyParallel`, so any other
          // spec's project is a legitimate extra chip and a total would be a
          // flake, not an assertion.
          for (const [id, chip] of Object.entries(bar.chips)) {
            expect(chip, `${where}: chip for ${id} is not rendered`).not.toBeNull();
            expect(
              chip!.width,
              `${where}: chip for ${id} rendered at zero width`,
            ).toBeGreaterThan(0);
          }
        }
      }
    } finally {
      await request.delete(`/api/projects/${second.id}`);
      rmSync(second.rootPath, { recursive: true, force: true });
    }
  });

  /**
   * The nav pills lose their LABELS on a phone, never their accessible names.
   * `getByRole("link", { name })` reads the accessibility tree, so it fails the
   * moment someone swaps `sr-only` for `hidden` — which is the cheap way to
   * make the bar fit and the one that strands a screen-reader user with five
   * unnamed buttons.
   */
  test("keeps every island pill named and clickable at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/agents");
    await expect(page.getByTestId("top-bar")).toBeVisible();

    for (const name of ["Now", "Chat"]) {
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    }
    for (const name of ["Work", "Agents", "Réglages"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    for (const name of ["Auto", "New"]) {
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    }

    // `Now` is a direct destination on a phone as on a desktop — one click, no
    // menu in the way.
    await page.getByRole("link", { name: "Now", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  /**
   * The one surface that could still scroll the page sideways once the bar
   * fits: the 560px menu card, which a keyboard user can open at 320px even
   * though a touch pointer never does (a tap navigates).
   */
  test("keeps a keyboard-opened menu inside a 320px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/agents");
    await expect(page.getByTestId("top-bar")).toBeVisible();

    // Focus is what opens a category menu; a click would navigate instead.
    await page.getByTestId("top-bar-bubble-work").focus();
    await expect(page.getByTestId("top-bar-menu-work")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `an open menu scrolls the page (${overflow.scrollWidth} > ${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(overflow.clientWidth);

    // And its entries are still usable, not squeezed to nothing.
    const entry = page.getByTestId("top-bar-entry-tickets");
    await expect(entry).toBeVisible();
    expect((await entry.boundingBox())!.width).toBeGreaterThan(150);
  });

  /**
   * B-arij-Gr4WgnOaRDQs — the island's RIGHT edge against the ⌘K/Auto/New
   * cluster, through the band the five-width sweep skips.
   *
   * The report measured, on `f6b0179` and identically on its merge-base
   * `e415564`: the island centred absolutely and guarded only on its left, the
   * right cluster walking inward on `ml-auto`, and the island painted UNDERNEATH
   * it — so a click on the right of "Réglages" opened the palette. It quantified
   * the harm as the share of the "Réglages" pill that `elementFromPoint` does not
   * return: 4% at 1002px, 22% at 960, 51% at 900, 80% at 820.
   *
   * WHAT THIS ASSERTS, AND WHY IT IS NOT THE REPORT'S OWN METRIC. The report's
   * `clear` is one-dimensional — `top-bar-search.left − island.right` — and
   * since `052e062` the island takes its own LINE below `lg`. Comparing x
   * coordinates across two different rows now reads −272px at 820px on a bar
   * with no collision at all, so porting that metric verbatim would assert a
   * failure that is not one. The pass condition here is therefore the harm
   * itself, in two dimensions:
   *
   *   1. the island and the cluster never intersect as boxes (`overlapPx`
   *      already requires a vertical overlap, so a wrapped island is clear by
   *      construction rather than by exception);
   *   2. where they DO share a row, the island's right edge is strictly left of
   *      the cluster — a real gap, not a shared edge;
   *   3. every island pill is the topmost element across its own width, which
   *      is the user-facing claim: the pill you click is the pill you get.
   *
   * (3) is the one that cannot be satisfied by accident. A pill can be clear of
   * the cluster's BOX and still be covered by something else painted over it,
   * and stacking order is exactly what the report found broken.
   */
  test("keeps the island clear of the right cluster across the 820–1272 band", async ({
    page,
    project,
  }) => {
    for (const route of GUARDRAIL_ROUTES) {
      // Navigate once per route, then sweep by resizing. The breakpoints are
      // pure CSS, so a resize relayouts exactly as a reload would — and this is
      // what a user dragging a window actually does.
      await page.setViewportSize({ width: GUARDRAIL_WIDTHS[0], height: 900 });
      await page.goto(route);
      await expect(page.getByTestId("top-bar")).toBeVisible();
      await expect(page.getByTestId(`top-bar-project-${project.id}`)).toBeAttached();

      for (const width of GUARDRAIL_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const where = `${route} @ ${width}px`;

        const bar = await readBar(page, []);
        expect(bar.island, `${where}: no island`).not.toBeNull();
        expect(bar.right, `${where}: no right cluster`).not.toBeNull();

        expect(
          overlapPx(bar.island, bar.right),
          `${where}: the nav island and the ⌘K/Inbox/Auto/New cluster overlap`,
        ).toBe(0);

        // When the two share a row, "not overlapping" is not enough — they must
        // be separated by a real gap. `overlapPx` treats a sub-pixel touch as
        // clear, and a 0px clearance is a collision waiting for one more pill.
        const sharesRow =
          Math.min(bar.island!.y + bar.island!.height, bar.right!.y + bar.right!.height) -
            Math.max(bar.island!.y, bar.right!.y) >
          0.5;
        if (sharesRow) {
          const clearance = bar.right!.x - (bar.island!.x + bar.island!.width);
          expect(
            clearance,
            `${where}: the island's right edge reaches the right cluster ` +
              `(clearance ${clearance.toFixed(1)}px)`,
          ).toBeGreaterThan(0);
        }

        // The harm, measured the way the report measured it: the share of each
        // island pill that hit-tests to something else.
        const covered = await page.evaluate((ids: readonly string[]) => {
          const SAMPLES = 25;
          return ids.map((id) => {
            const pill = document.querySelector(`[data-testid="top-bar-bubble-${id}"]`);
            if (!pill) return { id, width: 0, missPercent: 100 };
            const rect = pill.getBoundingClientRect();
            if (rect.width <= 0) return { id, width: 0, missPercent: 100 };
            const y = rect.y + rect.height / 2;
            let miss = 0;
            for (let i = 0; i < SAMPLES; i++) {
              // Clamped inside the right edge: a sample exactly ON it belongs
              // to the neighbour, which would be a false positive.
              const x = Math.min(
                rect.x + (rect.width * i) / (SAMPLES - 1),
                rect.x + rect.width - 0.5,
              );
              const hit = document.elementFromPoint(x, y);
              if (!hit || !pill.contains(hit)) miss++;
            }
            return { id, width: rect.width, missPercent: (miss / SAMPLES) * 100 };
          });
        }, ISLAND_PILLS);

        for (const pill of covered) {
          expect(pill.width, `${where}: island pill "${pill.id}" has no width`).toBeGreaterThan(0);
          expect(
            pill.missPercent,
            `${where}: ${pill.missPercent.toFixed(0)}% of the island pill ` +
              `"${pill.id}" is covered by another control — a click there does ` +
              `not reach it`,
          ).toBe(0);
        }

        expect(
          bar.scrollWidth,
          `${where}: the page scrolls horizontally ` +
            `(scrollWidth ${bar.scrollWidth} > clientWidth ${bar.clientWidth})`,
        ).toBeLessThanOrEqual(bar.clientWidth);
      }
    }
  });
});
