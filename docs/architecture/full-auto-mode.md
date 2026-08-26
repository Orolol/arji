# Full Auto Mode — standing build / review / merge supervisor

Arij has three autonomous modes. Two are one-shot bursts:

| Mode | Scope | Ends when |
|---|---|---|
| Autonomous pipeline (`lib/pipeline/`) | one ticket | build → review → auto-fix finishes |
| Night run (`lib/night/`) | one batch of epics | the last DAG wave settles |
| **Full Auto Mode** (`lib/auto-mode/`) | the whole board, per project | **you switch it off** |

Full Auto Mode is the standing one. Once armed for a project it keeps:

- **building** everything in `todo`, plus everything in `in_progress` with no agent on it (a ticket that came back from a negative review) — **never** `backlog`,
- **reviewing** everything in `review`,
- **merging** a ticket as soon as its review is clean.

It only ever *dispatches*. Before a build session row is created, the shared
driver moves the target (and a story's parent epic) to `in_progress`, so a
dispatched ticket is never left as an active session in a non-`in_progress`
column. The state machine then loops on its own — a
successful build moves the epic to `review`, a negative review verdict moves it
back to `in_progress` without an agent — and the supervisor picks that up on the
next sweep. Every dispatch goes through
`createPipelineStageDriver(...).launchStage(...)` (`lib/pipeline/stages.ts`),
which replicates the HTTP route closures byte-for-byte, so the board cannot tell
an auto-mode agent from one you launched by hand.

---

## Turning it on

**Board toolbar → Auto.** The dialog carries an enable switch, a build agent +
build concurrency row, a review agent + review concurrency row, and a live count
of what the next sweep would pick up.

Activation is **per project**. There is no global "all projects" switch.

### Settings keys

Everything lives in the existing key/value `settings` table — **no migration**.
Each key follows the established `<key>` (global default) /
`<key>:<projectId>` (per-project override) convention, and resolution walks
project key → global key → built-in default on every sweep, so a change applies
without a restart.

| Key | Default | Meaning |
|---|---|---|
| `auto_mode_enabled` | `false` | Is the mode armed? Normally set per project; a global `true` arms every project that has not opted out with an explicit per-project `false`. |
| `auto_mode_build_agent` | *(none)* | Named agent for build dispatches. Absent = the normal resolution chain. |
| `auto_mode_build_concurrency` | `2` | How many builds of the mode's own dispatch may be in flight. Clamped 0..10. |
| `auto_mode_review_agent` | *(none)* | Named agent for review dispatches. An explicit choice beats review-provider segregation. |
| `auto_mode_review_concurrency` | `1` | How many reviews may be in flight. Clamped 0..10. |
| `auto_mode_smart_dispatch` | `false` | Pick the named agent with the best measured 30-day success rate for the stage, **only** for a role whose agent key above is absent. |

`0` is a legal concurrency and means "do not dispatch this kind" — builds-only
and reviews-only are both supported configurations.

### Informed selection (`auto_mode_smart_dispatch`)

Off by default. When on, and only when the stage's agent key is absent, the
mode asks `lib/agent-config/smart-dispatch.ts` for the named agent with the
best success rate over the last 30 days **for that role** (build or review),
among those with at least 5 finished runs. Nothing clears the threshold → the
normal resolution chain applies, exactly as before. The lookup happens once per
stage per sweep and only when there is something to dispatch, so an idle sweep
costs no extra query.

It is a plain argmax, not a bandit: no exploration, no confidence intervals, no
decay. The numbers are the same ones the reliability badge shows in every agent
picker, so a user can predict the choice before it happens — and read it
afterwards, because each smart-dispatched session gets a second activity entry
naming the agent, its rate and its sample size on top of the usual dispatch
trace.

The sweep runs every **15 s** (`AUTO_MODE_SWEEP_INTERVAL_MS`), and additionally
right after any agent session reaches a terminal state (the session terminal
hook kicks it) and right after you save the dialog. Every session it dispatches
is tagged `agent_sessions.batch_run_id = auto_<projectId>`, so the whole of the
mode's work is greppable as one batch in the sessions viewer.

Those kicks are **debounced by 250 ms** (`AUTO_MODE_KICK_DELAY_MS`), and that
delay is a correctness requirement rather than a nicety. The terminal hook
fires from inside `markSessionTerminal`, which every dispatch closure calls
*before* it applies the session's board effects — the pipeline driver moves a
finished build to `review`, or bounces a rejected epic back to `in_progress`,
in the statements right after. A sweep running synchronously from that hook
would read the board mid-flight: it could re-build a ticket that is about to
enter review, or merge an epic whose negative review has not landed yet.
Deferring to a later macrotask lets the finalization block finish first, and
collapses the storm a settling wave produces into one sweep.

### Concurrency vs. the scheduler budget

Build (N) and review (M) budgets live **above** the scheduler's per-project
`agent_max_concurrent` (`lib/agents/scheduler.ts`, default 3). If N + M exceeds
it, the dialog shows a **warning** and nothing else — the excess work queues.
Full Auto Mode never raises the scheduler budget on your behalf: that setting is
your call.

---

## What one sweep does

1. **Reconcile.** Drop in-flight session ids whose rows went terminal. A
   completed session clears its ticket's failure streak; a failed one extends
   it; a cancelled one counts neither way (it was your decision).
2. **Merge.** Every merge candidate, in board order. A clean merge is *pure
   git* — no agent, no scheduler slot — and it frees the Review column before
   anything else competes for budget.
3. **Review**, while fewer than M reviews of the mode's own dispatch are in
   flight.
4. **Build**, while fewer than N builds are in flight.

Every dispatch and every skip writes a `ticket_activity_log` entry with actor
`system` and a reason prefixed `"Auto mode "`, so the ticket feed always
explains why an agent appeared unprompted — and, just as importantly, why one
that was selected did not.

Two things are re-checked continuously rather than once per sweep:

- **The on/off flag**, before every merge and every dispatch. A sweep can spend
  many seconds inside git and agent dispatch, and switching the mode off has to
  mean off *now*, not "after the work already selected finishes".
- **The dispatch target's status**, immediately before `launchStage`, through
  the driver's own `checkGuards`. The board snapshot is milliseconds old, but a
  human approving, releasing, or dragging a ticket back to Backlog in that
  window must win — otherwise the build closure would drag it straight back to
  `in_progress`. The check reads the selector's own `BUILDABLE_*_STATUSES`
  sets, so it can never be laxer than selection. Story-scoped builds
  additionally check the parent epic against `BUILDABLE_EPIC_STATUSES`,
  because `checkGuards` reports the story's status for those.

### Granularity

Git is the constraint: there is one worktree and one branch **per epic**.

- **Build** → *story* scope when the epic has stories (one story at a time per
  epic, many epics in parallel), *epic* scope otherwise.
  Story serialisation is free: `getRunningSessionForTarget` in story scope also
  matches the parent epic's sessions (`lib/agents/concurrency.ts`), so two
  stories of one epic can never run at once.
- **Review** and **merge** → always *epic* scope. The branch is the integration
  unit and `epic.branchName` is what merges; reviewing each story *and* the epic
  would pay twice for the same diff.

### Which tickets, in which order

Two rules decide what a sweep may pick up, and both are deliberately the
board's own rules rather than a scheduler-private heuristic.

**Position is the only order.** `compareEpics` (`lib/auto-mode/select.ts`)
sorts by `position ASC` and nothing else. Priority 0–3 is a badge and a filter,
not a scheduling key: the card at the top of the column is the next one built,
which is exactly what the board shows. **Sort by priority** in the Backlog and
To Do headers is how priority reaches the scheduler — it rewrites the column's
positions in bulk through the existing reorder route (priority DESC, ties
keeping their current order), so the new display order *is* the new execution
order. The button is disabled while a filter is active, because it writes
positions for the whole column and a filtered view is a subset.

**Only To Do and In Progress are buildable.** `BUILDABLE_EPIC_STATUSES` is
`{todo, in_progress}` — Backlog is the staging area, not the queue, and
dragging a ticket back to it is the "not yet" gesture that takes it out of
Full Auto's reach. The same exported set is what `defaultDispatch` re-checks
at launch time (and, for story scope, what the parent epic is checked
against), so the selector and the last-moment guard cannot disagree.

**Dependencies are respected.** `selectBuildCandidates` skips a ticket with a
direct or transitive prerequisite that is not `done`/`released`, using
`findTicketsBlockedByDependencies` from `lib/dependencies/validation.ts` — the
same module the batch route and the DAG wave runner use. The graph is loaded
once per sweep and walked in memory. The skip is currently silent on the
board; surfacing blocked/ready state on the card is a separate backlog item.

---

## The safety guards

Four hazards were identified during design; each has a guard and a test.

### 1. Infinite re-review

A review that **passes** leaves the epic in `review` — the pipeline never
auto-approves. A naive "everything in Review" selector would review it forever.

The guard is **temporal, not verdict-based**: an epic in `review` is a review
candidate only if no review has been *attempted* since its newest terminal code
session. (The verdict itself is a substring heuristic over the reviewer's
markdown, with no structured field to read — so freshness is the fact, and the
verdict is not.)

A "review" is one completed, epic-scoped review session that delivered a
verdict (`outcome = 'answered'`). That single signal drives both directions —
reviewable when there is none newer than the last code change, mergeable when
there is — which is what makes "reviewed exactly once, then merged" true by
construction. Everything else is not a review, and every one of those cases is
bounded by the **parking ladder** rather than by this guard:

| Review session ended | Re-reviewed? | Satisfies the merge gate? |
|---|---|---|
| completed, `answered` | no | **yes** |
| completed, `silent` | yes — but each one is charged as a failure, so three park the epic | no (it produced no verdict to approve with) |
| completed, `asked_question` | yes, but only once the user replies (`isAwaitingReply` holds it until then, so a human is in the loop by construction) | no |
| completed, no recorded outcome (legacy row) | yes, once — it earns a fresh, classified review | no |
| `failed` / `cancelled` | yes — no review happened, and the parking ladder bounds the retries | no |

Both signals are **epic-scoped**: a story-scoped review session never counts as
the epic's review, because the branch — not the story — is what merges. Story
*builds* do count as code changes, though: they commit to the same branch, so
they stale an epic review that predates them.

### 2. Bulldozing an agent's question

An agent that ends with `asked_question` leaves the ticket held in
`in_progress` by `handleAskedQuestionOutcome` — **indistinguishable** from a
ticket bounced back by a negative review. Every selector therefore excludes any
ticket where `isAwaitingReply` is true. The ticket becomes eligible again the
moment you post a comment.

A story's question holds the *story*, not its parent epic — otherwise one
unanswered story would freeze an epic against a reply it cannot even see. And
because the asked-question notification deep-links to the **epic**, a reply on
either thread counts as the answer to a story question.

### 3. Merging something that is not actually approved

"Review is OK" exists nowhere as a boolean, and Full Auto Mode does **not**
invent one. The workflow engine's `review → done` guards *are* the gate:
`applyTransition` refuses unless a review session completed and no review
comment is still open (`lib/workflow/engine.ts`). The mode attempts the
transition and treats a refusal as "not ready — skip". Its own selector is
*stricter* than the engine's (the engine accepts any completed review ever; the
mode wants one newer than the last code change).

