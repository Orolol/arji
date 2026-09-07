import { expect, test } from "./fixtures/arij-project";
import { withDatabase } from "./fixtures/data-root";

/**
 * B-arij-FaVfLeT2QC5u — the registry's titles vanish and its columns run out
 * of the card on a phone.
 *
 * This is the half of the fix that `__tests__/tickets-registry-responsive.test.tsx`
 * cannot do. jsdom has no layout engine, so the unit file can only pin the
 * MARKUP that produced the defect (an unprefixed seven-track grid, six of them
 * fixed at 738px). Whether a title actually has a rectangle, and whether the
 * row stays inside its card, is a visual claim and needs Chrome.
 *
 * MEASURED IN CHROME on `c001324` with this spec's own seed, the unfixed row
 * instrumented with nothing but these two test ids (2026-09-05). Title
 * rectangle, then the right edge of the COÛT cell against the card's:
 *
 *   390×844    title   0.0px   coût ends at 842px, card at 376px   (+466)
 *   768×1024   title   0.0px   coût ends at 842px, card at 754px    (+88)
 *   1280×800   title 406.0px   coût ends at 1248px, card at 1266px    ok
 *   1440×1000  title 566.0px   coût ends at 1408px, card at 1426px    ok
 *
 * and the card's own body 828px of content in a 362px box at 390px.
 *
 * The zero is the bug: `grid-cols-[112px_1fr_130px_96px_120px_170px_110px]`
 * spends 738px of fixed track plus 72px of gaps before the `1fr` title gets
 * anything, so on a phone the title column is squeezed out entirely while the
 * ÉTAT/STORIES/PRIORITÉ/ACTIVITÉ/COÛT columns run past the card's right edge.
 *
 * THE PAGE ITSELF NEVER SCROLLED SIDEWAYS, before or after —
 * `StrataBand`'s `overflow-hidden` clipped the excess rather than exporting it
 * to the document. That criterion was already met on `main`; it is asserted
 * here so the fix cannot buy the title back by breaking it.
 *
 * AFTER THE FIX, same seed and same run: title 257.2px at 390 and 635.2px at
 * 768, the card's body content back inside its box (362px in 362px), and the
 * two desktop widths unchanged to the pixel — 406.0px and 566.0px, rows still
 * 35.5px tall.
 */

/** The ticket's two mobile widths, then the two desktop widths it protects. */
const VIEWPORTS = [
  { width: 390, height: 844, shape: "stacked" },
  { width: 768, height: 1024, shape: "stacked" },
  { width: 1280, height: 800, shape: "table" },
  { width: 1440, height: 1000, shape: "table" },
] as const;

/**
 * Long enough that the title cannot be mistaken for a short label that happens
 * to fit — the audit's own reproduction condition ("des tickets aux titres
 * longs").
 */
const LONG_TITLE =
  "Registre mobile : les titres des tickets disparaissent et les colonnes débordent du cadre";
/** Short enough to render whole at 390px, so truncation can be told from loss. */
const SHORT_TITLE = "Titre court";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RowGeometry {
  epicId: string;
  row: Box;
  title: Box | null;
  chip: Box | null;
  /**
   * The five trailing cells — état, stories, priorité, activité, coût.
   *
   * Their own boxes, never their wrapper's: from `lg` up the wrapper is
   * `display: contents` and generates no box at all, which is exactly how the
   * cells rejoin the table's columns 3-7. A measurement of the wrapper would
   * read 0×0 there and call the working table broken.
   */
  metaPresent: boolean;
  metaCells: Box[];
  /** The union of {@link metaCells} — where the cluster sits as a whole. */
  meta: Box | null;
  /** The title's own overflow — a clamped line reports more than it shows. */
  titleScrollWidth: number;
  titleClientWidth: number;
  titleText: string;
}

