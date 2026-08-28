# End-to-end suite

```
npm run test:e2e
```

Playwright starts `next dev` itself (port 3100 by default) and drives the real
routes — no mocked fetches. Three things are worth knowing before the first
run: which browser it drives, what stands in for the agent CLIs, and how to
point it at a dev server that is already up.

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

## The agent boundary

`build-review-merge.spec.ts` dispatches a real build and a real review — the
routes, the worktree, the session rows, the MCP token and every workflow
transition are the product's. The one thing it does not run is the CLI child
process those dispatches spawn: a real agent is slow, billed, and never twice
the same.

So the CLI, and only the CLI, is replaced. `e2e/fixtures/cli-stub/bin/` holds a
`claude`, `codex`, `omp` and `agy` that Arij spawns by bare name off the dev
server's PATH; `playwright.config.ts` prepends that directory (and sets
`ARIJ_BASE_URL`, which is what a spawned agent is told to call Arij back on).
The `claude` one plays a scenario the test wrote in advance: it commits in the
worktree it was given and files its verdict through the session's own
`submit_findings`. The other three refuse to run agents, so a dispatch that
resolves to the wrong provider fails loudly instead of reaching a real CLI.

Nothing is dispatched until `assertCliStubInstalled` has proved the server
under test really spawns them, so a misconfigured run fails with an
explanation instead of spending a real agent.

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

A reused server was started by you, so it does not have the stub PATH or the
base URL that `webServer.env` would have given it — start it with both:

```
PATH="$PWD/e2e/fixtures/cli-stub/bin:$PATH" ARIJ_BASE_URL=http://127.0.0.1:3199 \
  npm run dev -- --port 3199
```

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