`POST .../approve` is deliberately **not** reused anywhere in this code path: it
bulk-resolves every open review comment before transitioning, which would
steamroll exactly the blocking findings that must stop an auto-merge.

### 4. Double-counted budgets

Because `getRunningSessionForTarget` counts `queued` sessions, admitting
unbounded work would make the whole board *look* busy while nothing runs. The
mode therefore does its own admission control on its own in-flight sessions,
and warns (never silently raises) when N + M exceeds the scheduler budget.

### Coexistence

A ticket is skipped when it is owned by a live pipeline run, a night run, or has
any `queued`/`running` session — the same three conflicts the batch build route
already refuses on. An active DAG wave batch stands the mode down for the whole
project (a batch snapshot carries counts, not an epic list, so per-epic
exclusion is not possible there).

### Parking

Three consecutive failures on a ticket — failed dispatches, or dispatched
sessions that failed — park it. A parked ticket is skipped until you **comment
on it** or **toggle the mode off and on** (switching off clears all runtime
state). A merge refused by a workflow guard is *not* a failure and never parks:
it retries as soon as the review comments are resolved.

An unresolved merge conflict parks the epic **hard**. A soft streak is cleared
by the next session that completes, and the merge-fix agent *does* complete
successfully right before its retry fails — so without that distinction the
reconcile pass would credit the agent, clear the streak, un-park the epic and
loop on the same conflict forever. Only a comment on the ticket or switching
the mode off reverses a hard park.