interface PageGeometry {
  scrollWidth: number;
  clientWidth: number;
  /** The scrolling body of the card — the box every row has to fit inside. */
  body: Box | null;
  bodyScrollWidth: number;
  bodyClientWidth: number;
  rows: RowGeometry[];
}

async function readRegistry(page: import("@playwright/test").Page): Promise<PageGeometry> {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const body = document.querySelector('[data-testid="tickets-body"]');
    const rows = Array.from(document.querySelectorAll('[data-testid="tickets-row"]'));

    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      body: box(body),
      bodyScrollWidth: body?.scrollWidth ?? 0,
      bodyClientWidth: body?.clientWidth ?? 0,
      rows: rows.map((row) => {
        const title = row.querySelector('[data-testid="tickets-row-title"]');
        const metaWrapper = row.querySelector('[data-testid="tickets-row-meta"]');
        const metaCells = Array.from(metaWrapper?.children ?? []).map((cell) => box(cell)!);
        const union = metaCells.reduce<Box | null>((acc, cell) => {
          if (!acc) return { ...cell };
          const left = Math.min(acc.x, cell.x);
          const top = Math.min(acc.y, cell.y);
          return {
            x: left,
            y: top,
            width: Math.max(acc.x + acc.width, cell.x + cell.width) - left,
            height: Math.max(acc.y + acc.height, cell.y + cell.height) - top,
          };
        }, null);

        return {
          epicId: row.getAttribute("data-epic-id") ?? "",
          row: box(row)!,
          title: box(title),
          chip: box(row.querySelector('[data-slot="identity-chip"]')),
          metaPresent: metaWrapper !== null,
          metaCells,
          meta: union,
          titleScrollWidth: (title as HTMLElement | null)?.scrollWidth ?? 0,
          titleClientWidth: (title as HTMLElement | null)?.clientWidth ?? 0,
          titleText: title?.textContent ?? "",
        };
      }),
    };
  }) as Promise<PageGeometry>;
}

