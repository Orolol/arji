# Ticket state machine and automatic-transition inventory

This document is the executable transition contract for epics and stories.
`lib/workflow/transition-service.ts` is the only module that writes an existing
epic/story `status`: `applyTransition` writes epics and
`applyStoryTransition` writes stories. Both validate through
`lib/workflow/engine.ts`, emit/log successful moves, and write an identifiable
same-state activity entry when a guard refuses a move. Inserts may set an
initial status; those are ticket creation, not state transitions.

## Resulting state machine

| From | To | Trigger/reason | Production source |
|---|---|---|---|
| `backlog` | `todo` | planning / drag | epic PATCH, reorder, MCP |
| `backlog` or `todo` | `in_progress` | build accepted; transition completes **before** `queued` session insert | `automatic-transitions.ts` via manual build, batch/night, pipeline and Full Auto |
| `in_progress` | `review` | successful build (`answered` and legacy successful outcomes); epic scope immediately, story scope only promotes the parent after every story is `review`/`done` | `automatic-transitions.ts` |
| `in_progress` | `in_progress` | failed build, unanswered question, or successful story with siblings remaining; no write, explicit activity reason | terminal outcome helper / question handler |
| `review` or `done` | `in_progress` | negative review / requested changes; the review session is already terminal | `automatic-transitions.ts` via review routes and pipeline |
| `review` | `done` | explicit approval or merge; requires a completed review and zero open comments | approve/merge routes, Full Auto merge |
| `done` | `released` | release creation, system actor only | releases route |
| any structurally allowed edge | target | manual drag/API/MCP or guarded `arji.json` reconciliation | epic/story PATCH, reorder, MCP, sync import |

The structural edge list lives in `lib/workflow/engine.ts`. `released` is
terminal. `review → done` cannot be achieved by drag/API; its source must be
`approve` or `merge`. An `in_progress` ticket cannot leave the column while a
`build`, `ticket_build`, or `team_build` session is queued/running; review,
chat, merge and auxiliary sessions do not own that column. Full Auto
deliberately includes backlog: backlog/todo/in-progress are candidates, and
the driver owns the move to `in_progress`. A rejected review returning to
`in_progress` remains automatically buildable.

## Exhaustive workflow-service call sites

Line numbers are for this revision. Calls inside
`lib/workflow/automatic-transitions.ts` cover every automatic driver; callers
must not repeat SQL/event/log logic.

### Shared automatic driver

- `lib/workflow/automatic-transitions.ts:81,111,139` — story service adapter and build-start epic preflight/apply; story moves use the adapter.
- `lib/workflow/automatic-transitions.ts:201,242,279,307` — successful build promotion and all-stories gate.
- `lib/workflow/automatic-transitions.ts:350,364,380,393` — negative review to `in_progress` for epic/story scope.
- `lib/pipeline/stages.ts:591,753,881,899` — pipeline build start, terminal outcome, negative review.
- `app/api/projects/[projectId]/epics/[epicId]/build/route.ts:252,338` — manual epic build.
- `app/api/projects/[projectId]/stories/[storyId]/build/route.ts:217,305` — manual story build.
- `app/api/projects/[projectId]/build/route.ts:261,406,523,604` — team/batch/night build start, team-build failure decision, and terminal outcome.
- `app/api/projects/[projectId]/epics/[epicId]/review/route.ts:363` and `stories/[storyId]/review/route.ts:354` — manual negative review.

Full Auto itself does not write status: `lib/auto-mode/select.ts` selects and
`lib/auto-mode/engine.ts` dispatches through `lib/pipeline/stages.ts`.

### Manual, approval, merge and reconciliation calls

- `app/api/mcp/update-ticket-status/route.ts:44` — MCP/manual agent request.
- `app/api/projects/[projectId]/epics/[epicId]/route.ts:49` — epic PATCH.
- `app/api/projects/[projectId]/epics/reorder/route.ts:79,118` — drag preflight and apply.
- `app/api/projects/[projectId]/stories/[storyId]/route.ts:62` and `user-stories/route.ts:103` — story PATCH variants.
- `app/api/projects/[projectId]/epics/[epicId]/approve/route.ts:53,71,96` — epic approval plus synchronized stories.
- `app/api/projects/[projectId]/stories/[storyId]/approve/route.ts:48,64,79,93` — story approval and last-story epic completion.
- `app/api/projects/[projectId]/epics/[epicId]/merge/route.ts:63,99,238` — manual merge preflight/finalization and merge-fix finalization.
- `app/api/projects/[projectId]/epics/[epicId]/resolve-merge/route.ts:105,128,282,303` — clean/conflicted merge resolution.
- `lib/auto-mode/merge.ts:162,320` — Full Auto merge finalization and preflight.
- `app/api/projects/[projectId]/releases/route.ts:451` — `done → released`.
- `lib/sync/import.ts:70,134` — guarded status changes for existing imported epics/stories; new rows only receive an initial status.

The only existing-ticket status writes are therefore
`lib/workflow/transition-service.ts:133,205`. Project lifecycle status and
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
| error and `asked_question` terminal branches | `automatic-transition-invariants.test.ts` terminal tests; `epic-build-asked-question.test.ts` route regression |
| `review → done` needs completed review and no open comments | `workflow-engine.test.ts`; `auto-mode-merge.test.ts` |
| negative review returns to `in_progress` | `automatic-transition-invariants.test.ts`; `pipeline-stages-dispatch.test.ts` |
| occupied/awaiting tickets are excluded and consecutive sweeps do not double-dispatch | `auto-mode-select.test.ts`; `auto-mode-engine.test.ts` budget/idempotence tests |
| review freshness prevents infinite re-review | `auto-mode-select.test.ts`; `auto-mode-e2e.test.ts` |
| merge is refused until review is clean | `auto-mode-merge.test.ts`; `auto-mode-e2e.test.ts` |
| terminal hook cannot re-dispatch before promotion is attempted | `auto-mode-engine.test.ts` — kick deferral |

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
