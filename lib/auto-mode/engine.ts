import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { getRunningSessionForTarget } from "@/lib/agents/concurrency";
import { logTransition } from "@/lib/workflow/log";
import { transitionReviewRejected } from "@/lib/workflow/automatic-transitions";
import { buildDeterministicVerificationFixSection } from "@/lib/claude/prompt-builder";
import { createPipelineStageDriver } from "@/lib/pipeline/stages";
import type { PipelineDeterministicVerificationOutcome } from "@/lib/pipeline/runner";
import { assessEpicVerification } from "@/lib/verify/freshness";
import type { VerifyCommandResult } from "@/lib/verify/verify-constants";
import type { AutoModeInFlightEntry } from "./registry";
import {
  AUTO_MODE_MAX_CONSECUTIVE_FAILURES,
  AUTO_MODE_REASONS,
  AUTO_MODE_SWEEP_INTERVAL_MS,
  autoRunId,
  type AutoModeConfig,
} from "./constants";
import {
  listAutoModeEnabledProjectIds,
  resolveAutoModeConfigForProject,
} from "./config";
import { autoModeRegistry } from "./registry";
import {
  BUILDABLE_EPIC_STATUSES,
  BUILDABLE_STORY_STATUSES,
  STORY_PARENT_BUILDABLE_STATUSES,
  loadAutoModeBoard,
  selectBuildCandidates,
  selectMergeCandidates,
  selectReviewCandidates,
  type AutoModeBoard,
} from "./select";
import { tryAutoMerge, type AutoMergeOutcome } from "./merge";
import { SESSION_TRANSITION_REFUSED_OUTCOME } from "@/lib/agent-sessions/lifecycle";
import {
  selectSmartDispatchAgent,
  type SmartDispatchPick,
} from "@/lib/agent-config/smart-dispatch";
import { createAutoModeSecondOpinionParkedNotification } from "@/lib/notifications/create";
import {
  dispatchSecondOpinion,
  readSecondOpinionState,
  type SecondOpinionDispatchResult,
  type SecondOpinionState,
} from "./second-opinion";

/**
 * Full Auto Mode — the standing build / review / merge supervisor.
 *
 * Arij already had two autonomous modes, but both are one-shot bursts:
 * lib/pipeline/ takes ONE ticket through build → review → auto-fix and stops,
 * lib/night/ makes ONE DAG pass over a batch of epics and ends. Neither
 * watches the board. This engine is the missing link: a permanent loop, armed
 * per project, with independent build and review budgets.
 *
 * It only ever DISPATCHES. The state machine already loops on its own — a
 * build success moves the epic to `review`, a negative review verdict moves
 * it back to `in_progress` with no agent on it (lib/pipeline/stages.ts:916),
 * and the supervisor simply picks that up on the next sweep. Nothing here
 * duplicates the routes' status logic; every dispatch goes through
 * `createPipelineStageDriver(...).launchStage(...)`, which replicates the
 * route closures byte-for-byte so the board cannot tell an auto-mode agent
 * from a human one.
 *
 * Sweep order matters:
 *   1. reconcile — drop in-flight ids whose session rows went terminal,
 *      crediting a completed session and charging a failed one to its ticket;
 *   2. merge     — free the Review column first; a clean merge is pure git,
 *      except when the opt-in second-opinion gate first spends a review slot;
 *   3. review    — while fewer than M reviews of our own are in flight;
 *   4. build     — while fewer than N builds of our own are in flight.
 *
 * The budgets are the mode's OWN admission control, deliberately layered
 * ABOVE the scheduler's `agent_max_concurrent`. If N+M exceeds it the excess
 * queues (the dialog warns about exactly this); what the mode must never do
 * is admit unbounded work, because `getRunningSessionForTarget` counts
 * `queued` — a stuffed queue would make the whole board look busy while
 * nothing runs.
 */

const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "cancelled"]);

/*
 * The statuses a build may still be dispatched onto are imported from the
 * selector (`BUILDABLE_EPIC_STATUSES` / `BUILDABLE_STORY_STATUSES`) rather
 * than restated here. A local copy is exactly the drift this guard exists to
 * catch: it re-checks the ticket the selector saw, and `dispatchKind` awaits
 * each dispatch in turn, so the window between snapshot and launch is seconds
 * wide — long enough for a human to drag a ticket back to Backlog.
 */

/* ------------------------------------------------------------------ */
/* Injection surface                                                   */
/* ------------------------------------------------------------------ */

export interface AutoModeDispatchInput {
  projectId: string;
  stage: "build" | "review";
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
  buildNamedAgentId: string | null;
  reviewNamedAgentId: string | null;
  /** Sessions the mode already owns — the driver's race check. */
  ownSessionIds: string[];
}

export interface AutoModeDispatchResult {
  sessionId: string | null;
  /** Dispatch error, when the stage never produced a session row. */
  error: string | null;
  /**
   * A foreign active session appeared between selection and dispatch. Not a
   * failure of the ticket: skip it this sweep, charge nothing.
   */
  conflictSessionId: string | null;
  /**
   * A last-moment guard refused (the ticket moved between selection and
   * dispatch). Not a failure either, but it must still be visible: a ticket
   * the mode picked and then silently dropped is exactly the sort of thing a
   * user cannot otherwise explain.
   */
  skipReason?: string | null;
}

export interface AutoModeEngineDeps {
  listEnabledProjectIds(): string[];
  resolveConfig(projectId: string): AutoModeConfig;
  loadBoard(projectId: string): AutoModeBoard;
  dispatch(input: AutoModeDispatchInput): Promise<AutoModeDispatchResult>;
  /**
   * Best-measured named agent for a stage, or null when nothing clears the
   * sample threshold. Only consulted when `smartDispatch` is on AND the role
   * has no explicitly configured agent.
   */
  selectSmartAgent(input: {
    projectId: string;
    stage: "build" | "review";
  }): Promise<SmartDispatchPick | null>;
  dispatchSecondOpinion(input: {
    projectId: string;
    epicId: string;
  }): Promise<SecondOpinionDispatchResult>;
  readSecondOpinionState(
    projectId: string,
    epicId: string
  ): SecondOpinionState;
  notifySecondOpinionRejected(input: {
    projectId: string;
    epicId: string;
    sessionId: string;
    reason: string;
  }): void;
  merge(
    projectId: string,
    epicId: string,
    options: {
      namedAgentId: string | null;
      /** False when no build slot is free for a conflict-resolution agent. */
      dispatchConflictAgent: boolean;
      /**
       * True when this sweep's single verification slot is still free, so a
       * merge candidate with no usable report may produce one instead of
       * being refused forever.
       */
      verifyIfMissing?: boolean;
    }
  ): Promise<AutoMergeOutcome>;
  readSessionStatus(sessionId: string): string | null;
  /** Delivery verdict of a terminal session ("answered" | "silent" | …). */
  readSessionOutcome(sessionId: string): string | null;
  readEpicStatus(epicId: string): string | null;
  /**
   * Runs Arij's own `verify_commands` in the epic worktree the given code
   * session recorded, and persists a `verify_reports` row.
   *
   * Full Auto does NOT go through lib/pipeline/runner.ts — it dispatches
   * stages directly and lets the board state machine loop — so the pipeline's
   * build → verify → review ordering is not inherited. This dep is how the
   * mode runs the same checks at the same point in the lifecycle: right after
   * a delivered code session, before the review it will dispatch next.
   *
   * Optional so a fully-faked deps object opts in explicitly;
   * `defaultAutoModeDeps` always provides it, and a project without
   * `verify_commands` resolves to `{ ran: false }` with no side effects.
   */
  runDeterministicVerification?(input: {
    projectId: string;
    epicId: string;
    sessionId: string;
  }): Promise<PipelineDeterministicVerificationOutcome>;
}

