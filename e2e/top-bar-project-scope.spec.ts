import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";

/**
 * The bar's project scope, in a real browser.
 *
 * Off a `/projects/:id` route the top bar resolves Spec & Memory, Sessions and
 * Releases against the LAST PROJECT VISITED. That memory is document-local and
 * only seeded from `localStorage` — the shared key is where the choice survives
 * the document, never what the bar reads on every render. Both halves of that
 * are observable only with a second document writing the key and with a browser
 * that refuses the write, which is why they are pinned here as well as in
 * `__tests__/top-bar.test.tsx`.
 *
 * The two projects are the point: with a single one the resolution falls back
 * to "the only project there is" and proves nothing.
 */

/**
 * `LAST_PROJECT_STORAGE_KEY` in `lib/piscine/nav.ts`. Spelled out rather than
 * imported: the Playwright runner would have to pull the whole nav module, icons
 * included, to read one string. A rename fails this spec loudly — the menu comes
 * back pointed at the wrong project.
 */
const STORAGE_KEY = "arij:piscine:last-project";

interface ScratchProject {
  id: string;
  rootPath: string;
}

/**
 * A second project, created the way the fixture creates the first: a real
 * repository with an initial commit, because `POST /api/projects` validates the
 * path and the board's git surfaces expect a branch.
 */
async function createScratchProject(
  request: APIRequestContext,
  name: string,
): Promise<ScratchProject> {
  const rootPath = mkdtempSync(path.join(tmpdir(), "arij-e2e-scope-"));
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

async function removeScratchProject(request: APIRequestContext, project: ScratchProject) {
  const deleted = await request.delete(`/api/projects/${project.id}`);
  rmSync(project.rootPath, { recursive: true, force: true });
  expect(deleted.ok(), `DELETE /api/projects/${project.id} failed`).toBeTruthy();
}

/** Opens the Work menu the way a keyboard user does — a click would navigate. */
async function openWorkMenu(page: Page) {
  // Focus is what opens it, and focusing an element that already has focus
  // fires nothing: after an Escape the bubble still holds it, so hand focus
  // away before asking for it back.
  await page.getByTestId("top-bar-home").focus();
  await page.getByTestId("top-bar-bubble-work").focus();
  await expect(page.getByTestId("top-bar-menu-work")).toBeVisible();
}

async function readStoredProject(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

test("holds its project scope when another document rewrites the shared key", async ({
  page,
  request,
  project,
}, testInfo) => {
  const other = await createScratchProject(
    request,
    `E2E scope elsewhere #${testInfo.workerIndex}`,
  );

  try {
    await page.goto(project.boardUrl);
    await expect(page.getByTestId("top-bar")).toBeVisible();
    // The visit is recorded from an effect; the shared key is where it lands.
    await expect.poll(() => readStoredProject(page)).toBe(project.id);

    // Client-side navigation, so the document — and its memory — survives.
    await page.getByTestId("top-bar-home").click();
    await page.waitForURL(new URL("/", page.url()).toString());

    await openWorkMenu(page);
    await expect(page.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      `/projects/${project.id}/spec`,
    );

    // A second tab, writing the key this document is never told about.
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [STORAGE_KEY, other.id],
    );

    // Closing and reopening the menu is a render like any other. Nothing here
    // changed route, so nothing here may change project.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("top-bar-menu-work")).toHaveCount(0);
    await openWorkMenu(page);

    await expect(page.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      `/projects/${project.id}/spec`,
    );
    // The other per-project row of the same menu, so this pins the resolution
    // rather than one entry's markup.
    await expect(page.getByTestId("top-bar-entry-releases")).toHaveAttribute(
      "href",
      `/projects/${project.id}/releases`,
    );
    await page.screenshot({ path: testInfo.outputPath("scope-after-foreign-write.png") });
  } finally {
    await removeScratchProject(request, other);
  }
});

test("keeps resolving against a visit the browser refused to persist", async ({
  page,
  request,
  project,
}, testInfo) => {
  const other = await createScratchProject(
    request,
    `E2E scope unpersisted #${testInfo.workerIndex}`,
  );

  try {
    // An earlier document left `other` behind, and this one cannot write —
    // Safari private mode and a full quota both throw on `setItem`.
    await page.addInitScript(
      ([key, seeded]) => {
        window.localStorage.setItem(key, seeded);
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (storageKey: string, value: string) {
          if (storageKey === key) throw new Error("QuotaExceededError");
          return setItem.call(this, storageKey, value);
        };
      },
      [STORAGE_KEY, other.id],
    );

    await page.goto(project.boardUrl);
    await expect(page.getByTestId("top-bar")).toBeVisible();

    await page.getByTestId("top-bar-home").click();
    await page.waitForURL(new URL("/", page.url()).toString());

    // Nothing was persisted, and the visit is remembered all the same.
    expect(await readStoredProject(page)).toBe(other.id);

    await openWorkMenu(page);
    await expect(page.getByTestId("top-bar-entry-spec")).toHaveAttribute(
      "href",
      `/projects/${project.id}/spec`,
    );
    await page.screenshot({ path: testInfo.outputPath("scope-after-refused-write.png") });
  } finally {
    await removeScratchProject(request, other);
  }
});
