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
 */

/** The audit's five widths (the ticket's own 320/390, plus the comment's). */
const WIDTHS = [320, 390, 768, 1280, 1440] as const;

/** The bar is mounted by `app/layout.tsx`; these three prove "every screen". */
const ROUTES = ["/", "/agents", "/tickets"] as const;

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
      for (const route of ROUTES) {
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
});