/**
 * The real dispatcher: one driver per dispatch, guarded immediately before
 * launch. `checkGuards` is the last-moment race check — the board snapshot
 * that produced this candidate is milliseconds old, but a human clicking
 * Build in that window must win.
 */
async function defaultDispatch(
  input: AutoModeDispatchInput
): Promise<AutoModeDispatchResult> {
  const driver = createPipelineStageDriver({
    projectId: input.projectId,
    scope: input.scope,
    epicId: input.epicId,
    userStoryId: input.userStoryId,
    buildNamedAgentId: input.buildNamedAgentId,
    reviewNamedAgentId: input.reviewNamedAgentId,
    batchRunId: autoRunId(input.projectId),
  });

  let guard;
  try {
    guard = driver.checkGuards(input.ownSessionIds);
  } catch (error) {
    return {
      sessionId: null,
      conflictSessionId: null,
      error: error instanceof Error ? error.message : "Guard probe failed",
    };
  }

  if (guard.conflictSessionId) {
    return {
      sessionId: null,
      error: null,
      conflictSessionId: guard.conflictSessionId,
    };
  }

  // `checkGuards` reports the DISPATCH TARGET's own status — the story for a
  // story-scoped run, the epic otherwise.
  const targetStatus = guard.reviewTargetStatus;

  // Mirror of the review routes' status guard: reviewing a ticket a human
  // just dragged out of Review would be dispatching work the route itself
  // would refuse.
  if (
    input.stage === "review" &&
    targetStatus !== "review" &&
    targetStatus !== "done"
  ) {
    return {
      sessionId: null,
      error: null,
      conflictSessionId: null,
      skipReason: `target left review (now ${targetStatus ?? "unknown"})`,
    };
  }

  // The build stage needs the same treatment. Without it, a human approving
  // or releasing a ticket in the window between the board snapshot and this
  // dispatch would get a build agent on it anyway — and the build closure
  // would drag the epic straight back to `in_progress`.
  if (input.stage === "build") {
    const buildable =
      input.scope === "story"
        ? BUILDABLE_STORY_STATUSES
        : BUILDABLE_EPIC_STATUSES;
    if (!buildable.has(targetStatus ?? "")) {
      return {
        sessionId: null,
        error: null,
        conflictSessionId: null,
        skipReason: `target is no longer buildable (now ${targetStatus ?? "unknown"})`,
      };
    }
    // Story scope reports the STORY's status, so the parent epic is checked
    // separately — against the same set the selector uses, not merely against
    // done/released. A `todo` story must not drag its Backlog epic into the
    // execution queue here any more than it can in `selectBuildCandidates`.
    // `review` is in that set: a leftover story under a reviewed epic is work
    // that still has to be written, and the dispatch transition reopens the
    // epic to do it.
    if (input.scope === "story") {
      const epicStatus =
        db
          .select({ status: epics.status })
          .from(epics)
          .where(eq(epics.id, input.epicId))
          .get()?.status ?? null;
      if (!STORY_PARENT_BUILDABLE_STATUSES.has(epicStatus ?? "")) {
        return {
          sessionId: null,
          error: null,
          conflictSessionId: null,
          skipReason: `parent epic is ${epicStatus ?? "unknown"}`,
        };
      }
    }
  }

  // A review gets the mechanical evidence the pipeline's reviewer gets: a
  // one-line-per-command PASS summary in its prompt. Full Auto now runs the
  // same checks at the same point in the lifecycle, so withholding the report
  // would just make the reviewer re-derive what Arij already proved. Only a
  // report that still vouches for the branch is forwarded — the same
  // freshness rule the merge gate uses.
  const evidence =
    input.stage === "review"
      ? assessEpicVerification(input.projectId, input.epicId)
      : null;
  const verificationReport = evidence?.problem === null ? evidence.report : null;

  const handle = await driver.launchStage({
    stage: input.stage,
    attempt: 1,
    fixCycle: 0,
    previousAttemptSessionId: null,
    lastCodeSessionId: null,
    ...(verificationReport ? { verificationReport } : {}),
  });

  if (!handle.sessionId) {
    // launchStage never throws: a dispatch failure comes back as an already
    // resolved settle carrying the message.
    const settled = await handle.settled;
    return {
      sessionId: null,
      conflictSessionId: null,
      error: settled.error ?? "Stage dispatch failed",
    };
  }

  return { sessionId: handle.sessionId, error: null, conflictSessionId: null };
}

export const defaultAutoModeDeps: AutoModeEngineDeps = {
  listEnabledProjectIds: listAutoModeEnabledProjectIds,
  resolveConfig: resolveAutoModeConfigForProject,
  loadBoard: loadAutoModeBoard,
  dispatch: defaultDispatch,
  selectSmartAgent: ({ stage }) =>
    // A stats read must never take the sweep down with it: no pick simply
    // means "keep the configured default".
    selectSmartDispatchAgent({ role: stage }).catch((error) => {
      console.warn(
        "[auto-mode] Smart dispatch lookup failed:",
        error instanceof Error ? error.message : error
      );
      return null;
    }),
  dispatchSecondOpinion,
  readSecondOpinionState,
  notifySecondOpinionRejected: createAutoModeSecondOpinionParkedNotification,
  merge: (projectId, epicId, options) =>
    tryAutoMerge(projectId, epicId, options),
  readSessionStatus: (sessionId) =>
    db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get()?.status ?? null,
  readSessionOutcome: (sessionId) =>
    db
      .select({ outcome: agentSessions.outcome })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get()?.outcome ?? null,
  readEpicStatus: (epicId) =>
    db
      .select({ status: epics.status })
      .from(epics)
      .where(eq(epics.id, epicId))
      .get()?.status ?? null,
  runDeterministicVerification: ({ projectId, epicId, sessionId }) =>
    // Epic scope on purpose: the worktree and the branch are epic-owned, so
    // a story build's checks still cover the whole integration unit — the
    // same unit the merge will land.
    createPipelineStageDriver({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildNamedAgentId: null,
      batchRunId: autoRunId(projectId),
    }).runDeterministicVerification(sessionId),
};

