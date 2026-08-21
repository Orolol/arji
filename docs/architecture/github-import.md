# Importing a project from a GitHub URL

Arij can attach a project to a directory that already exists on disk, or clone
one from GitHub itself. This document covers the second path: what runs, where
the code lands, and which invariants the implementation is defending.

## Flow

```
User pastes a GitHub URL            app/projects/import/page.tsx
        |                           (GitHubUrlSelector validates inline with
        v                            the same parser the server uses)
POST /api/projects/clone            app/api/projects/clone/route.ts
  parseGitHubRepoInput(url)     ->  { owner, repo, ownerRepo, cloneUrl }
  resolveCloneDestination(...)  ->  <projects_root>/<owner>-<repo>
  cloneGitHubRepository(...)    ->  git clone (or fetch, if already there),
                                    then stamps the clone marker
  -> { path, ownerRepo, remoteUrl, defaultBranch, reused, managed }
        |
        v
POST /api/projects/import           unchanged: arij.json short-circuit,
  validatePath(path)                otherwise Claude analysis
  -> { preview, path, fromExistingFile }
        |
        v
POST /api/projects                  + githubOwnerRepo, gitRemoteUrl,
                                    defaultBranch. `clone_source` is NOT in
  deriveCloneProvenance(path)       the request: the route derives it from
                                    the marker on disk
  then epics, user stories, arij.json export
```

Cloning is a separate endpoint from analysis on purpose. The analysis route
stays unaware that clones exist, the two steps are independently testable, and
the UI can name them honestly — a multi-minute clone reported as "Analyzing"
reads as a hang.

The URL grammar lives in `lib/git/github-url.ts`, a pure module with no
`simple-git` import, so the import page validates in the browser with exactly
the function the clone route trusts server-side — the field and the server
cannot drift apart (`__tests__/github-remote-grammar-parity.test.ts` enforces
it).

## Where the code lands

```
<arij>/
  data/                    # SQLite DB, session logs   (gitignored)
  projects/                # clone root                (gitignored)
    <owner>-<repo>/        # the clone -> projects.git_repo_path
    .arij-worktrees/       # created by createWorktree()
```

The root is resolved by `resolveProjectsRoot()` (`lib/projects/workspace.ts`):
the `projects_root` setting when present, otherwise `<cwd>/projects`. Only an
absolute override is accepted — a relative path would move with the server's
working directory, so `parseProjectsRootSetting()` refuses it and the default
is used instead.

`createWorktree()` places worktrees at `path.join(repoPath, "..",
".arij-worktrees")`. With the clone at `projects/<owner>-<repo>`, they land in
`projects/.arij-worktrees` — which is why a single `/projects` rule in
`.gitignore` is enough to keep Arij's own repository clean when dogfooding.

The `<owner>-<repo>` name is deterministic and collision-free across owners,
which is what makes re-importing the same repository idempotent.

## The clone marker

`clone_source = "github"` is what later authorises Arij to delete a directory,
so it is never taken from a request. The clone service stamps every clone it
creates with `.git/arij-clone.json` (`lib/git/clone-marker.ts`), and
`deriveCloneProvenance()` (`lib/projects/clone-provenance.ts`) only grants
provenance when *both* hold: the path is inside the current projects root, and
the directory carries the marker. A pre-existing clone Arij merely reused is
never marked — it stays the user's.

The marker lives under `.git/` on purpose: git never shows it in `status`, it
cannot be committed by accident, and it is destroyed with the repository it
vouches for.

## Full clones only

There is no `--depth` and no `--single-branch`, and there must not be: Arij
creates worktrees from the default branch, computes merge bases when merging
epic branches, and tags releases (`lib/git/manager.ts`, `lib/git/release.ts`).
A shallow clone breaks `worktree add` and merge-base computation, and a
single-branch clone hides every branch the user might want to work from.

`__tests__/git-clone-command.test.ts` asserts the absence of both flags in the
generated argv, so a future "optimisation" fails the suite rather than
production.

## Credentials

The PAT lives in the `settings` table (`github_pat`), read by
`getGitHubTokenFromSettings()`. The `GITHUB_TOKEN` environment variable is
documented in some older notes but is not read by any code path.

The token is a last resort: every repository is first cloned anonymously, and
the PAT is only replayed when that attempt fails for a credential reason. The
authenticated retry runs as:

```
git -c http.extraHeader="Authorization: Basic <base64(x-access-token:PAT)>" \
    clone -- <clean-https-url> <staging-dir>
```

Passing the header with `-c` scopes it to that one command: it never reaches
`.git/config`, and `origin` keeps the clean URL, so the clone is exactly what a
hand-made one would be and no secret is stored on disk.

The cost of that choice is that the credential has to be re-supplied by every
later command that talks to the remote. The reuse path does so: refreshing an
existing clone runs `git fetch origin --prune` anonymously first, replays the
PAT the same way when refused, with prompts disabled
(`GIT_TERMINAL_PROMPT=0`) and the same timeout as the clone — an
unauthenticated fetch of a private repository would otherwise block on a
credential prompt with no terminal attached, which is a hang rather than an
error.

