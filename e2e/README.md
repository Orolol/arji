# End-to-end suite

```
npm run test:e2e
```

Playwright starts `next dev` itself (port 3100 by default) and drives the real
routes — no mocked fetches. Two things about this host are worth knowing before
the first run.

## The browser

The bundled chromium, i.e. whatever `npx playwright install` gave you — no
system browser required.

On hosts where that install refuses to run:

```
Playwright does not support chromium on ubuntu26.04-x64
```

opt into a system browser explicitly, per run:

```
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
```

Any Playwright channel name works (`chrome`, `msedge`, `chrome-beta`, …); the
value is passed straight through to the `chromium` project.

## Dev server here, production server on CI

Locally the suite drives `next dev`. On CI it drives `next start`, because
`next dev` compiles each route on first request: cold, the board took ~12s to
go from navigation to a hydrated heading, past the 5s an `expect` waits. That
makes the first spec to touch a route fail and every later one pass — an
order-dependent red that does not reproduce warm. A production server has no
per-route compile, so the suite also exercises the bundle that ships.

CI therefore runs `npm run build` before `npm run test:e2e`. Force either mode
anywhere with `E2E_SERVER`:

```
E2E_SERVER=start npm run test:e2e   # needs npm run build first
E2E_SERVER=dev npm run test:e2e
```

If you pick `start` without a build, `next start` says so and exits — the suite
does not hang.

Dev mode stays the local default, and absorbs those compiles with a longer
`expect` timeout (30s instead of 5s) and test timeout (90s instead of 30s). The
allowance is attached to the mode, not to the assertions, so a production run
keeps the tight defaults and reports a real failure in seconds.

## The host is `localhost`, not `127.0.0.1`

Next 16.3 blocks cross-site requests to `/_next/*` dev resources, and its
default allowlist is `localhost` (plus whatever `--hostname` bound). Chrome
labels the chunk `<script>` loads of a page served from an IP literal
`Sec-Fetch-Site: cross-site`, so served from `127.0.0.1` every
`/_next/static/chunks/*.js` returns 403.

The symptom is not an error — it is a page that renders and does nothing: the
server markup is there, hydration never runs, and specs fail on a skeleton
(`h1` stuck at `...`, `0 tickets visible`, SSE `Offline`). Only the
static-markup smoke tests pass.

`next.config.ts` now lists `127.0.0.1` and `[::1]` in `allowedDevOrigins`, so
browsing the app on a loopback IP works too. The base URL stays on `localhost`
regardless: that is what Next trusts with no config at all, so the suite does
not depend on that setting being right. If you point it somewhere by hand,
keep it on `localhost`.

`__tests__/next-config-dev-origins.test.ts` pins the two layers together —
every loopback host `middleware.ts` accepts for `/api/*` must also be served
`/_next/*`. A Next upgrade that changes the rule fails that test rather than
this suite.

## Reuse a dev server that is already running

Next 16 holds a lock on `.next/dev`, so a second `next dev` in the same
directory refuses to start:

```
Unable to acquire lock at .../.next/dev/lock, is another instance of next dev running?
```

If a dev server is already up for this worktree, point the suite at it instead
of letting it spawn its own — `reuseExistingServer` then finds it and skips the
spawn entirely:

```
E2E_PORT=3199 npm run test:e2e
```

## Never wait for `networkidle`

A project-scoped page opens a Server-Sent Events stream and holds it open for
the life of the page. `useProjectEvents` connects an `EventSource` to
`/api/projects/:id/events`; the route keeps the response open, writes a
`: heartbeat` comment every 30s, and the hook reconnects with backoff whenever
it drops. Playwright calls a page idle only after 500ms with no network
connection in flight, so on the board, a ticket detail, or the spec page there
is always one and it never gets there.

Both of these therefore burn the full test timeout and then fail:

```ts
await page.goto(project.boardUrl, { waitUntil: "networkidle" });  // don't
await page.waitForLoadState("networkidle");                       // don't
```

**The symptom is a test that times out with no failed assertion.** Playwright
reports `Test timeout of 90000ms exceeded` and points at the navigation line —
there is no expect failure, no console error, and the trace shows a page that
rendered fine. It reads like a slow board or a stuck fixture, so the reflex is
to raise the timeout, which only makes the next run take longer to fail.

Wait for the document, then assert on what you actually need:

```ts
await page.goto(project.boardUrl, { waitUntil: "domcontentloaded" });
await expect(page.getByTestId("header-new-button")).toBeVisible();
```

`domcontentloaded` returns as soon as the markup parses, and the explicit
assertion on an element that only exists once the page is interactive is what
makes the wait mean something — auto-retried up to the `expect` timeout, and
failing with the selector it gave up on rather than with a stopwatch. The
suite's plain `page.goto(url)` is fine too: its default `load` fires on the
document's own resources and settles normally. `networkidle` is the one wait
that never does.

Measured on this branch against `next dev`, three runs each: with the stream
live, `waitForLoadState("networkidle")` on a hydrated board never settled — it
threw at its 15s cap every time. With
`page.route("**/api/projects/*/events", r => r.abort())` aborting that one
request and nothing else changed, the same call returned in ~1.7s (1660 ms,
1684 ms, 1750 ms). One request is the whole difference.
`__tests__/e2e-networkidle-doc.test.ts` keeps this note in place and fails if a
spec reintroduces the wait.

## Test data

Every spec that needs a board uses the `project` fixture
(`e2e/fixtures/arij-project.ts`): it creates its own project against a scratch
git repo under the OS temp directory, and deletes both afterwards. Tests never
share a board, so they stay safe under `fullyParallel`, and the `arji.json`
export a board write triggers lands in the scratch repo rather than in this one.

The suite runs against your real dev database, so teardown has to put it back
as it found it. `DELETE /api/projects/:id` cascades the board rows, but an
upload is not reachable from a project: `chat_attachments` rows carry
`chat_message_id = NULL` and no project column, and the bytes sit in
`data/uploads/<projectId>/`. The fixture therefore deletes those rows and that
directory itself, and **asserts** both are gone — a run that leaks fails.

That cleanup needs the same `data/` the server writes to. It is derived from
the Playwright rootDir, which is right whenever Playwright starts the server;
if you reuse a dev server started from another directory, say so:

```
E2E_DATA_ROOT=/path/to/that/checkout/data E2E_PORT=3199 npm run test:e2e
```

Getting it wrong is loud, not silent: the fixture checks that the project it
just created is visible in that database before the test body runs.
