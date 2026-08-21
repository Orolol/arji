# Ticket state machine and automatic-transition inventory

This document is the executable transition contract for epics and stories.
`lib/workflow/transition-service.ts` is the only module that writes an existing
epic/story `status`: `applyTransition` writes epics and
`applyStoryTransition` writes stories. Both validate through
`lib/workflow/engine.ts` and log successful moves; epic moves also emit a
board event. Both write an identifiable same-state activity entry when a guard
refuses a move. Inserts may set an initial status; those are ticket creation,
not state transitions.

## Resulting state machine

| From | To | Trigger/reason | Production source |
|---|---|---|---|
| `backlog` | `todo` | planning / drag | epic PATCH, reorder, MCP |
| `backlog` or `todo` | `in_progress` | build accepted; transition completes **before** `queued` session insert | `automatic-transitions.ts` via manual build, batch/night, pipeline and Full Auto |
| `in_progress` | `review` | successful build (`answered` and legacy successful outcomes); epic scope advances only stories already `in_progress` (a story added mid-build stays `todo`), story scope only promotes the parent after every story is `review`/`done` | `automatic-transitions.ts` |
| current | current | failed build, unanswered question, successful story with siblings remaining, or refused terminal promotion; no status write, explicit activity reason, terminal handlers continue posting agent output. A refusal persists `transition_refused`, settles pipeline/wave work as failed, emits failure feedback, and counts toward Full Auto parking | terminal outcome helper / question handler |
| `review` or `done` | `in_progress` | negative review / requested changes; the review session is already terminal | `automatic-transitions.ts` via review routes and pipeline |
| `review` | `done` | explicit approval or merge; requires a completed review and zero open comments | approve/merge routes, Full Auto merge |
| story `review` | story `done` | explicit human story approval does not require a separate story review-agent session and never mutates epic-scoped findings; parent completion is attempted separately under the strict epic guards | story approve route |
| `done` | `released` | release creation, system actor only | releases route |
| any structurally allowed edge | target | manual drag/API/MCP or guarded `arji.json` reconciliation | epic/story PATCH, reorder, MCP, sync import |

The structural edge list lives in `lib/workflow/engine.ts`. `released` is
terminal. `review → done` cannot be achieved by drag/API; its source must be
`approve` or `merge`. An `in_progress` ticket cannot leave the column while a
`build`, `ticket_build`, or `team_build` session is queued/running; review,
chat, merge and auxiliary sessions do not own that column. Full Auto
deliberately includes backlog: backlog/todo/in-progress are candidates, and
the driver owns the move to `in_progress`. A rejected review returning to
`in_progress` remains automatically buildable. Epic approval advances only
children already in `review`; todo/in-progress children are retained and named
in the activity log, returned as `skippedStories`, and shown persistently on a
delivered epic card as an unfinished-stories warning.

## Exhaustive workflow-service call sites

Line numbers are for this revision. Calls inside
`lib/workflow/automatic-transitions.ts` cover every automatic driver; callers
must not repeat SQL/event/log logic.

### Shared automatic driver

- `lib/workflow/automatic-transitions.ts:91,123,153` — story service adapter and build-start epic preflight/apply; story moves use the adapter.
- `lib/workflow/automatic-transitions.ts:239,291,335,370` — non-throwing successful build promotion and all-stories gate.
- `lib/workflow/automatic-transitions.ts:426,440,456,469` — negative review to `in_progress` for epic/story scope.
- `lib/pipeline/stages.ts:593,759,891,909` — pipeline build start, consumed terminal outcome, negative review.
- `app/api/projects/[projectId]/epics/[epicId]/build/route.ts:253,339` — manual epic build.
- `app/api/projects/[projectId]/stories/[storyId]/build/route.ts:218,306` — manual story build.
- `app/api/projects/[projectId]/build/route.ts:246,288,402,540,621` — team preflight/apply, isolated team terminal decisions, batch/night build start, and terminal outcome.
- `app/api/projects/[projectId]/epics/[epicId]/review/route.ts:363` and `stories/[storyId]/review/route.ts:354` — manual negative review.

Full Auto itself does not write status: `lib/auto-mode/select.ts` selects and
`lib/auto-mode/engine.ts` dispatches through `lib/pipeline/stages.ts`.

### Manual, approval, merge and reconciliation calls

- `app/api/mcp/update-ticket-status/route.ts:44` — MCP/manual agent request.
- `app/api/projects/[projectId]/epics/[epicId]/route.ts:49` — epic PATCH.
- `app/api/projects/[projectId]/epics/reorder/route.ts:79,118` — drag preflight and apply.
- `app/api/projects/[projectId]/stories/[storyId]/route.ts:62` and `user-stories/route.ts:103` — story PATCH variants.
- `app/api/projects/[projectId]/epics/[epicId]/approve/route.ts:60,78,103` — epic approval plus eligible reviewed stories; skipped child states are logged.
- `app/api/projects/[projectId]/stories/[storyId]/approve/route.ts:51,70,82,98` — explicit story approval (without resolving epic findings) and separately guarded last-story epic completion.
- `app/api/projects/[projectId]/epics/[epicId]/merge/route.ts:63,99,238` — manual merge preflight/finalization and merge-fix finalization.
- `app/api/projects/[projectId]/epics/[epicId]/resolve-merge/route.ts:105,128,282,303` — clean/conflicted merge resolution.
- `lib/auto-mode/merge.ts:162,320` — Full Auto merge finalization and preflight.
- `app/api/projects/[projectId]/releases/route.ts:451` — `done → released`.
- `lib/sync/import.ts:88,162` — guarded status changes for existing imported epics/stories; refused statuses are logged, returned in `statusesSkipped`, and skipped while other content continues. Epic move events are emitted only after commit. New rows only receive an initial status.

