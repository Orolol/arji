# Composite agents — HTTP boundary review fixes

Epic: E-BwEtdU8xBcbs, stories 3 and 7. Baseline: `9c262ebc`.
Correction commit: `0f82ccfc695dc27631b5011ea5bec495456b8062`.

## Findings addressed

- `b1UTdZyH7L5Q` (major): an explicitly selected empty composite still throws,
  but HTTP callers now return status 400 with its actionable message in
  `{ error }`. No alternative agent is selected. Both pickers disable a
  composite already known to have no members.
- `GC64PuZPPicL` (minor): conversation PATCH preserves the existing provider
  when selecting a composite; simple-agent selections still update it. The
  composite sentinel is no longer copied into this column by PATCH.
- `oPRYo3GNYtDO` (info): the workshop passes null to the per-agent statistics
  hook for composites, avoiding a request whose result was discarded.

## Boundary sweep

`withAgentResolutionErrors` covers all 18 direct resolver calls in 15 routes
under `/api/projects/[projectId]`:

- `build` (three calls), `chat`, `chat/stream`;
- `epics/[epicId]/build`, `epics/[epicId]/review`,
  `epics/[epicId]/resolve-merge`;
- `stories/[storyId]/build`, `stories/[storyId]/review`;
- `generate-spec`, `git/pull`, `releases`;
- `qa/check`, `qa/reports/[reportId]/create-epics`;
- `review-resolution`, `sessions/resumable` (two calls).

The no-role resumable path now unfolds the member too. Previously the raw
sentinel removed the provider filter and allowed unrelated agents' sessions
into the results. A nonexistent named agent still returns an empty list on
that path.

The shared `errorResponse` catch helper handles the same typed error for the
indirect dispatch routes: memory distillation, Dreaming, refinement, spec
update and manual grading. The spec-update route is exercised through its
actual dispatcher; the other four were traced in source and retain their
existing route tests. Background pipeline/session failure handling and
background resolution-chain skipping are unchanged. The wrapper applies
before an HTTP/SSE response is returned, and rethrows unrelated failures.

The error class lives in a dependency-free module, re-exported from the
resolver for existing callers. API error handling does not need to load the
resolver's provider machinery. An AST guard checks named direct resolver
imports and their enclosing common boundary; it does not claim to scan the
transitive background-dispatch graph.

## Evidence

The two new behavioral suites failed 10 cases on the baseline and passed
all 11 after the production fix. Two additional cases cover indirect spec
update and preservation of successful SSE responses/unrelated exceptions.
The AST guard adds one test, for 14 new tests total.

- HTTP tests use actual handlers, the resolver and a migrated in-memory SQLite
  database. Deleting the last member exercises the real cascade. They verify
  the response body/status, member-scoped resume candidates, refusal before
  chat message/session writes, and provider persistence after agent deletion.
- UI tests use actual Radix controls and the actual statistics hook. They
  assert disabled options reject clicks, simple members remain selectable,
  and selecting a composite causes no statistics HTTP request. Only roster,
  assignment and availability data, HTTP responses, and missing jsdom pointer
  APIs are substituted.
- The first full run found one outdated mock in `sessions-resumable-route`:
  the no-role branch now consults the resolver, so the fixture must supply its
  resolved provider/member. Its assertions were retained and extended. No
  production change was needed after that run.

| Final check | Result |
| --- | --- |
| Existing installation consistency | 6/6 passed; no reinstall |
| Complete Vitest suite | 617 files / 8,478 tests passed, 135.16 s |
| TypeScript | `tsc --noEmit` passed |
| ESLint | 0 errors / 25 warnings; none in correction files |
| Lint after the final test edits | Passed |
| Production build | Passed with `NODE_ENV=production`, isolated DB path |
| Existing composite workshop Playwright spec | 3/3 passed on production build, system Chrome, isolated DB and free port |

Browser tests measure keyboard focus outlines in day/night and document
horizontal overflow at 390 px. Screenshots were inspected and attached as
`U5-POh3Ub53C` (day), `YnTAvCH8jvK4` (night), and `UwK2lnLZGvIw` (390 px;
this screenshot shows the roster, not the off-screen editor).
No real AI CLI was executed. The full suite's argv tests use stub binaries;
the new boundary tests refuse before execution.

## Integration and scope

Measured against local `main` at
`3183240e6669575474cd556ceb6cc85cb3780205`, merge-base `77b00390`:
main changed 440 paths; the implementation branch at `0f82ccfc` changed 99;
13 overlap. `git merge-tree --write-tree main HEAD` reports nine conflicts:
`AddAgentCard`, `AgentIdentityCard`, `AgentRosterCard`, `AssignmentsView`,
`TheNumbersBand`, `WhereHeWorksBand`, `SessionInfoCard`, `AgentSelectPill`,
and `NamedAgentSelect`. Main was not merged; B-arij-275 remains the i18n
integration follow-up. No validation of a merged result is claimed.

Main's journal ends at `0052`; this branch ends at `0055`. No migration-number
collision, and journal indices/timestamps strictly increase. This correction
adds no migration. The earlier validation on a real development DB copy was
not repeated; current tests apply the migration chain to isolated databases.
Both conflict and migration reconciliation expire when main advances and
must be repeated at merge.

The provider fix protects future PATCH writes; it does not backfill any
previously stored sentinel values. No historical provider rows were measured
or rewritten. The specification, earlier QA reports, other docs, `CLAUDE.md`
and `arji.json` are unchanged; this report is the only new prose artifact.
Temporary databases and the local screenshot copies were removed after
attachment. The test server stopped, no development/build lock remains, and
no server on port 3000 was touched. Normal ignored build/test caches remain.
