# Ticket state machine and automatic-transition inventory

This document is the executable transition contract for epics and stories.
`lib/workflow/transition-service.ts` is the only module that writes an existing
epic/story `status`: `applyTransition` writes epics and
`applyStoryTransition` writes stories. Both validate through
`lib/workflow/engine.ts` and log successful moves; epic moves also emit a
board event. Both write an identifiable same-state activity entry when a guard
refuses a move. Inserts may set an initial status; those are ticket creation,
not state transitions.

## The workflow (2026-08-27 refonte — the merge is the approval)

The epic lifecycle has exactly one human decision point, the merge:

1. A build agent finishes → the ticket moves to `review`.
2. The review agent's verdict decides: passing → `to_merge`;
   `changes_requested` → back to `in_progress`.
3. From `to_merge` the USER merges (with an optional merge-fix agent for
   conflicts). A successful merge moves the ticket to `done` and resolves
   whatever review comments were still open (`lib/workflow/merge-approval.ts`).

There is no manual approve step: `POST .../approve` (epic) was removed, and
`→ done` is only reachable with `source: "merge"`.

## Resulting state machine

| From | To | Trigger/reason | Production source |
|---|---|---|---|
| `backlog` | `todo` | planning / drag | epic PATCH, reorder, MCP |
| `backlog` or `todo` | `in_progress` | build accepted; transition completes **before** `queued` session insert. Full Auto is the exception on the source side: it selects and dispatches only from `todo`/`in_progress` (`BUILDABLE_EPIC_STATUSES`), so a `backlog` build comes from a manual dispatch, a batch/night run or a pipeline | `automatic-transitions.ts` via manual build, batch/night, pipeline and Full Auto |
| `review` or `to_merge` | `in_progress` | story-scoped build of a story left behind (added mid-build, or added to an epic already past In Progress); the epic reopens to finish it. Full Auto allows these parent statuses beyond its buildable set (`STORY_PARENT_BUILDABLE_STATUSES`) and refuses to merge an epic with such a story | `automatic-transitions.ts` via `transitionBuildStarted` |
| `in_progress` | `review` | successful build (`answered` and legacy successful outcomes); epic scope advances only stories already `in_progress` (a story added mid-build stays `todo`), story scope only promotes the parent after every story is `review`/`done` | `automatic-transitions.ts` |
| current | current | failed build, unanswered question, successful story with siblings remaining, or refused terminal promotion; no status write, explicit activity reason, terminal handlers continue posting agent output. A refusal persists `transition_refused`, settles pipeline/wave work as failed, emits failure feedback, and counts toward Full Auto parking | terminal outcome helper / question handler |
| `review`, `to_merge` or `done` | `in_progress` | negative review / requested changes; the review session is already terminal | `automatic-transitions.ts` via review routes and pipeline (`transitionReviewRejected`) |
| `review` | `to_merge` | PASSING review verdict (structured `submit_findings` verdict, or the prose scan for MCP-less providers). Requires a completed review that delivered evidence; a review on an MCP-capable provider that filed neither a verdict nor a finding row is *unverifiable*, leaves the ticket in `review`, and earns another review. A human may also drag/select this edge — the same completed-review guard applies | `automatic-transitions.ts` via `transitionReviewPassed` (pipeline `finalizeReviewSession`, epic review route); drag/API for humans |
| `to_merge` | `done` | successful merge ONLY (`source: "merge"`). The merge bulk-resolves the epic's remaining open review comments — the merge IS the approval. Conflicts dispatch a merge-fix agent whose retry finalizes the same way | merge / resolve-merge routes, Full Auto merge |
| story `review` | story `done` | explicit human story approval (`source: "approve"`, no separate review-agent session required) or the parent epic's merge cascade (`completeReviewedStories`). Story approval never merges or closes the epic | story approve route; merge cascade |
| `done` | `released` | release creation, system actor only | releases route |
| any structurally allowed edge | target | manual drag/API/MCP or guarded `arji.json` reconciliation | epic/story PATCH, reorder, MCP, sync import |

The structural edge lists live in `lib/workflow/engine.ts` — `EPIC_TRANSITIONS`
(with `to_merge` between `review` and `done`) and `STORY_TRANSITIONS` (no
`to_merge`: stories have no branch of their own; the engine's `targetKind`
selects the graph). `released` is terminal. `→ done` cannot be achieved by
drag/API for epics; its source must be `merge` (stories: `approve` or
`merge`). Agents cannot reach `to_merge` through `update_ticket_status`
(source `api` is refused; only source `review` — the review drivers — or a
human). An `in_progress` ticket cannot leave the column while a `build`,
`ticket_build`, or `team_build` session is queued/running; review, chat,
merge and auxiliary sessions do not own that column. Full Auto deliberately
excludes backlog: only todo/in-progress are candidates (plus a leftover story
under a `review`/`to_merge` parent), ordered by column rank then board
`position` — In Progress drains before To Do — and the driver owns the move
to `in_progress`. A rejected review returning to `in_progress` remains
automatically buildable.

### Findings lifecycle

`review_comments` rows are display truth, not a transition gate. Three things
resolve them: the reviewer of a later cycle reporting
`prior_findings: [{id, status: "fixed"}]` through `submit_findings` (the ids
are injected into its prompt as `[RC:id]` tokens); the prose fallback
`[RC:id] FIXED` lines parsed by `resolvePriorFindingsFromProse`
(lib/pipeline/findings.ts) for MCP-less providers; and the merge, which
resolves everything still open (`resolveOpenReviewComments`). Blocking
severity (`[critical]`/`[major]`) still vetoes a review verdict within its
stage window — that is what sends a ticket back to `in_progress` instead of
`to_merge` — but open findings no longer block the merge itself.

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