/* ------------------------------------------------------------------ */
/* Sweep result (the tests' and the route's view)                      */
/* ------------------------------------------------------------------ */

export interface AutoModeSweepResult {
  projectId: string;
  /** Why nothing happened, when nothing happened. */
  skipped: "disabled" | "locked" | null;
  merged: string[];
  mergeConflicts: string[];
  reviewsDispatched: string[];
  secondOpinionsDispatched: string[];
  buildsDispatched: string[];
  parked: string[];
  inFlight: { build: number; review: number };
}

function emptyResult(
  projectId: string,
  skipped: AutoModeSweepResult["skipped"]
): AutoModeSweepResult {
  return {
    projectId,
    skipped,
    merged: [],
    mergeConflicts: [],
    reviewsDispatched: [],
    secondOpinionsDispatched: [],
    buildsDispatched: [],
    parked: [],
    inFlight: autoModeRegistry.countInFlight(projectId),
  };
}

/* ------------------------------------------------------------------ */
/* The sweep                                                           */
/* ------------------------------------------------------------------ */

/**
 * Re-reads the on/off flag mid-sweep. A sweep can spend many seconds inside
 * git and agent dispatch, and "off" has to mean off NOW — not after the work
 * already queued finishes.
 */
function stillEnabled(
  projectId: string,
  deps: AutoModeEngineDeps
): boolean {
  try {
    if (deps.resolveConfig(projectId).enabled) return true;
  } catch (error) {
    console.warn(
      "[auto-mode] Could not re-read the enabled flag mid-sweep:",
      error instanceof Error ? error.message : error
    );
    // Unreadable config is not permission to keep dispatching.
  }
  autoModeRegistry.setEnabled(projectId, false);
  return false;
}

/** Best-effort activity trace; logTransition already swallows its own errors. */
function trace(
  deps: AutoModeEngineDeps,
  projectId: string,
  epicId: string,
  reason: string,
  sessionId?: string | null
): void {
  const held = deps.readEpicStatus(epicId) ?? "backlog";
  logTransition({
    projectId,
    epicId,
    // from == to: the mode observes and dispatches, the driver moves tickets.
    fromStatus: held,
    toStatus: held,
    actor: "system",
    reason,
    ...(sessionId ? { sessionId } : {}),
  });
}

/** What reconcile hands the rest of the sweep. */
interface ReconcileOutcome {
  /**
   * Epics whose delivered build was NOT verified this tick because the cap
   * below deferred it. The rest of the sweep must leave them alone: their
   * branch has no mechanical evidence yet, and next tick this loop will spawn
   * commands into their worktree — where a review agent dispatched now would
   * still be working.
   */
  deferredEpicIds: Set<string>;
  /** True once a command list has run, which is the per-tick budget. */
  verificationRan: boolean;
}

/**
 * Reconciles the in-flight map against the session rows: anything terminal
 * leaves the map, a completed session clears its ticket's failure streak and
 * a failed one extends it. A cancelled session is the user's decision, so it
 * counts neither way.
 */
async function reconcileInFlight(
  projectId: string,
  deps: AutoModeEngineDeps,
  result: AutoModeSweepResult
): Promise<ReconcileOutcome> {
  // One command list per tick. Verification spawns real child processes and
  // this loop runs inside the per-project sweep mutex, so a three-command
  // config at the default 10-minute timeout could otherwise hold the lock for
  // half an hour PER epic that delivered in the same sweep — during which no
  // review, merge or build for the project moves. A deferred entry stays in
  // the in-flight map on purpose: the ticket remains busy (no second build
  // lands on it) and the next tick, 15 seconds later, reconciles it.
  let verificationRan = false;
  const deferredEpicIds = new Set<string>();

  for (const { sessionId, entry } of autoModeRegistry.listInFlight(projectId)) {
    const status = deps.readSessionStatus(sessionId);
    if (status !== null && !TERMINAL_SESSION_STATUSES.has(status)) continue;

    // A review that completed without producing a verdict delivered nothing.
    // The selectors treat it as "no review happened" so the epic stays
    // reviewable; charging it here is what bounds those retries — three
    // silent reviews park the epic instead of looping.
    const sessionOutcome = deps.readSessionOutcome(sessionId);
    const silentReview =
      status === "completed" &&
      entry.kind === "review" &&
      sessionOutcome === "silent";
    const transitionRefused =
      status === "completed" &&
      sessionOutcome === SESSION_TRANSITION_REFUSED_OUTCOME;

    // What the checks are allowed to run against. A build that stopped to ask
    // the user something DELIVERED NOTHING: the ticket is held in
    // `in_progress` awaiting a reply and its worktree is half-finished, so
    // testing it would charge a phantom failure to the parking ladder and
    // drop a failing-test comment into the very thread the user is being
    // asked to answer. The pipeline draws the same line one step earlier —
    // lib/pipeline/runner.ts returns `paused_question` before its
    // verification block, i.e. `success && outcome !== "asked_question"`.
    //
    // `silent` is deliberately NOT excluded, and that is not an oversight:
    // finalizeBuildTerminalOutcome still promotes a silent build to Review,
    // so it is a tree the merge gate will be asked about. An agent that
    // delivered without saying anything is precisely the case where
    // mechanical evidence matters most.
    const deliveredCode =
      status === "completed" &&
      entry.kind === "build" &&
      !transitionRefused &&
      sessionOutcome !== "asked_question";

    if (deliveredCode && verificationRan) {
      // Deferred, so the rest of this sweep must not act on the epic: a
      // review dispatched now would still be running in the worktree the
      // next tick spawns `npm test` into, and it would be reviewing a branch
      // whose checks have never run.
      deferredEpicIds.add(entry.epicId);
      trace(
        deps,
        projectId,
        entry.epicId,
        AUTO_MODE_REASONS.verificationDeferred,
        sessionId
      );
      continue;
    }

    autoModeRegistry.removeInFlight(projectId, sessionId);

    if (entry.purpose === "second-opinion") {
      const gate = deps.readSecondOpinionState(projectId, entry.epicId);
      if (gate.status === "rejected") {
        parkRejectedSecondOpinion(
          projectId,
          entry.epicId,
          gate,
          deps,
          result
        );
        continue;
      }
      if (gate.status === "retry") {
        const failures = autoModeRegistry.recordFailure(
          projectId,
          entry.ticketId,
          entry.epicId,
          gate.reason
        );
        trace(
          deps,
          projectId,
          entry.epicId,
          AUTO_MODE_REASONS.dispatchFailed("second opinion", gate.reason),
          sessionId
        );
        if (failures >= AUTO_MODE_MAX_CONSECUTIVE_FAILURES) {
          result.parked.push(entry.ticketId);
          trace(
            deps,
            projectId,
            entry.epicId,
            AUTO_MODE_REASONS.parked(failures),
            sessionId
          );
          try {
            deps.notifySecondOpinionRejected({
              projectId,
              epicId: entry.epicId,
              sessionId,
              reason: `gate failed to return usable evidence after ${failures} attempts: ${gate.reason}`,
            });
          } catch (error) {
            console.warn(
              "[auto-mode] Failed to create second-opinion failure notification:",
              error instanceof Error ? error.message : error
            );
          }
        }
        continue;
      }
    }

    if (status === "completed" && !silentReview && !transitionRefused) {
      // Delivered code: run Arij's own checks BEFORE crediting the session,
      // because a red branch is not a success. Clearing the streak first
      // would erase the very failure the check is about to record, and
      // build → red → build would loop forever instead of parking.
      if (deliveredCode) {
        const verdict = await verifyDeliveredCode(
          projectId,
          deps,
          entry,
          sessionId,
          result.parked
        );
        verificationRan = verdict.ran;
        if (verdict.failed) continue;
      }
      autoModeRegistry.clearFailures(projectId, entry.ticketId);
      continue;
    }
    if (status !== "failed" && !silentReview && !transitionRefused) continue;

    const failures = autoModeRegistry.recordFailure(
      projectId,
      entry.ticketId,
      entry.epicId,
      transitionRefused
        ? "build completed but its workflow transition was refused"
        : silentReview
        ? "review completed with no verdict"
        : `${entry.kind} session failed`
    );
    if (failures >= AUTO_MODE_MAX_CONSECUTIVE_FAILURES) {
      result.parked.push(entry.ticketId);
      trace(
        deps,
        projectId,
        entry.epicId,
        AUTO_MODE_REASONS.parked(failures),
        sessionId
      );
    }
  }

  return { deferredEpicIds, verificationRan };
}