---

## ⚠️ Unattended merge-conflict resolution

This is the one path where an agent modifies `main` with nobody watching, so it
is spelled out in full:

1. The mode merges with `mergeWorktree(...)` — the same primitive the manual
   Merge button uses. The workflow guards are validated **before** git runs, so
   a merge can never land on `main` while the ticket refuses to move.
   Before git runs, the current `main` and branch tips are captured as a
   **rollback checkpoint**.
2. On a **clean** merge: the epic moves to `done` through `applyTransition`
   (`source: 'merge'`), its branch name is cleared, and `arji.json` is
   re-exported. No agent was involved. The `fromStatus` is re-read *after* the
   merge, not carried in from before it — `mergeWorktree` takes real seconds,
   and validating `review → done` against a stale snapshot would rubber-stamp
   exactly the transition the engine exists to refuse.
   If that post-merge guard refuses (a review comment landed, or the ticket
   moved), **`main` is rolled back** to the checkpoint and the branch is
   restored. Unattended, "we changed `main` and then found out we shouldn't
   have" has to be recoverable — there is nobody watching to notice.
3. On a **conflict** — and only a real content conflict; `mergeWorktree`
   returns a structured `reason`, so a missing branch or a broken repo never
   burns a build slot on an agent that cannot help — a `merge`-type agent is
   dispatched with the conflict error and instructions to resolve it, commit,
   and verify the build.
   - The agent runs in a **freshly re-attached worktree**. `mergeWorktree`
     removes the epic's worktree *before* it attempts the merge and the
     conflict path aborts without putting it back, so the directory recorded
     on the session row no longer exists. The branch survives (it is only
     deleted after a successful merge), and `attachWorktree` re-attaches to
     **that exact branch name** — deriving it from the epic title again would
     silently start work on a fresh branch if the title had been edited.
   - That session is **charged to the build budget**, and it is only dispatched
     when a build slot is actually free. With `auto_mode_build_concurrency` at
     0 — "run no code agents" — no conflict agent is dispatched: the worktree
     is restored and the epic's merge is held back for five minutes, so the
     sweep does not re-run a doomed `git merge` every 15 seconds.