test.describe("the tickets registry on a phone", () => {
  test("keeps every title a real rectangle inside the card, at four widths", async ({
    page,
    project,
  }, testInfo) => {
    withDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO epics (id, project_id, title, readable_id, status, priority, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(`${project.id}-long`, project.id, LONG_TITLE, "ARJ-901", "todo", 3, 0, "2026-09-05T08:00:00Z");
      insert.run(`${project.id}-short`, project.id, SHORT_TITLE, "ARJ-902", "todo", 1, 1, "2026-09-05T07:00:00Z");
      insert.run(`${project.id}-review`, project.id, `Review — ${LONG_TITLE}`, "ARJ-903", "review", 2, 2, "2026-09-05T06:00:00Z");
    });

    await page.goto(`/tickets?project=${project.id}`);
    await expect(page.getByTestId("tickets-row")).toHaveCount(3);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const where = `${viewport.width}×${viewport.height}`;

      // The breakpoints are pure CSS; a resize relayouts exactly as a reload
      // would, and it is what a user rotating a phone actually does. Waiting on
      // the row count again keeps the measurement off a mid-relayout frame.
      await expect(page.getByTestId("tickets-row")).toHaveCount(3);
      const registry = await readRegistry(page);

      expect(registry.body, `${where}: the registry body never rendered`).not.toBeNull();
      expect(registry.rows, `${where}: no rows measured`).toHaveLength(3);

      // "Aucun débordement horizontal global."
      expect(
        registry.scrollWidth,
        `${where}: the page scrolls horizontally ` +
          `(scrollWidth ${registry.scrollWidth} > clientWidth ${registry.clientWidth})`,
      ).toBeLessThanOrEqual(registry.clientWidth);

      // …and the card does not merely CLIP the overflow, which is what the
      // unfixed screen did: the rows really are narrower than their container.
      expect(
        registry.bodyScrollWidth,
        `${where}: the rows overflow the card sideways ` +
          `(${registry.bodyScrollWidth} > ${registry.bodyClientWidth})`,
      ).toBeLessThanOrEqual(registry.bodyClientWidth + 1);

      for (const row of registry.rows) {
        const which = `${where} · ${row.epicId}`;

        // "chaque ticket expose au minimum son identifiant, un titre lisible
        //  et son statut" — the identifier first.
        expect(row.chip, `${which}: no identity chip`).not.toBeNull();
        expect(row.chip!.width, `${which}: the identity chip has no width`).toBeGreaterThan(0);

        // The defect, verbatim: "aucun titre ne se réduit à une largeur nulle".
        expect(row.title, `${which}: no title cell`).not.toBeNull();
        expect(
          row.title!.width,
          `${which}: the title rectangle is ${row.title!.width.toFixed(1)}px wide`,
        ).toBeGreaterThan(120);
        expect(row.title!.height, `${which}: the title has no height`).toBeGreaterThan(0);

        // Inside the card, on both edges. A title painted past the right edge
        // is invisible whether or not it has a width.
        expect(
          row.title!.x,
          `${which}: the title starts left of the card`,
        ).toBeGreaterThanOrEqual(registry.body!.x - 0.5);
        expect(
          row.title!.x + row.title!.width,
          `${which}: the title runs past the card's right edge`,
        ).toBeLessThanOrEqual(registry.body!.x + registry.body!.width + 0.5);

        // Every other column is RE-LAID-OUT, never hidden: the five trailing
        // cells each keep a box of their own at every width.
        expect(row.metaPresent, `${which}: the état/stories/priorité/coût cluster is gone`).toBe(true);
        expect(row.metaCells, `${which}: the cluster lost cells`).toHaveLength(5);
        for (const [index, cell] of row.metaCells.entries()) {
          expect(cell.width, `${which}: trailing cell ${index} has no width`).toBeGreaterThan(0);
          expect(cell.height, `${which}: trailing cell ${index} has no height`).toBeGreaterThan(0);
        }
        expect(
          row.meta!.x + row.meta!.width,
          `${which}: the trailing columns run past the card's right edge`,
        ).toBeLessThanOrEqual(registry.body!.x + registry.body!.width + 0.5);

        if (viewport.shape === "stacked") {
          // The stack: the meta line sits BELOW the title rather than beside
          // it, which is the space the title's width comes from.
          expect(
            row.meta!.y,
            `${which}: the trailing columns are still on the title's line`,
          ).toBeGreaterThan(row.title!.y + row.title!.height - 1);
          // Touch target. Two lines plus the row's padding clear 44px.
          expect(row.row.height, `${which}: the row is too small to tap`).toBeGreaterThanOrEqual(44);
        } else {
          // "Conserver la table desktop": one line, columns side by side.
          expect(
            row.meta!.y,
            `${which}: the desktop table has stacked — the trailing columns left the row's line`,
          ).toBeLessThan(row.title!.y + row.title!.height);
          expect(
            row.row.height,
            `${which}: the desktop row grew past its single line (${row.row.height.toFixed(1)}px)`,
          ).toBeLessThan(44);
        }
      }

      // A title that fits is drawn WHOLE — the distinction between an ellipsis
      // and a lost column.
      const short = registry.rows.find((row) => row.epicId === `${project.id}-short`)!;
      expect(short.titleText, `${where}: the short title is not rendered`).toBe(SHORT_TITLE);
      expect(
        short.titleScrollWidth,
        `${where}: even "${SHORT_TITLE}" is truncated ` +
          `(${short.titleScrollWidth} > ${short.titleClientWidth})`,
      ).toBeLessThanOrEqual(short.titleClientWidth + 1);

      // The column legend belongs to the table, and only to it.
      const header = page.getByRole("columnheader", { name: "Title" });
      if (viewport.shape === "table") {
        await expect(header, `${where}: the table lost its column header`).toBeVisible();
      } else {
        await expect(header, `${where}: seven sort kickers over two tracks`).toBeHidden();
      }

      await page.screenshot({
        path: testInfo.outputPath(`registry-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  });

  /**
   * "Recherche, filtres, ouverture du ticket et pagination/« tout montrer »
   * restent utilisables au toucher et au clavier" — at the width where the
   * layout changed.
   */
  test("keeps search, filters, sorting, show-all and opening usable at 390px", async ({
    page,
    project,
  }, testInfo) => {
    withDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO epics (id, project_id, title, readable_id, status, priority, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(`${project.id}-open`, project.id, LONG_TITLE, "ARJ-911", "todo", 3, 0, "2026-09-05T08:00:00Z");
      insert.run(`${project.id}-other`, project.id, "Autre ticket ouvert", "ARJ-912", "todo", 1, 1, "2026-09-05T07:00:00Z");
      // GROUP_PREVIEW.done is 3, so six shipped tickets guarantee the
      // truncation line and its "show all" link.
      for (let index = 0; index < 6; index++) {
        insert.run(
          `${project.id}-done-${index}`,
          project.id,
          `Livré ${index} — ${LONG_TITLE}`,
          `ARJ-92${index}`,
          "done",
          1,
          index + 2,
          "2026-09-04T08:00:00Z",
        );
      }
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/tickets?project=${project.id}`);

    const rows = page.getByTestId("tickets-row");
    // Two open + the first three shipped: the group preview, not the total.
    await expect(rows).toHaveCount(5);

    // "show all" — reachable, and it really expands.
    const showAll = page.getByTestId("tickets-show-all");
    await expect(showAll).toBeVisible();
    const showAllBox = (await showAll.boundingBox())!;
    expect(
      showAllBox.x + showAllBox.width,
      "the show-all link is pushed out of the viewport at 390px",
    ).toBeLessThanOrEqual(390);
    // By keyboard, which is the half a click cannot prove: `QuietLink` renders
    // a real button, so it takes focus and answers Enter.
    await showAll.focus();
    await expect(showAll).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(8);

    // Search, by touch: the field is on screen and it filters.
    const field = page.getByTestId("tickets-filter-field");
    await expect(field).toBeVisible();
    const fieldBox = (await field.boundingBox())!;
    expect(
      fieldBox.x + fieldBox.width,
      "the filter field is pushed out of the viewport at 390px",
    ).toBeLessThanOrEqual(390);
    await field.fill("Autre");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Autre ticket ouvert");
    await field.fill("");
    await expect(rows).toHaveCount(8);

    // A state filter pill.
    await page.getByTestId("tickets-filter-done").click();
    await expect(rows).toHaveCount(6);
    await page.getByTestId("tickets-filter-all").click();
    await expect(rows).toHaveCount(8);

    // Sorting — the affordance the column header used to carry on a phone. The
    // `sort:` pill offers the same seven sorts.
    await page.getByRole("button", { name: /^sort:/ }).click();
    await page.getByTestId("tickets-sort-titre").click();
    await expect(page.getByRole("button", { name: /^sort: title/ })).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath("registry-390-controls.png"),
      fullPage: true,
      animations: "disabled",
    });

    // Opening a ticket, by tap.
    const target = rows.filter({ hasText: "Autre ticket ouvert" });
    await target.tap({ force: false }).catch(async () => {
      // The default Chrome device descriptor has no touch; a click is the same
      // pointer path through React's synthetic event either way.
      await target.click();
    });
    const panel = page.getByTestId("epic-detail-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("ticket-status-control")).toBeVisible({ timeout: 45_000 });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // …and by keyboard: the row is one button, so it takes focus and Enter.
    await page.getByTestId("tickets-filter-field").focus();
    const keyboardTarget = rows.filter({ hasText: "Autre ticket ouvert" });
    await keyboardTarget.focus();
    await expect(keyboardTarget).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("epic-detail-panel")).toBeVisible();
  });
});