/**
 * Bound on the failing command output copied into the ticket feed. The full
 * tail can be 64 KiB per command, and the ticket-code prompt embeds the whole
 * comment history verbatim — an unbounded copy here would grow every prompt
 * for the rest of the epic's life.
 */
const VERIFICATION_COMMENT_TAIL_LIMIT = 4_000;

/**
 * Outcome of one deterministic-verification pass over a delivered build.
 *
 * `ran` drives the caller's per-sweep cap (only an execution that actually
 * spawned commands is worth rationing); `failed` tells it not to credit the
 * session, or the streak recorded here would be cleared underneath it.
 */
interface DeliveredCodeVerdict {
  ran: boolean;
  failed: boolean;
}

const NOT_VERIFIED: DeliveredCodeVerdict = { ran: false, failed: false };

/**
 * Runs Arij's deterministic checks for a delivered code session, then acts on
 * the verdict.
 *
 * This is the mode's substitute for the pipeline's build → verify → review
 * ordering. Full Auto never enters `runPipeline`, so without this the
 * `verify_commands` a user configured would simply never execute here — and
 * the merge gate in lib/auto-mode/merge.ts, which demands a fresh passing
 * report, could never be satisfied.
 *
 * A failure returns the ticket to In Progress rather than blocking at the
 * merge: the mode has no fix-cycle ladder, so the only way it can repair a
 * red branch is to make the ticket buildable again and let the next sweep
 * dispatch a build — with the failing output posted to the ticket so that
 * build knows what to fix. The streak feeds the normal parking ladder, which
 * is what stops build → red → build from looping forever.
 *
 * Verification is not an agent session: it takes no slot and is charged to
 * neither budget.
 */
async function verifyDeliveredCode(
  projectId: string,
  deps: AutoModeEngineDeps,
  entry: AutoModeInFlightEntry,
  sessionId: string,
  parked: string[]
): Promise<DeliveredCodeVerdict> {
  if (!deps.runDeterministicVerification) return NOT_VERIFIED;

  // A merge-fix session is charged to the build budget like any other code
  // work, but its checks belong to the merge retry that owns the worktree
  // (lib/auto-mode/merge.ts). The retry runs inside the launch closure, which
  // starts AFTER the session row goes terminal — so without this guard the
  // sweep kicked by that very transition would start a second, redundant pass
  // against the tree the retry is about to merge.
  if (autoModeRegistry.isMergeInFlight(projectId, entry.epicId)) {
    return NOT_VERIFIED;
  }

  // Never spawn commands into a worktree an agent is live in. Normally the
  // build that just delivered is the only session on the epic and it is
  // terminal by now — but a deferred entry is reconciled a tick later, and
  // anything (a human build, another mode, a review the previous sweep sent
  // out) can have taken the worktree since. Two `next build` runs in one
  // directory produce evidence that is garbage in either direction, and a
  // failing verdict here would pull the ticket out from under a live review.
  // The manual route refuses on exactly this check.
  const activeSession = getRunningSessionForTarget({
    scope: "epic",
    projectId,
    epicId: entry.epicId,
  });
  if (activeSession) {
    trace(
      deps,
      projectId,
      entry.epicId,
      AUTO_MODE_REASONS.verificationSkipped(
        `another agent is working in this epic's worktree (session ${activeSession.id})`
      ),
      sessionId
    );
    return NOT_VERIFIED;
  }

  let outcome: PipelineDeterministicVerificationOutcome;
  try {
    outcome = await deps.runDeterministicVerification({
      projectId,
      epicId: entry.epicId,
      sessionId,
    });
  } catch (error) {
    // A fault in the checks themselves says nothing about the branch, so the
    // ticket stays where the build put it. Nothing lands unverified either:
    // the merge gate still refuses without a fresh passing report.
    trace(
      deps,
      projectId,
      entry.epicId,
      AUTO_MODE_REASONS.verificationCrashed(
        error instanceof Error ? error.message : String(error)
      ),
      sessionId
    );
    return NOT_VERIFIED;
  }

  if (!outcome.ran) {
    // No reason means "not configured" — the feature is off, and off must
    // stay silent. Every other skip is traced, because a silent skip reads
    // exactly like "the configured checks passed".
    if (outcome.skipReason) {
      trace(
        deps,
        projectId,
        entry.epicId,
        AUTO_MODE_REASONS.verificationSkipped(outcome.skipReason),
        sessionId
      );
    }
    return NOT_VERIFIED;
  }

  const report = outcome.result;
  if (!report) return NOT_VERIFIED;

  if (report.status === "pass") {
    trace(
      deps,
      projectId,
      entry.epicId,
      AUTO_MODE_REASONS.verificationPassed(report.commands.length),
      sessionId
    );
    return { ran: true, failed: false };
  }

  const failedCommand =
    report.commands.find((command) => command.exitCode !== 0) ??
    report.commands.at(-1) ??
    null;
  const label = failedCommand?.name ?? "the configured checks";

  trace(
    deps,
    projectId,
    entry.epicId,
    AUTO_MODE_REASONS.verificationFailed(label),
    sessionId
  );
  postVerificationFailureComment(entry, sessionId, failedCommand);

  // The pullback has three no-op exits (ticket gone, already moved, guard
  // refused), so its result is traced rather than asserted up front — a feed
  // that claims a transition the board did not make is worse than no entry.
  const returned = returnTicketToInProgress(projectId, entry, sessionId, label);
  if (!returned.moved) {
    trace(
      deps,
      projectId,
      entry.epicId,
      AUTO_MODE_REASONS.verificationTicketHeld(returned.status),
      sessionId
    );
  }

  const failures = autoModeRegistry.recordFailure(
    projectId,
    entry.ticketId,
    entry.epicId,
    `deterministic verification failed at "${label}"`
  );
  if (failures >= AUTO_MODE_MAX_CONSECUTIVE_FAILURES) {
    parked.push(entry.ticketId);
    trace(
      deps,
      projectId,
      entry.epicId,
      AUTO_MODE_REASONS.parked(failures),
      sessionId
    );
  }
  return { ran: true, failed: true };
}