Every string that can leave the clone layer — the HTTP response, the console
line, the `git_sync_log` row — goes through `redactGitError()`, which strips
the injected `Basic` header, URL userinfo, bearer tokens, raw GitHub token
shapes, and any exact secret the caller passes in.

> **Known gap.** `pushGitBranch()`, `pullGitBranchWithConflictSupport()` and
> the release tagging in `lib/git/remote.ts` / `lib/git/release.ts` still run
> unauthenticated. They predate the import flow and are unaffected by it, but a
> private repository imported this way will need a credential helper for push
> until they route through the same authenticated transport.

## Default branch

`projects.default_branch` records what the clone actually checked out — for a
fresh clone that is what the *remote* considers default, not whatever the
`main`-else-`master` convention guesses.

This matters beyond display: `createWorktree()`, `mergeWorktree()` and the
release flow base branches through `resolveBaseBranch()`
(`lib/git/base-branch.ts`), in order of preference: the branch stored for the
project when it still exists locally, then `origin/HEAD`, then the `main` /
`master` convention, then whatever branch the repository does have. Each step
is a fact about the repository, so the guess is only reached when the
repository has told us nothing — a repo whose default is `trunk` or `develop`
imports cleanly and builds its first epic on the right branch.

## Safety properties

| Property | Where it is enforced |
|---|---|
| A pasted string can never escape the clone root | `parseGitHubRepoInput()` (`lib/git/github-url.ts`) re-validates owner and repo against `^[A-Za-z0-9._-]+$` and rejects `.`, a leading `-`, and any embedded `..` — stricter than filesystem-level need, matching the belt-and-braces posture of `validatePath()` |
| …even if it did | `assertInsideRoot()` (`lib/projects/workspace-path.ts`) resolves the destination and refuses anything that is not a strict descendant of the root |
| An existing directory is never overwritten | matching repository → fetch and reuse; anything else → `409 conflict` naming what is in the way. The clone itself is assembled in a private staging directory and renamed into place only on success |
| A failed clone leaves nothing behind | the staging directory is removed on every failure path; a destination that appeared mid-clone is left untouched |
| Two concurrent imports of one repo do not race | clones are serialized per destination (`lib/git/clone-lock.ts`) |
| Only Arij-created directories are Arij's to delete | `projects.clone_source = 'github'`, granted exclusively by `deriveCloneProvenance()` from the on-disk marker — a request cannot state provenance, and the create/update schemas do not even carry the field |
| A stored remote URL never carries a credential | the recorded `remoteUrl` is the normalised `https://github.com/<owner>/<repo>.git` rebuilt from the parse result; a URL with userinfo does not parse and is rejected outright |

## Data model

Migration `0028_project_clone_source` adds three nullable columns to
`projects`: `clone_source`, `git_remote_url`, `default_branch`. Existing rows
keep `NULL` and behave exactly as before.

Migration `0029_git_sync_log_nullable_project` makes `git_sync_log.project_id`
nullable: a clone is logged before any project row exists, so the audit row for
`operation = 'clone'` has no project to point at.

Both are hand-written. `npx drizzle-kit generate` must not be run on this
repository — the snapshots under `meta/` stop at 0013 while the journal is far
ahead, so generate would diff against stale state.

## Out of scope

Non-GitHub hosts (GitLab, Bitbucket, self-hosted), SSH-key-based clones of
private repositories, background/queued cloning with cancellation, and
monorepo sub-directory imports. The parsing layer is written so a second host
can be added without touching the clone service.

## Tests

| Area | File |
|---|---|
| URL grammar, traversal payloads, parser properties | `__tests__/github-repo-input-parsing.test.ts` |
| Client-side parser stays importable without simple-git | `__tests__/github-url-client-parser.test.ts` |
| Server and client parse with one grammar | `__tests__/github-remote-grammar-parity.test.ts` |
| Clone root, destination, containment | `__tests__/clone-lifecycle-guards.test.ts`, `__tests__/workspace-path-guard.test.ts` |
| git argv, staging, reuse fetch, error classification (simple-git mocked) | `__tests__/git-clone-command.test.ts` |
| Real clones against local `file://` repositories | `__tests__/git-clone-service.test.ts` |
| Redaction | `__tests__/git-clone-redaction.test.ts` |
| Clone route: statuses, reuse, sync log, no PAT leak | `__tests__/projects-clone-route.test.ts`, `__tests__/clone-lifecycle-clone-route.test.ts` |
| Marker-based provenance | `__tests__/clone-lifecycle-provenance.test.ts` |
| Project creation through the route: provenance from disk, path checks | `__tests__/projects-route-post.test.ts` |
| Base-branch resolution (stored default, `origin/HEAD`) | `__tests__/worktree-manager.test.ts` |
| Import page in jsdom | `__tests__/import-page-github-flow.test.tsx`, `__tests__/github-url-selector.test.tsx` |
| The `/projects` rule keeps dogfooding clean | `__tests__/projects-workspace-gitignore.test.ts` |

No test performs a network clone: the service suite clones from local
temporary repositories over `file://`, and everything else mocks `simple-git`
or stubs the endpoints.
