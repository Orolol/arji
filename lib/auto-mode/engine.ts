import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, epics } from "@/lib/db/schema";
import { logTransition } from "@/lib/workflow/log";
import { createPipelineStageDriver } from "@/lib/pipeline/stages";
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

/** Statuses a build may still be dispatched onto, checked at the last moment. */
const DISPATCHABLE_BUILD_STATUSES = new Set(["backlog", "todo", "in_progress"]);

/** Epics past the finish line — never a valid dispatch target. */
const DELIVERED_EPIC_STATUSES = new Set(["done", "released"]);

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
    }
  ): Promise<AutoMergeOutcome>;
  readSessionStatus(sessionId: string): string | null;
  /** Delivery verdict of a terminal session ("answered" | "silent" | …). */
  readSessionOutcome(sessionId: string): string | null;
  readEpicStatus(epicId: string): string | null;
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
    if (!DISPATCHABLE_BUILD_STATUSES.has(targetStatus ?? "")) {
      return {
        sessionId: null,
        error: null,
        conflictSessionId: null,
        skipReason: `target is no longer buildable (now ${targetStatus ?? "unknown"})`,
      };
    }
    // Story scope reports the story's status, so the parent epic is checked
    // separately: a released epic must not gain a new story build.
    if (input.scope === "story") {
      const epicStatus =
        db
          .select({ status: epics.status })
          .from(epics)
          .where(eq(epics.id, input.epicId))
          .get()?.status ?? null;
      if (DELIVERED_EPIC_STATUSES.has(epicStatus ?? "")) {
        return {
          sessionId: null,
          error: null,
          conflictSessionId: null,
          skipReason: `parent epic is ${epicStatus}`,
        };
      }
    }
  }

  const handle = await driver.launchStage({
    stage: input.stage,
    attempt: 1,
    fixCycle: 0,
    previousAttemptSessionId: null,
    lastCodeSessionId: null,
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

/**
 * Reconciles the in-flight map against the session rows: anything terminal
 * leaves the map, a completed session clears its ticket's failure streak and
 * a failed one extends it. A cancelled session is the user's decision, so it
 * counts neither way.
 */
function reconcileInFlight(
  projectId: string,
  deps: AutoModeEngineDeps,
  result: AutoModeSweepResult
): void {
  for (const { sessionId, entry } of autoModeRegistry.listInFlight(projectId)) {
    const status = deps.readSessionStatus(sessionId);
    if (status !== null && !TERMINAL_SESSION_STATUSES.has(status)) continue;

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
    }

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

    if (status === "completed" && !silentReview && !transitionRefused) {
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
    reconcileInFlight(projectId, deps, result);

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
    for (const candidate of selectMergeCandidates(projectId, board)) {
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
          parkRejectedSecondOpinion(
            projectId,
            candidate.epicId,
            gate,
            deps,
            result
          );
          continue;
        }
        if (gate.status !== "approved") {
          const reviewsInFlight =
            autoModeRegistry.countInFlight(projectId).review;
          if (
            gate.status === "pending" ||
            config.reviewConcurrency <= 0 ||
            reviewsInFlight >= config.reviewConcurrency
          ) {
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
            continue;
          }

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
      const outcome = await deps.merge(projectId, candidate.epicId, {
        namedAgentId: config.buildAgent,
        dispatchConflictAgent:
          config.buildConcurrency > 0 && buildsInFlight < config.buildConcurrency,
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
      candidates: selectReviewCandidates(projectId, board).map((candidate) => ({
        scope: "epic" as const,
        epicId: candidate.epicId,
        userStoryId: null,
        ticketId: candidate.ticketId,
      })),
      result,
    });

    await dispatchKind({
      kind: "build",
      projectId,
      deps,
      config,
      budget: config.buildConcurrency,
      candidates: selectBuildCandidates(projectId, board).map((candidate) => ({
        scope: candidate.scope,
        epicId: candidate.epicId,
        userStoryId: candidate.userStoryId,
        ticketId: candidate.ticketId,
      })),
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