/**
 * Posts the failing command's evidence to the ticket. This is the channel the
 * next build agent reads: the ticket-code prompt embeds the comment history,
 * and without it the rebuilt ticket would carry no hint of why it came back.
 * Reuses the pipeline's fix section so the framing — untrusted output, fenced
 * longer than any backtick run in it — is identical on both paths.
 *
 * Scope matters. Both consumers filter by story id for story-scoped work —
 * `buildTicketPrompt`'s comment query and the story comment route — so an
 * epic-filed comment is invisible to the very rebuild it exists to inform.
 * Same ternary as lib/pipeline/stages.ts uses for agent output.
 */
function postVerificationFailureComment(
  entry: AutoModeInFlightEntry,
  sessionId: string,
  command: VerifyCommandResult | null
): void {
  if (!command) return;
  const isStory = entry.ticketId !== entry.epicId;
  try {
    db.insert(ticketComments)
      .values({
        id: createId(),
        ...(isStory ? { userStoryId: entry.ticketId } : { epicId: entry.epicId }),
        author: "agent",
        content: buildDeterministicVerificationFixSection({
          name: command.name,
          command: command.command,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          tail: command.tail.slice(-VERIFICATION_COMMENT_TAIL_LIMIT),
        }),
        agentSessionId: sessionId,
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch (error) {
    console.warn(
      "[auto-mode] Could not post the verification failure comment:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Pulls a ticket whose checks failed back out of Review, through the same
 * transition the negative-review path uses. Only a ticket actually sitting in
 * review/done is moved — anything else is somebody else's business now.
 *
 * Returns whether the pullback landed and the status the ticket is actually
 * held at afterwards, the same contract `pullTicketBackIfPromoted` uses, so
 * the caller's activity entry stays truthful instead of hard-coding the move.
 */
function returnTicketToInProgress(
  projectId: string,
  entry: AutoModeInFlightEntry,
  sessionId: string,
  commandLabel: string
): { moved: boolean; status: string } {
  const isStory = entry.ticketId !== entry.epicId;
  const readStatus = (): string =>
    (isStory
      ? db
          .select({ status: userStories.status })
          .from(userStories)
          .where(eq(userStories.id, entry.ticketId))
          .get()?.status
      : db
          .select({ status: epics.status })
          .from(epics)
          .where(eq(epics.id, entry.epicId))
          .get()?.status) ?? "unknown";

  const before = readStatus();
  if (before !== "review" && before !== "done") {
    return { moved: false, status: before };
  }

  try {
    transitionReviewRejected({
      projectId,
      epicId: entry.epicId,
      scope: isStory ? "story" : "epic",
      userStoryId: isStory ? entry.ticketId : null,
      sessionId,
      reason: `Deterministic verification failed at "${commandLabel}"`,
    });
  } catch (error) {
    // A guard can refuse — a released sibling story makes the whole epic
    // transition invalid, for instance. Best-effort, like every other
    // terminal handler; the caller reports the column the board is in.
    console.warn(
      "[auto-mode] Could not return the ticket to In Progress after a failed verification:",
      error instanceof Error ? error.message : error
    );
    return { moved: false, status: readStatus() };
  }

  const after = readStatus();
  return { moved: after === "in_progress", status: after };
}

/**
 * A parked ticket comes back when the user touches it. "Touched" is read
 * from the board snapshot the sweep already loaded: a user comment newer
 * than the moment the ticket was parked. Toggling the mode off also clears
 * every park (the registry drops all state).
 */
function unparkTouchedTickets(
  projectId: string,
  board: AutoModeBoard
): boolean {
  let unparked = false;
  for (const parkedTicket of autoModeRegistry.listParked(projectId)) {
    const commentedAt =
      board.lastUserCommentByStory.get(parkedTicket.ticketId) ??
      board.lastUserCommentByEpic.get(parkedTicket.ticketId);
    if (!commentedAt) continue;
    const normalized = commentedAt.includes("T")
      ? commentedAt
      : commentedAt.replace(" ", "T");
    if (normalized > parkedTicket.at) {
      // unpark, not clearFailures: a merge-conflict park is HARD and only a
      // deliberate reversal (this, or switching the mode off) clears it.
      autoModeRegistry.unpark(projectId, parkedTicket.ticketId);
      unparked = true;
    }
  }
  return unparked;
}

function parkRejectedSecondOpinion(
  projectId: string,
  epicId: string,
  state: Extract<SecondOpinionState, { status: "rejected" }>,
  deps: AutoModeEngineDeps,
  result: AutoModeSweepResult
): void {
  autoModeRegistry.removeInFlight(projectId, state.sessionId);
  if (!autoModeRegistry.isParked(projectId, epicId)) {
    autoModeRegistry.park(
      projectId,
      epicId,
      epicId,
      `second opinion rejected merge: ${state.reason}`
    );
  }
  if (!result.parked.includes(epicId)) result.parked.push(epicId);
  trace(
    deps,
    projectId,
    epicId,
    AUTO_MODE_REASONS.secondOpinionRejected(state.reason),
    state.sessionId
  );
  try {
    deps.notifySecondOpinionRejected({
      projectId,
      epicId,
      sessionId: state.sessionId,
      reason: state.reason,
    });
  } catch (error) {
    console.warn(
      "[auto-mode] Failed to create second-opinion notification:",
      error instanceof Error ? error.message : error
    );
  }
}

/** One sweep for one project. Never throws — a bad tick must not kill the loop. */
export async function sweepProject(
  projectId: string,
  deps: AutoModeEngineDeps = defaultAutoModeDeps,
  now: Date = new Date()
): Promise<AutoModeSweepResult> {
  const config = deps.resolveConfig(projectId);

  if (!config.enabled) {
    // Clears in-flight tracking, parks and the recent ring in one move.
    autoModeRegistry.setEnabled(projectId, false);
    return emptyResult(projectId, "disabled");
  }
  autoModeRegistry.setEnabled(projectId, true);
  if (!config.secondOpinion) {
    autoModeRegistry.clearSecondOpinionSkips(projectId);
  }

  if (!autoModeRegistry.tryLock(projectId)) {
    return emptyResult(projectId, "locked");
  }

  const result: AutoModeSweepResult = {
    projectId,
    skipped: null,
    merged: [],
    mergeConflicts: [],
    reviewsDispatched: [],
    secondOpinionsDispatched: [],
    buildsDispatched: [],
    parked: [],
    inFlight: { build: 0, review: 0 },
  };

  try {
    // Awaited, and deliberately so: reconcile is where the mode runs Arij's
    // own verification for a delivered build, and the checks must finish
    // before the same sweep decides whether to review or merge that epic.
    // The hold is bounded by verify_timeout_ms per command, and a tick that
    // arrives meanwhile simply reports "locked" rather than piling up.
    const reconciled = await reconcileInFlight(projectId, deps, result);

    // An epic whose checks were deferred is off limits for the rest of this
    // sweep. The selectors cannot see it on their own: their only
    // session-based exclusion is `busyEpicIds`, built from queued/running
    // rows, and a deferred entry's session is already `completed`.
    const skipUnverified = <T extends { epicId: string }>(
      candidates: T[]
    ): T[] =>
      reconciled.deferredEpicIds.size === 0
        ? candidates
        : candidates.filter(
            (candidate) => !reconciled.deferredEpicIds.has(candidate.epicId)
          );

    // The snapshot already reflects the parks reconcile just recorded (it is
    // built after them); only an un-park invalidates its exclusion set.
    let board = deps.loadBoard(projectId);
    if (unparkTouchedTickets(projectId, board)) {
      board = deps.loadBoard(projectId);
    }

    // -----------------------------------------------------------------
    // 1. Merge — cheapest first, and it frees the Review column.
    // -----------------------------------------------------------------
    let mergedSomething = false;
    let verifyBudget = reconciled.verificationRan ? 0 : 1;
    for (const candidate of skipUnverified(
      selectMergeCandidates(projectId, board)
    )) {
      // Merging and dispatching both await real work, and the user can flip
      // the switch off mid-sweep. Re-reading the flag before every action is
      // the difference between "stop" and "stop after the current wave".
      if (!stillEnabled(projectId, deps)) {
        result.skipped = "disabled";
        return result;
      }

      if (config.secondOpinion) {
        const gate = deps.readSecondOpinionState(
          projectId,
          candidate.epicId
        );
        if (gate.status === "rejected") {
          autoModeRegistry.clearSecondOpinionSkip(
            projectId,
            candidate.epicId
          );
          parkRejectedSecondOpinion(
            projectId,
            candidate.epicId,
            gate,
            deps,
            result
          );
          continue;
        }
        if (gate.status === "approved") {
          autoModeRegistry.clearSecondOpinionSkip(
            projectId,
            candidate.epicId
          );
        }
        if (gate.status !== "approved") {
          if (gate.status === "cancelled") {
            const reason =
              "the second-opinion session was cancelled; waiting for new user activity or a fresh review";
            if (
              autoModeRegistry.shouldTraceSecondOpinionSkip(
                projectId,
                candidate.epicId,
                reason
              )
            ) {
              trace(
                deps,
                projectId,
                candidate.epicId,
                AUTO_MODE_REASONS.skippedTargetMoved(
                  "second opinion",
                  reason
                ),
                gate.sessionId
              );
            }
            continue;
          }

          const reviewsInFlight =
            autoModeRegistry.countInFlight(projectId).review;
          if (gate.status === "pending") {
            continue;
          }
          if (config.reviewConcurrency <= 0) {
            const reason =
              "the review concurrency budget is 0, so no second opinion can be dispatched";
            if (
              autoModeRegistry.shouldTraceSecondOpinionSkip(
                projectId,
                candidate.epicId,
                reason
              )
            ) {
              trace(
                deps,
                projectId,
                candidate.epicId,
                AUTO_MODE_REASONS.skippedTargetMoved(
                  "second opinion",
                  reason
                )
              );
            }
            continue;
          }
          if (reviewsInFlight >= config.reviewConcurrency) {
            continue;
          }

          const dispatched = await deps.dispatchSecondOpinion({
            projectId,
            epicId: candidate.epicId,
          });
          if (dispatched.conflictSessionId) {
            trace(
              deps,
              projectId,
              candidate.epicId,
              AUTO_MODE_REASONS.skippedBusy,
              dispatched.conflictSessionId
            );
            continue;
          }
          if (!dispatched.sessionId) {
            if (dispatched.error) {
              const failures = autoModeRegistry.recordFailure(
                projectId,
                candidate.epicId,
                candidate.epicId,
                dispatched.error
              );
              trace(
                deps,
                projectId,
                candidate.epicId,
                AUTO_MODE_REASONS.dispatchFailed(
                  "second opinion",
                  dispatched.error
                )
              );
              if (failures >= AUTO_MODE_MAX_CONSECUTIVE_FAILURES) {
                result.parked.push(candidate.epicId);
                trace(
                  deps,
                  projectId,
                  candidate.epicId,
                  AUTO_MODE_REASONS.parked(failures)
                );
              }
            } else if (dispatched.skipReason) {
              if (
                autoModeRegistry.shouldTraceSecondOpinionSkip(
                  projectId,
                  candidate.epicId,
                  dispatched.skipReason
                )
              ) {
                trace(
                  deps,
                  projectId,
                  candidate.epicId,
                  AUTO_MODE_REASONS.skippedTargetMoved(
                    "second opinion",
                    dispatched.skipReason
                  )
                );
              }
            }
            continue;
          }

          autoModeRegistry.clearSecondOpinionSkip(
            projectId,
            candidate.epicId
          );
          autoModeRegistry.addInFlight(projectId, dispatched.sessionId, {
            kind: "review",
            purpose: "second-opinion",
            ticketId: candidate.epicId,
            epicId: candidate.epicId,
          });
          autoModeRegistry.recordDispatch(projectId, {
            kind: "second-opinion",
            epicId: candidate.epicId,
            userStoryId: null,
            sessionId: dispatched.sessionId,
            detail: "pre-merge gate",
          });
          result.secondOpinionsDispatched.push(dispatched.sessionId);
          trace(
            deps,
            projectId,
            candidate.epicId,
            AUTO_MODE_REASONS.secondOpinionDispatched,
            dispatched.sessionId
          );
          continue;
        }
      }

      // A conflict costs a merge-fix agent, and that agent IS a build — so it
      // has to fit in the build budget like any other. Checked per candidate,
      // because the previous one may just have taken the last slot.
      const buildsInFlight = autoModeRegistry.countInFlight(projectId).build;
      // One command list per tick across the WHOLE sweep: reconcile may have
      // spent it already, and the first candidate offered the slot consumes
      // it whether or not the gate turned out to need it. Anything else is
      // back to holding the per-project mutex for command lists × epics.
      const mayVerify = verifyBudget > 0;
      if (mayVerify) verifyBudget -= 1;
      const outcome = await deps.merge(projectId, candidate.epicId, {
        namedAgentId: config.buildAgent,
        dispatchConflictAgent:
          config.buildConcurrency > 0 && buildsInFlight < config.buildConcurrency,
        verifyIfMissing: mayVerify,
      });

      if (outcome.status === "merged") {
        result.merged.push(candidate.epicId);
        mergedSomething = true;
        continue;
      }
      if (outcome.status === "conflict") {
        // A conflict resolution is code work: charge it to the build budget.
        autoModeRegistry.addInFlight(projectId, outcome.sessionId, {
          kind: "build",
          ticketId: candidate.epicId,
          epicId: candidate.epicId,
        });
        result.mergeConflicts.push(candidate.epicId);
        mergedSomething = true;
        continue;
      }
      if (outcome.status === "failed") {
        const failures = autoModeRegistry.recordFailure(
          projectId,
          candidate.epicId,
          candidate.epicId,
          outcome.error
        );
        trace(
          deps,
          projectId,
          candidate.epicId,
          AUTO_MODE_REASONS.dispatchFailed("merge", outcome.error)
        );
        if (failures >= AUTO_MODE_MAX_CONSECUTIVE_FAILURES) {
          result.parked.push(candidate.epicId);
          trace(
            deps,
            projectId,
            candidate.epicId,
            AUTO_MODE_REASONS.parked(failures)
          );
        }
      }
      // "skipped" is a guard refusal: logged inside tryAutoMerge, never parked.
    }

    // A merge moves epics out of `review`, so the selectors below need a
    // fresh view of the board.
    if (mergedSomething) board = deps.loadBoard(projectId);

    // -----------------------------------------------------------------
    // 2. Reviews, then 3. builds — each against its own budget.
    // -----------------------------------------------------------------
    await dispatchKind({
      kind: "review",
      projectId,
      deps,
      config,
      budget: config.reviewConcurrency,
      candidates: skipUnverified(selectReviewCandidates(projectId, board)).map(
        (candidate) => ({
          scope: "epic" as const,
          epicId: candidate.epicId,
          userStoryId: null,
          ticketId: candidate.ticketId,
        })
      ),
      result,
    });

    await dispatchKind({
      kind: "build",
      projectId,
      deps,
      config,
      budget: config.buildConcurrency,
      candidates: skipUnverified(selectBuildCandidates(projectId, board)).map(
        (candidate) => ({
          scope: candidate.scope,
          epicId: candidate.epicId,
          userStoryId: candidate.userStoryId,
          ticketId: candidate.ticketId,
        })
      ),
      result,
    });
  } catch (error) {
    console.error(
      `[auto-mode] Sweep failed for project ${projectId}:`,
      error instanceof Error ? error.message : error
    );
  } finally {
    autoModeRegistry.markSwept(projectId, now.toISOString());
    autoModeRegistry.unlock(projectId);
  }

  result.inFlight = autoModeRegistry.countInFlight(projectId);
  return result;
}

interface DispatchKindInput {
  kind: "build" | "review";
  projectId: string;
  deps: AutoModeEngineDeps;
  config: AutoModeConfig;
  budget: number;
  candidates: Array<{
    scope: "epic" | "story";
    epicId: string;
    userStoryId: string | null;
    ticketId: string;
  }>;
  result: AutoModeSweepResult;
}

/**
 * Drains one kind of candidate against its budget. A budget of 0 disables
 * this kind entirely without touching the other — "reviews only" and "builds
 * only" are both supported configurations.
 */
async function dispatchKind(input: DispatchKindInput): Promise<void> {
  const { kind, projectId, deps, config, budget, candidates, result } = input;
  if (budget <= 0 || candidates.length === 0) return;

  // Resolved once per kind, not per candidate: every candidate of this sweep
  // is the same question ("who is best at builds right now?"), and one answer
  // per sweep keeps the trace readable and the stats read off the hot loop.
  // Behind the empty-candidate guard above, so an idle sweep — the common
  // case, every 15 seconds — costs no stats query at all.
  const configuredAgent =
    kind === "build" ? config.buildAgent : config.reviewAgent;
  const smartPick =
    !configuredAgent && config.smartDispatch
      ? await deps.selectSmartAgent({ projectId, stage: kind })
      : null;

  for (const candidate of candidates) {
    const inFlight = autoModeRegistry.countInFlight(projectId)[kind];
    if (inFlight >= budget) return;
    if (!stillEnabled(projectId, deps)) {
      result.skipped = "disabled";
      return;
    }

    const dispatched = await deps.dispatch({
      projectId,
      stage: kind,
      scope: candidate.scope,
      epicId: candidate.epicId,
      userStoryId: candidate.userStoryId,
      // Only the field matching this stage may carry the smart pick — the
      // other one is not what is being dispatched.
      buildNamedAgentId:
        kind === "build"
          ? config.buildAgent ?? smartPick?.namedAgentId ?? null
          : config.buildAgent,
      reviewNamedAgentId:
        kind === "review"
          ? config.reviewAgent ?? smartPick?.namedAgentId ?? null
          : config.reviewAgent,
      ownSessionIds: autoModeRegistry.ownSessionIds(projectId),
    });

    if (dispatched.conflictSessionId) {
      trace(
        deps,
        projectId,
        candidate.epicId,
        AUTO_MODE_REASONS.skippedBusy,
        dispatched.conflictSessionId
      );
      continue;
    }

    if (!dispatched.sessionId) {
      if (!dispatched.error) {
        // A last-moment guard refused. Not the ticket's fault, so nothing is
        // charged — but the skip is logged, because a ticket the mode picked
        // and then dropped is otherwise invisible.
        trace(
          deps,
          projectId,
          candidate.epicId,
          AUTO_MODE_REASONS.skippedTargetMoved(
            kind,
            dispatched.skipReason ?? "the target changed"
          )
        );
        continue;
      }
      const failures = autoModeRegistry.recordFailure(
        projectId,
        candidate.ticketId,
        candidate.epicId,
        dispatched.error
      );
      trace(
        deps,
        projectId,
        candidate.epicId,
        AUTO_MODE_REASONS.dispatchFailed(kind, dispatched.error)
      );
      if (failures >= AUTO_MODE_MAX_CONSECUTIVE_FAILURES) {
        result.parked.push(candidate.ticketId);
        trace(
          deps,
          projectId,
          candidate.epicId,
          AUTO_MODE_REASONS.parked(failures)
        );
      }
      continue;
    }

    autoModeRegistry.addInFlight(projectId, dispatched.sessionId, {
      kind,
      ticketId: candidate.ticketId,
      epicId: candidate.epicId,
    });
    autoModeRegistry.recordDispatch(projectId, {
      kind,
      epicId: candidate.epicId,
      userStoryId: candidate.userStoryId,
      sessionId: dispatched.sessionId,
      detail: candidate.scope,
    });
    trace(
      deps,
      projectId,
      candidate.epicId,
      kind === "review"
        ? AUTO_MODE_REASONS.reviewDispatched
        : AUTO_MODE_REASONS.buildDispatched(candidate.scope),
      dispatched.sessionId
    );

    // The session row already carries the chosen named_agent_id; this second
    // entry carries the WHY, which the session row cannot express.
    if (smartPick) {
      trace(
        deps,
        projectId,
        candidate.epicId,
        AUTO_MODE_REASONS.smartDispatch(
          kind,
          smartPick.agentName ?? smartPick.namedAgentId,
          smartPick.successRate,
          smartPick.sampleSize
        ),
        dispatched.sessionId
      );
    }

    (kind === "review"
      ? result.reviewsDispatched
      : result.buildsDispatched
    ).push(dispatched.sessionId);
  }
}

/**
 * One pass over every project with the mode switched on. Exported pure (no
 * timer, no globals beyond the registry) so tests can drive it directly with
 * fake timers.
 */
export async function sweep(
  now: Date = new Date(),
  deps: AutoModeEngineDeps = defaultAutoModeDeps
): Promise<AutoModeSweepResult[]> {
  const results: AutoModeSweepResult[] = [];
  let projectIds: string[];
  try {
    projectIds = deps.listEnabledProjectIds();
  } catch (error) {
    console.error("[auto-mode] Failed to list enabled projects:", error);
    return results;
  }

  // Projects the registry still tracks as enabled but whose setting was just
  // switched off need one final sweep to clear their state.
  const known = new Set(projectIds);
  for (const projectId of autoModeRegistry.listEnabledProjectIds()) {
    if (!known.has(projectId)) projectIds.push(projectId);
  }

  for (const projectId of projectIds) {
    results.push(await sweepProject(projectId, deps, now));
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Timer lifecycle                                                     */
/* ------------------------------------------------------------------ */

/**
 * globalThis-backed timer slot (watchdog pattern): dev hot reloads
 * re-evaluate this module but must reuse the already-ticking interval
 * instead of stacking a second supervisor on the same board.
 */
const AUTO_MODE_GLOBAL_KEY = Symbol.for("arij.auto-mode");

interface AutoModeTimerSlot {
  timer: ReturnType<typeof setInterval> | null;
}

type AutoModeGlobal = { [AUTO_MODE_GLOBAL_KEY]?: AutoModeTimerSlot };

function timerSlot(): AutoModeTimerSlot {
  const store = globalThis as AutoModeGlobal;
  if (!store[AUTO_MODE_GLOBAL_KEY]) {
    store[AUTO_MODE_GLOBAL_KEY] = { timer: null };
  }
  return store[AUTO_MODE_GLOBAL_KEY];
}

/** Boot entry point (instrumentation.ts). Safe to call repeatedly. */
export function startAutoMode(): void {
  const slot = timerSlot();
  if (slot.timer) return;

  slot.timer = setInterval(() => {
    void sweep().catch((error) => {
      console.error("[auto-mode] Sweep failed", error);
    });
  }, AUTO_MODE_SWEEP_INTERVAL_MS);

  // Never keep the process alive just to supervise a board.
  slot.timer.unref?.();
}

export function stopAutoMode(): void {
  const slot = timerSlot();
  if (slot.timer) {
    clearInterval(slot.timer);
    slot.timer = null;
  }
  cancelPendingKicks();
}

export function isAutoModeRunning(): boolean {
  return timerSlot().timer !== null;
}

/* ------------------------------------------------------------------ */
/* Kicks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Per-project pending kick timers, globalThis-backed like everything else
 * that must survive a dev hot reload without doubling.
 */
const AUTO_MODE_KICKS_GLOBAL_KEY = Symbol.for("arij.auto-mode-kicks");

type KickGlobal = {
  [AUTO_MODE_KICKS_GLOBAL_KEY]?: Map<string, ReturnType<typeof setTimeout>>;
};

function kickTimers(): Map<string, ReturnType<typeof setTimeout>> {
  const store = globalThis as KickGlobal;
  if (!store[AUTO_MODE_KICKS_GLOBAL_KEY]) {
    store[AUTO_MODE_KICKS_GLOBAL_KEY] = new Map();
  }
  return store[AUTO_MODE_KICKS_GLOBAL_KEY];
}

/**
 * Debounced, fire-and-forget sweep for one project. Used by the PUT route
 * (enabling must not wait up to 15s for the next tick) and by the session
 * terminal hook (a finished agent frees a slot; the timer stays the backstop).
 *
 * The delay is NOT a nicety, it is a correctness requirement. The terminal
 * hook fires from inside `markSessionTerminal`, which every dispatch closure
 * calls BEFORE it applies the session's board effects — the pipeline driver
 * finalizes a build to `review`, or bounces a rejected epic back to
 * `in_progress`, in the statements right after (lib/pipeline/stages.ts).
 * A sweep running synchronously from that hook would read the board mid-flight
 * and could re-build a ticket that is about to enter review, or — far worse —
 * merge an epic whose negative review has not been applied yet. Deferring to a
 * later macrotask lets the finalization block finish first.
 *
 * Debouncing also collapses the storm a settling wave produces: ten sessions
 * ending together are worth one sweep, not ten.
 */
export const AUTO_MODE_KICK_DELAY_MS = 250;

export function kickAutoMode(
  projectId: string,
  delayMs: number = AUTO_MODE_KICK_DELAY_MS
): void {
  const timers = kickTimers();
  const pending = timers.get(projectId);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(() => {
    timers.delete(projectId);
    void sweepProject(projectId).catch((error) => {
      console.error(`[auto-mode] Kick failed for project ${projectId}:`, error);
    });
  }, delayMs);
  timer.unref?.();
  timers.set(projectId, timer);
}

/** Cancels every pending kick (tests, and stopAutoMode). */
export function cancelPendingKicks(): void {
  const timers = kickTimers();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/**
 * Terminal-hook entry point: a session just reached a terminal state, so the
 * project that owns it may have a free slot. Cheap no-op when the mode is
 * off for that project.
 */
export function kickAutoModeForSession(sessionId: string): void {
  try {
    const row = db
      .select({ projectId: agentSessions.projectId })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    if (!row?.projectId) return;
    if (!resolveAutoModeConfigForProject(row.projectId).enabled) return;
    kickAutoMode(row.projectId);
  } catch (error) {
    console.warn(
      "[auto-mode] Terminal-hook kick failed:",
      error instanceof Error ? error.message : error
    );
  }
}