4. When that agent finishes successfully, the merge is retried **once**.
5. If the retry also fails — or the agent itself failed — the epic is **parked
   hard**, a `failed` notification deep-linking to the ticket is raised, and
   the mode never touches that epic again until you intervene.

Throughout all of that the epic holds a **merge lock**, from the first git
command until the conflict agent's retry has settled. The merge-fix session
goes terminal *before* its retry runs, and that fires the sweep kick — without
the lock, that sweep could start a second merge on the same branch mid-retry.

In other words: an unattended agent may rewrite files in the epic's worktree to
resolve a conflict, and a successful resolution is merged into `main` without
review. If that is not acceptable for a repository, leave Full Auto Mode off for
that project.

---

## Restart behaviour

The mode's *configuration* is durable (settings keys); its *runtime* state is
not. On boot, `instrumentation.ts` runs the usual cleanup — orphaned `queued`
sessions are cancelled as "orphaned by restart" — then `startAutoMode()` begins
sweeping again from the settings. The in-flight set starts empty, which is
correct: the sessions it was tracking died with the previous process.

`instrumentation.ts` also registers a **single composed** session terminal hook.
That slot holds exactly one callback, so the auto-mode kick and the memory
auto-distillation trigger are composed there rather than overwriting each other.

---

## Module map

| File | Role |
|---|---|
| `lib/auto-mode/constants.ts` | Client-safe: setting keys, clamps, parsers, reason strings, `auto_` run-id prefix |
| `lib/auto-mode/config.ts` | Server-side project → global → default resolver; enabled-project discovery |
| `lib/auto-mode/select.ts` | The three candidate selectors over one bounded board snapshot |
| `lib/auto-mode/registry.ts` | `globalThis`-backed runtime state: in-flight map, per-project mutex, parking, recent ring |
| `lib/auto-mode/merge.ts` | `tryAutoMerge` — the guards, the git merge, the conflict agent and its single retry |
| `lib/auto-mode/engine.ts` | The sweep, the budgets, the timer, the kicks |
| `lib/auto-mode/status.ts` | Frozen GET/PUT response shape shared with the UI |
| `app/api/projects/[projectId]/auto-mode/route.ts` | GET status / PUT settings (+ immediate sweep) |
| `components/auto-mode/AutoModeDialog.tsx` | Configuration dialog |
| `components/auto-mode/AutoModeToggle.tsx` | Board toolbar button + live badge |

Tests: `__tests__/auto-mode-{constants,select,engine,merge,route,dialog,instrumentation,e2e}.test.ts(x)`.
