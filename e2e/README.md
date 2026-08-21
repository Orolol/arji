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