The only existing-ticket status writes are therefore
`lib/workflow/transition-service.ts:139,217`. Project lifecycle status and
review-comment status are separate state machines and are outside this ticket
workflow.

## Regression suite mapping

All files below match Vitest's default include and therefore run under
`npm test`; `.github/workflows/ci.yml` runs that command on pushes and pull
requests.

| Invariant | Test |
|---|---|
| backlog/todo build dispatch reaches `in_progress` before a queued session | `automatic-transition-invariants.test.ts` — “no orphaned build sessions” |
| story dispatch also moves its parent epic | `automatic-transition-invariants.test.ts` — backlog parent test |
| a queued/running build owns `in_progress`; auxiliary sessions do not | `workflow-engine.test.ts`; `mcp-routes.test.ts` active-build route test |
| successful/`answered` build promotion; incomplete siblings stay with a reason | `automatic-transition-invariants.test.ts` — “deterministic build completion” |
| terminal refusal is non-throwing, preserves output, persists `transition_refused`, settles pipeline work as failed, and cannot revive a released ticket | `automatic-transition-invariants.test.ts`; `pipeline-stages-dispatch.test.ts`; `epic-build-asked-question.test.ts` |
| one refused team-build promotion does not abort later epics | `automatic-transition-invariants.test.ts` — team-build isolation regression |
| stories added mid-build stay todo; epic approval returns/logs non-review children and delivered cards warn while they remain unfinished | `automatic-transition-invariants.test.ts`; `workflow-approval-regressions.test.ts`; `epic-card.test.tsx` |
| story approval is explicit human review, preserves all epic-scoped findings, and holds the strict parent guard independently | `workflow-approval-regressions.test.ts` — multi-story finding regression |
| refused import statuses preserve content, are returned in `statusesSkipped`, and transaction rollback emits no phantom move | `arji-json-sync-roundtrip.test.ts` — guarded reconciliation regressions |
| error and `asked_question` terminal branches | `automatic-transition-invariants.test.ts` terminal tests; `epic-build-asked-question.test.ts` route regression |
| `review → done` needs completed review and no open comments | `workflow-engine.test.ts`; `auto-mode-merge.test.ts` |
| negative review returns to `in_progress` | `automatic-transition-invariants.test.ts`; `pipeline-stages-dispatch.test.ts` |
| occupied/awaiting tickets are excluded and consecutive sweeps do not double-dispatch | `auto-mode-select.test.ts`; `auto-mode-engine.test.ts` budget/idempotence tests |
| review freshness prevents infinite re-review | `auto-mode-select.test.ts`; `auto-mode-e2e.test.ts` |
| merge is refused until review is clean | `auto-mode-merge.test.ts`; `auto-mode-e2e.test.ts` |
| terminal hook cannot re-dispatch before promotion is attempted | `auto-mode-engine.test.ts` — kick deferral |
| refused terminal promotions feed the Full Auto failure/parking ladder instead of clearing it | `auto-mode-engine.test.ts` — `transition_refused` parking regression |

## Audit findings and B-arij-104

The audit found four concrete bypass classes: direct SQL in build/review
closures, direct SQL in approval/merge routes, direct status fields in
epic/story PATCH/reorder, and status overwrite during `arji.json`
reconciliation. They now converge on the workflow service.

The orphan symptom had two causes: Full Auto did not select backlog even
though other build entry points did, and dispatchers inserted a `queued`
session before changing status. Story-scoped builds also left their parent in
backlog/todo. Backlog is now intentionally eligible, and the guarded parent +
target transition precedes session creation.

B-arij-104 was reproducible as the story-scope all-siblings gate: a completed
story moved itself to review, but an epic with other todo/in-progress stories
correctly remained in progress and wrote no explanation. `answered` was
already treated as successful delivery; the missing behavior was the activity
decision. The shared terminal helper now either promotes the epic or logs the
exact remaining-story count. Errors and questions likewise leave explicit
reasons. The existing 250 ms terminal-hook deferral remains the no-repickup
barrier: promotion/hold logic finishes before the next Full Auto sweep.

The refusal-path review additionally found that a terminal guard failure could
throw before the agent comment was inserted, one refused team epic could abort
the rest of its batch, approval attempted structurally impossible child edges,
and `arji.json` emitted moves before its transaction committed. Completion now
returns a logged `refused` outcome instead of throwing; team iterations remain
isolated; approval touches only eligible child states; and sync events flush
only after a successful commit.

The second refusal-path review found two overshoots in those fixes. Story
approval had started bulk-resolving every finding on its parent epic; it now
bypasses the epic-scoped comment guard only for the child move and leaves all
findings intact for parent approval. Terminal refusal was produced but not
consumed; it is now persisted on the session, converted to a failed
pipeline/wave settle, rendered as “Transition held”, and charged by Full
Auto. Guarded `arji.json` imports expose every skipped target and reason in
their API summary. Finally, approved epics with untouched child stories return
those children and keep an unfinished-story warning visible on the card.
