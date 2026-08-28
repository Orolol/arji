import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { CLI_STUB_BIN_DIR } from "./e2e/fixtures/cli-stub";
import { DATABASE_FILE } from "./e2e/fixtures/data-root";

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The bundled chromium by default — that is what `npx playwright install`
 * puts on a machine, so a plain `npm run test:e2e` works with no system
 * browser. Hosts where Playwright refuses to install it ("Playwright does not
 * support chromium on ubuntu26.04-x64") opt into a system browser explicitly:
 * `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.
 */
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL || undefined;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  /**
   * Capped rather than left at Playwright's default of half the cores, for the
   * same reason `vitest.config.ts` caps `maxWorkers` at 4: several agent
   * sessions share this machine. The arithmetic is also worse here than it
   * looks — every worker drives a browser AND competes for the SINGLE `next
   * dev` process behind them, which compiles routes on demand, so past a few
   * workers the extra parallelism buys queueing rather than throughput. Runs
   * observed at 8 workers took longer end to end than the same suite at 4, and
   * shed connections (`ECONNRESET`) while doing it.
   */
  workers: process.env.CI ? 1 : 4,
  reporter: "html",
  /**
   * Well above the 30s default, which is sized for a test that loads a page and
   * asserts on it. The journeys here are not that shape: a single case walks a
   * ticket through four guarded transitions, a real `git merge`, and a board
   * resync between stages — against ONE `next dev` that compiles routes on
   * demand and is shared by every worker. Several agent sessions also share
   * this machine, so the wall-clock spread between a quiet run and a busy one
   * is large while the work itself is unchanged.
   *
   * This buys headroom for a slow machine; it does not paper over a hang. Every
   * wait in the suite is on a specific event — a response, a locator, dnd-kit's
   * own drop indication — so a genuine hang still fails, just with a truthful
   * error instead of a timeout at an arbitrary point.
   */
  timeout: 90_000,
  expect: {
    /**
     * Above the 5s default because the thing being waited on is usually a
     * round trip to a dev server that may still be compiling the route, not a
     * local re-render. The assertions themselves are unchanged: a locator that
     * will never appear still fails, and the suite is not measurably slower
     * for it, since a passing expectation returns as soon as it is satisfied.
     */
    timeout: 15_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: CHANNEL },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    /** Merged over the runner's own environment by Playwright. */
    env: {
      NO_PROXY: "127.0.0.1,localhost",
      /**
       * The agent boundary, and the only part of a build-or-review journey
       * that is not the real thing.
       *
       * `lib/providers/*` spawn their CLI by bare name with the server's
       * environment, so prepending this directory is what makes `claude`
       * resolve to `e2e/fixtures/cli-stub/bin/claude` — a scripted agent that
       * commits in the worktree and files a verdict through the session's own
       * MCP token, in milliseconds and identically every time. PREPENDED, not
       * appended: a real CLI earlier on the PATH would take the dispatch, and
       * `assertCliStubInstalled` refuses to run a journey unless this entry
       * comes first.
       *
       * Only the server Playwright starts gets this. A dev server reused
       * through `reuseExistingServer` was started by someone else — see
       * e2e/README.md, and the preflight for what happens if it was started
       * without the stub.
       */
      PATH: `${CLI_STUB_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      /**
       * Where a spawned agent is told to call Arij back (the MCP channel's
       * base URL, lib/webhooks/send.ts). It defaults to `localhost:3000` —
       * a developer's ordinary dev server, not the one under test — so a
       * review's `submit_findings` would be filed against the wrong process.
       */
      ARIJ_BASE_URL: BASE_URL,
      /**
       * The database, named explicitly so the runner and the server cannot
       * disagree about it.
       *
       * The fixtures read stored state directly (the rendered board is not
       * dependable evidence right after a write — B-arij-141), so they have to
       * open the same file `lib/db/index.ts` does. Passing it here rather than
       * letting both sides infer it means the agreement holds even when the
       * developer's shell already exports `ARIJ_DB_PATH`, which resolves to a
       * different database than `<cwd>/data/arij.db`.
       */
      ARIJ_DB_PATH: DATABASE_FILE,
    },
  },
});
