import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3100;

/**
 * `localhost`, not `127.0.0.1`.
 *
 * Next 16.3 blocks cross-site requests to `/_next/*` dev resources, and its
 * default allowlist is `['**.localhost', 'localhost']` plus whatever
 * `--hostname` bound. Chrome labels the chunk `<script>` loads of a page served
 * from an IP literal `Sec-Fetch-Site: cross-site`, so from `127.0.0.1` every
 * `/_next/static/chunks/*.js` comes back 403: the page server-renders but never
 * hydrates, and every spec that needs client data or interaction fails on a
 * skeleton. Only the static-markup smoke tests survive it.
 *
 * next.config.ts now also lists the loopback IPs in `allowedDevOrigins`, so a
 * developer browsing `http://127.0.0.1:3000` gets a page that hydrates. The
 * base URL stays on `localhost` anyway: it is what Next trusts with no config
 * at all, so the suite keeps working even if that setting is changed, and it
 * drives the app by the host a developer actually types.
 */
const BASE_URL = `http://localhost:${PORT}`;

/**
 * The bundled chromium by default — that is what `npx playwright install`
 * puts on a machine, so a plain `npm run test:e2e` works with no system
 * browser. Hosts where Playwright refuses to install it ("Playwright does not
 * support chromium on ubuntu26.04-x64") opt into a system browser explicitly:
 * `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.
 */
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL || undefined;

/**
 * `next dev` locally, `next start` on CI.
 *
 * `next dev` compiles each route the first time it is requested. Measured cold
 * on a development machine, the board took ~12s from navigation to a hydrated
 * heading — well past the 5s an `expect` waits — so the first spec to touch a
 * route fails while every later one passes. That is the worst kind of CI red:
 * order-dependent, unreproducible warm, and indistinguishable from a real
 * regression. A production server has no per-route compile step, so the
 * latency and the tuning it would need both disappear, and the suite exercises
 * the bundle that actually ships.
 *
 * Requires `npm run build` first; without it `next start` exits immediately
 * saying so, which is a far better failure than a webServer timeout. Override
 * with `E2E_SERVER=dev|start` to run either mode anywhere.
 */
const SERVER_MODE =
  process.env.E2E_SERVER ?? (process.env.CI ? "start" : "dev");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Locally the machine is shared with agent sessions and vitest runs;
  // Playwright's default (half the cores) plus one Chrome per worker is too
  // greedy next to them.
  workers: process.env.CI ? 1 : 4,

  // The generous waits belong to `next dev`, not to the assertions: a route
  // being compiled for the first time can take ~12s to reach a hydrated page,
  // and under `fullyParallel` several workers hit cold routes at once. Tying
  // the allowance to the server mode keeps it where the latency actually is —
  // a production server compiles nothing, so CI keeps the tight 5s/30s and a
  // real failure there is reported in seconds rather than minutes.
  timeout: SERVER_MODE === "dev" ? 90_000 : 30_000,
  expect: { timeout: SERVER_MODE === "dev" ? 30_000 : 5_000 },
  // Locally the HTML report is the whole point — it opens on failure. On CI
  // nothing opens it, and `html` alone prints almost nothing while it runs, so
  // a red job would say only "some tests failed" until someone downloads the
  // artifact. `github` adds the per-test progress and annotates the failing
  // lines in the diff; `html` still writes playwright-report/ for the artifact.
  reporter: process.env.CI ? [["github"], ["html"]] : "html",
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
    command:
      SERVER_MODE === "start"
        ? `npm run start -- --port ${PORT}`
        : `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NO_PROXY: "127.0.0.1,localhost",
    },
  },
});
