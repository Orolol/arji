# Composite agents: grading ladder and picker initialization

Epic: E-BwEtdU8xBcbs. Reviewed baseline: `17e8c49d`.
Corrections: `668ee38f` (story 4) and `1801ca48` (story 7).
Measured against local `main` at `3183240e6669575474cd556ceb6cc85cb3780205`.

## Review findings addressed

- `_QfbXZGQgDDT`: grading now resolves the `grading` role independently of
  the configured reviewer. Budget calculation and dispatch share the cached
  stage resolution. The real grading dispatcher receives the member selected
  for the requested attempt and persists its member and composite IDs.
  Descent metadata reaches the runner's existing activity logger.
- `VXrgW8mC5sD0`: `NamedAgentSelect` uses a defined controlled value in its
  loading, empty and loaded branches, including null/cleared caller values.
  Loading/empty text remains visible even with a preselected agent ID.

The grader has two production callers: the pipeline adapter now supplies
ranked resolution; the manual grading route retains its ordinary explicit
choice/role resolution. Resolution remains deferred until after rubric and
scope validation, preserving the journalled no-op for rubric-free tickets.

## Regression evidence

`__tests__/pipeline-grading-composite.test.ts` uses the actual resolver, stage
driver, grading dispatcher, migrated SQLite schema, lifecycle writes and
activity logger. Git, scheduler, prompt assembly and process execution are
stubbed; these tests do not run an AI CLI.

Before the production fix, four tests failed: grading used the review list's
budget (3 instead of 2), repeated the first grader, ignored the project grader
when sizing the budget, and scheduled three attempts instead of two. All five
final tests pass, including the additional rubric-free skip check. They verify
the provider/model passed to the process manager, both persisted IDs, member
order, fixed simple-agent identity across four attempts, refreshed resolution
on the next stage entry, forensic exhaustion, and persisted descent text.

`__tests__/named-agent-select-loading.test.tsx` uses the actual Radix Select and
roster hook with a deferred HTTP response, outside a form. Before the fix,
three cases emitted controlled/uncontrolled warnings. All five final cases
pass, covering a fixed selection, null selection with and without clearing,
an empty roster, caller value changes, visible state text and no unsolicited
`onChange`. The separate hidden-input event behavior inside forms was not
tested by this revision.

## Final validation

| Check | Result |
| --- | --- |
| Existing installation consistency | 6/6 passed; no reinstall required |
| Complete Vitest suite on the final code | 614 files, 8,464 tests passed; 138.80 s |
| `npx tsc --noEmit` | Passed |
| Full ESLint run | 0 errors, 25 warnings; none in files changed by this revision |
| Final focused ESLint run | Passed with no warnings |
| Production `npm run build` | Passed with `NODE_ENV=production` and a temporary DB |
| Composite workshop Playwright spec | 3/3 passed on that production build, system Chrome, port 3291 |

The browser checks measure keyboard focus in both themes and document overflow
at 390 px. Screenshots were inspected and attached to the Arij session:
`6GYRJSed09Rh` (day), `8lSyHxGMFGmA` (night), `EcpvzaK0C891` (390 px).
No real Codex or Antigravity behavior is claimed. The existing argv tests in
the complete suite also use stub binaries.

An earlier full-suite run started during the picker edit and caught two
intermediate placeholder failures plus the known 10 ms timing assertion in
`refinement-button.test.tsx:197`. The placeholder issue was corrected before
the final commit. The refinement flake was reported as occurrence 26 of
friction `7U21HTjsPNfh`; its test and production code were left unchanged.
The final complete run above had no failures. The misleading native-select
test mock/comment was separately recorded as friction `TM8r6Eu4VSWJ`.

## Integration and boundaries

At the named main tip, the merge-base is `77b00390a359a9a909e8d9cbcafb420bc7582150`.
Main changed 440 paths; the implementation branch changed 84 paths before
this report; 13 paths overlap. A read-only merge preview reports nine conflicts:
`AddAgentCard`, `AgentIdentityCard`, `AgentRosterCard`, `AssignmentsView`,
`TheNumbersBand`, `WhereHeWorksBand`, `SessionInfoCard`, `AgentSelectPill`, and
`NamedAgentSelect`. The last is an additional conflict introduced by the picker
fix. Main was not merged. No merged-result or i18n integration validation is
claimed; the existing integration follow-up B-arij-275 remains applicable.

Main adds no migrations beyond `0052`; branch migrations `0053`–`0055` do not
collide, and journal indices/timestamps strictly increase. This correction
changes no schema or migration. The real development-DB-copy migration check
belongs to the preceding review; it was not repeated here. The current tests
do apply the real migration chain to isolated test databases. Migration and
conflict reconciliation expire as main advances and must be repeated at merge.

The stored specification already describes the intended ladder and was not
rewritten in this correction. This QA report is the only prose artifact added;
existing docs, `CLAUDE.md` and `arji.json` were left unchanged. Temporary build
and browser databases were removed, the browser server stopped, and the stale
development lock for absent PID 712749/port 3187 was removed after checking
that neither process nor listener existed. No application server on port 3000
was stopped or modified.