- `app/api/mcp/update-ticket-status/route.ts` — MCP/manual agent request (enum: backlog/todo/in_progress/review only).
- `app/api/projects/[projectId]/epics/[epicId]/route.ts` — epic PATCH.
- `app/api/projects/[projectId]/epics/reorder/route.ts` — drag preflight and apply.
- `app/api/projects/[projectId]/stories/[storyId]/route.ts` and `user-stories/route.ts` — story PATCH variants.
- `app/api/projects/[projectId]/stories/[storyId]/approve/route.ts` — explicit story approval; never merges nor closes the epic (a decision line records when the last story closed).
- `app/api/projects/[projectId]/epics/[epicId]/merge/route.ts` — manual merge preflight/finalization (resolves open findings on success) and merge-fix finalization.
- `app/api/projects/[projectId]/epics/[epicId]/resolve-merge/route.ts` — clean/conflicted merge resolution; both success paths resolve open findings, and a refused completion after a merge-fix leaves a ticket comment + notification instead of returning silently.
- `lib/auto-mode/merge.ts` — Full Auto merge finalization (resolves open findings after the guarded transition) and preflight.
- `app/api/projects/[projectId]/releases/route.ts` — `done → released`.
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
| stories added mid-build stay todo; the merge cascade returns/logs non-review children and delivered cards warn while they remain unfinished | `automatic-transition-invariants.test.ts`; `workflow-approval-regressions.test.ts`; `epic-card.test.tsx` |
| story approval is explicit human review, closes only the story, and never merges the epic | `workflow-approval-regressions.test.ts` |
| refused import statuses preserve content, are returned in `statusesSkipped`, and transaction rollback emits no phantom move | `arji-json-sync-roundtrip.test.ts` — guarded reconciliation regressions |
| error and `asked_question` terminal branches | `automatic-transition-invariants.test.ts` terminal tests; `epic-build-asked-question.test.ts` route regression |
| `review → to_merge` needs a completed verifiable review; `→ done` needs source `merge`; the merge resolves open comments | `workflow-engine.test.ts`; `auto-mode-merge.test.ts` |
| a review that filed nothing through `submit_findings` counts as neither clean nor completed, and a 401 on that call is traced onto the ticket | `review-unverifiable-gate.test.ts` |
| an unverifiable review with nothing to act on earns a re-review, never a rebuild, and three of them park the epic | `pipeline-runner.test.ts`; `auto-mode-engine.test.ts` |
| a review whose prose yielded findings proves its channel through the recovered rows (attributed via `agentSessionId`) and is judged by prose, not held unverifiable; the findings still feed the next fix | `pipeline-runner.test.ts`; `review-unverifiable-gate.test.ts` |
| a session whose MCP channel Arij could not wire is judged by prose, not refused | `review-channel-wiring.test.ts`; `mcp-injection-lifecycle.test.ts` |
| the JS rule and the merge gate's SQL give the same verdict for every review row shape | `review-gate-consistency.test.ts` |
| a second opinion that approved through its prose fail-safe is never charged as a failure | `review-gate-consistency.test.ts`; `auto-mode-engine.test.ts` |
| negative review returns to `in_progress` | `automatic-transition-invariants.test.ts`; `pipeline-stages-dispatch.test.ts` |
| occupied/awaiting tickets are excluded and consecutive sweeps do not double-dispatch | `auto-mode-select.test.ts`; `auto-mode-engine.test.ts` budget/idempotence tests |
| review freshness prevents infinite re-review | `auto-mode-select.test.ts`; `auto-mode-e2e.test.ts` |
| only `to_merge` epics are merge candidates; a passing verdict promotes there | `auto-mode-merge.test.ts`; `auto-mode-select.test.ts`; `pipeline-stages-dispatch.test.ts` |
| terminal hook cannot re-dispatch before promotion is attempted | `auto-mode-engine.test.ts` — kick deferral |
| refused terminal promotions feed the Full Auto failure/parking ladder instead of clearing it | `auto-mode-engine.test.ts` — `transition_refused` parking regression |

## Audit findings and B-arij-104

The audit found four concrete bypass classes: direct SQL in build/review
closures, direct SQL in approval/merge routes, direct status fields in
epic/story PATCH/reorder, and status overwrite during `arji.json`
reconciliation. They now converge on the workflow service.

The orphan symptom had two causes: Full Auto selected tickets other build
entry points did not, and dispatchers inserted a `queued` session before
changing status. Story-scoped builds also left their parent in backlog/todo.
The guarded parent + target transition now precedes session creation, which is
what removes the orphan regardless of the source column.

The eligibility half of that fix was later reversed on purpose: Backlog is a
staging area, not an execution queue, so Full Auto builds only `todo` and
`in_progress` (`BUILDABLE_EPIC_STATUSES` in `lib/auto-mode/select.ts`, re-read
by the last-moment dispatch guard in `lib/auto-mode/engine.ts`). Dragging a
ticket to Backlog is the supported way to take it out of the supervisor's
reach. Manual builds, batch/night runs and pipelines still accept `backlog`.
Note the consequence: tickets created directly in Backlog — agent-filed bugs
via `create_bug`, imported GitHub issues, QA-generated epics — wait for a human
to promote them to To Do before Full Auto will touch them.

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
