import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, settings } from "@/lib/db/schema";
import type { BatchExecutionPlan } from "@/lib/dependencies/scheduler";
import {
  countPlanStatuses,
  runExecutionWaves,
  type WaveFailurePolicy,
  type WaveLaunchHandle,
  type WaveSkippedTicket,
  type WaveTicketResult,
} from "@/lib/dependencies/wave-runner";
import { dagBatchRegistry } from "@/lib/agents/dag-batch-registry";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { logTransition } from "@/lib/workflow/log";
import {
  buildNightRunSummaryTitle,
  createDagWaveOutcomeNotification,
  createNightRunSummaryNotification,
} from "@/lib/notifications/create";
import { durationMsBetween, sendProjectWebhook } from "@/lib/webhooks/send";
import { maybeDreamAfterNightRun } from "@/lib/workflow/dreaming";
import {
  startPipelineRun,
  type PipelineStageResult,
  type PipelineTerminalSummary,
} from "@/lib/pipeline";
import type { PipelineTerminalState } from "@/lib/pipeline/runner";
import {
  DEFAULT_NIGHT_CIRCUIT_BREAKER,
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
  NIGHT_STOPPED_ABORT_REASON,
  nightCircuitBreakerSettingKey,
  nightCostCapSettingKey,
  parseNightCircuitBreaker,
  parseNightCostCap,
} from "./constants";
import { nightRunRegistry } from "./registry";
import { isNightRunCostPartial, sumNightRunCost } from "./summary";

/**
 * Night-run engine: the existing DAG wave engine (`runExecutionWaves`) with a
 * per-epic PIPELINE launch adapter. Each wave ticket's session is the epic's
 * initial build session (created by the route's injected `launchBuild`), but
 * the ticket only settles when the epic's ENTIRE autonomous pipeline (build →
 * review → auto-fix → forensic) reaches a terminal state — so wave N+1 starts
 * on reviewed dependencies, not merely built ones.
 *
 * Blocking semantics compose unchanged: a pipeline that failed or paused on a
 * question blocks its dependents exactly like a failed/asking session blocks
 * them in a plain DAG batch. Three night-only additions ride the wave engine's
 * `shouldAbortRun` hook, all at wave-boundary granularity (an in-flight wave
 * may overshoot — accepted):
 *   - user stop: POST .../night-runs/[runId]/stop flags the registry entry;
 *     the next wave boundary aborts with NIGHT_STOPPED_ABORT_REASON. In-flight
 *     pipelines are deliberately NOT force-cancelled — identical semantics to
 *     a breaker trip, so a half-built epic still gets reviewed and closed;
 *   - circuit breaker: N consecutive epic-level pipeline failures abort the
 *     remaining waves (success resets the streak; paused_question and
 *     cancelled are neutral — no count, no reset);
 *   - cost cap: SUM(total_cost_usd) over the run's tagged sessions crossing
 *     the cap aborts the rest. Claude-only blind spot: other providers report
 *     no cost, so the total is a lower bound.
 *
 * Bookkeeping goes to BOTH registries: dagBatchRegistry (the AgentMonitor
 * wave chip keeps working unchanged) and nightRunRegistry (run snapshot +
 * terminal ring for the morning summary).
 */

export interface StartNightRunInput {
  projectId: string;
  /** `night_`-prefixed run id (also the agent_sessions.batch_run_id tag). */
  runId: string;
  plan: BatchExecutionPlan;
  /** Predecessor adjacency, as returned by `loadProjectGraph`. */
  graph: Map<string, Set<string>>;
  failurePolicy: WaveFailurePolicy;
  namedAgentId: string | null;
  /** Request override; falls back to project → global setting → default 3. */
  breakerThreshold?: number | null;
  /** Request override; falls back to project → global setting → unlimited. */
  costCapUsd?: number | null;
  /**
   * Creates the initial build session for one epic (the batch route's
   * `launchEpic`). Null/undefined when the epic cannot be launched.
   */
  launchBuild(epicId: string): Promise<WaveLaunchHandle | null | undefined>;
}

export interface StartNightRunHandle {
  /** Session ids of the first wave, once its launches were all submitted. */
  firstWaveLaunched: Promise<string[]>;
  /** Settles (never rejects) when the run is fully over. */
  engineDone: Promise<void>;
}

function readSettingValue(key: string): string | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.value ?? null;
}

/**
 * Effective breaker threshold: request override → project setting → global
 * setting → default 3. Clamped 0..10; 0 disables the breaker.
 */
export function resolveNightCircuitBreaker(
  projectId: string,
  override?: number | null
): number {
  const fromOverride = parseNightCircuitBreaker(override ?? null);
  if (fromOverride !== null) return fromOverride;
  for (const key of [
    nightCircuitBreakerSettingKey(projectId),
    NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  ]) {
    const parsed = parseNightCircuitBreaker(readSettingValue(key));
    if (parsed !== null) return parsed;
  }
  return DEFAULT_NIGHT_CIRCUIT_BREAKER;
}

/**
 * Effective cost cap in USD: request override → project setting → global
 * setting → null (unlimited).
 */
export function resolveNightCostCap(
  projectId: string,
  override?: number | null
): number | null {
  const fromOverride = parseNightCostCap(override ?? null);
  if (fromOverride !== null) return fromOverride;
  for (const key of [
    nightCostCapSettingKey(projectId),
    NIGHT_COST_CAP_SETTING_KEY,
  ]) {
    const parsed = parseNightCostCap(readSettingValue(key));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Fixed pipeline-terminal → wave-ticket mapping (the night composition
 * contract):
 *   succeeded       → success/answered   (wave "done"; epic sits in review)
 *   paused_question → success/asked_question (wave "asked"; blocks dependents)
 *   failed          → failure with the pipeline's reason
 *   cancelled       → failure "stopped by user" (a user stop blocks dependents)
 */
export function mapPipelineTerminalToWaveTicket(
  epicId: string,
  sessionId: string,
  summary: PipelineTerminalSummary
): WaveTicketResult {
  switch (summary.state) {
    case "succeeded":
      return { epicId, sessionId, success: true, outcome: "answered", error: null };
    case "paused_question":
      return {
        epicId,
        sessionId,
        success: true,
        outcome: "asked_question",
        error: null,
      };
    case "cancelled":
      return {
        epicId,
        sessionId,
        success: false,
        outcome: "error",
        error: "stopped by user",
      };
    case "failed":
      return {
        epicId,
        sessionId,
        success: false,
        outcome: "error",
        error: summary.reason ?? "pipeline failed",
      };
  }
}

/** What the breaker is told about one settled epic. */
export type NightBreakerObservation = PipelineTerminalState;

/**
 * Consecutive-failure counter for the circuit breaker. Observations arrive
 * in wave settlement order (deterministic: immediate launch failures first,
 * then launch order — see wave-runner). `failed` increments the streak,
 * `succeeded` resets it, `paused_question` and `cancelled` are neutral.
 * Threshold 0 disables the breaker entirely.
 */
export class NightCircuitBreaker {
  private streak = 0;
  private reason: string | null = null;

  constructor(readonly threshold: number) {}

  observe(state: NightBreakerObservation): void {
    if (state === "failed") {
      this.streak += 1;
      if (
        this.threshold > 0 &&
        this.streak >= this.threshold &&
        this.reason === null
      ) {
        this.reason = `circuit breaker: ${this.streak} consecutive pipeline failures`;
      }
    } else if (state === "succeeded") {
      this.streak = 0;
    }
    // paused_question / cancelled: neutral — no count, no reset.
  }

  get currentStreak(): number {
    return this.streak;
  }

  /** Non-null once tripped (sticky). */
  trippedReason(): string | null {
    return this.reason;
  }
}

function formatUsd(value: number): string {
  return value.toFixed(2);
}

/**
 * Registers and starts one night run. Synchronous: both registries hold the
 * run before this returns (the route's guard → register window contains no
 * await), and the wave engine keeps running in the background long after the
 * dispatching HTTP request ended.
 */
export function startNightRun(input: StartNightRunInput): StartNightRunHandle {
  const { projectId, runId, plan, graph, failurePolicy, namedAgentId } = input;

  const startedAt = new Date().toISOString();
  const totalWaves = plan.layers.length;
  const planEpicIds = plan.layers.flat();
  const breakerThreshold = resolveNightCircuitBreaker(
    projectId,
    input.breakerThreshold
  );
  const costCap = resolveNightCostCap(projectId, input.costCapUsd);

  nightRunRegistry.register({
    runId,
    projectId,
    failurePolicy,
    breakerThreshold,
    costCapUsd: costCap,
    state: "running",
    startedAt,
    endedAt: null,
    currentWave: 0,
    totalWaves,
    totalEpics: planEpicIds.length,
    counts: countPlanStatuses(plan),
    epics: planEpicIds.map((epicId) => ({
      epicId,
      pipelineRunId: null,
      status: "pending" as const,
      reason: null,
    })),
    stopRequested: false,
    abortReason: null,
    abortedAtWave: null,
  });

  // The AgentMonitor wave chip polls the DAG registry — night runs feed it
  // exactly like plain DAG batches (batchId = the night runId).
  dagBatchRegistry.start({
    batchId: runId,
    projectId,
    failurePolicy,
    totalWaves,
    totalEpics: planEpicIds.length,
  });

  const breaker = new NightCircuitBreaker(breakerThreshold);
  /** epicId → pipeline terminal state, recorded when onTerminal fires. */
  const terminalStates = new Map<string, PipelineTerminalState>();

  const syncRegistries = (): void => {
    const counts = countPlanStatuses(plan);
    dagBatchRegistry.setCounts(runId, counts);
    nightRunRegistry.update(runId, { counts });
    for (const [epicId, status] of plan.ticketStatus) {
      nightRunRegistry.updateEpic(runId, epicId, {
        status,
        reason: plan.failureReasons.get(epicId) ?? null,
      });
    }
  };

  /**
   * The composition seam: launch the epic's build session through the
   * route's launcher, immediately start the autonomous pipeline on top of
   * it, and hand the wave engine a ticket that settles at PIPELINE terminal
   * (mapPipelineTerminalToWaveTicket) instead of at build terminal.
   */
  const launch = async (epicId: string): Promise<WaveLaunchHandle | null> => {
    const handle = await input.launchBuild(epicId);
    if (!handle) return null;

    let settle!: (result: WaveTicketResult) => void;
    const settled = new Promise<WaveTicketResult>((resolve) => {
      settle = resolve;
    });

    const buildSettled: Promise<PipelineStageResult> = handle.settled.then(
      (result) => ({
        sessionId: result.sessionId ?? handle.sessionId,
        success: result.success,
        outcome: result.outcome,
        error: result.error,
      })
    );

    // launchEpic does not expose the resolved provider — re-resolve exactly
    // like the route does for its own dispatch (deterministic chain).
    const provider = resolveAgentByNamedId(
      "build",
      projectId,
      namedAgentId
    ).provider;

    const { runId: pipelineRunId } = startPipelineRun({
      projectId,
      scope: "epic",
      epicId,
      userStoryId: null,
      buildSessionId: handle.sessionId,
      buildProvider: provider,
      buildNamedAgentId: namedAgentId,
      buildSettled,
      batchRunId: runId,
      onTerminal: (summary) => {
        terminalStates.set(epicId, summary.state);
        settle(
          mapPipelineTerminalToWaveTicket(epicId, handle.sessionId, summary)
        );
      },
    });

    nightRunRegistry.updateEpic(runId, epicId, { pipelineRunId });
    // The engine marked the ticket "running" before calling launch — make
    // the live registries reflect it (counts + per-epic status).
    syncRegistries();
    return { sessionId: handle.sessionId, settled };
  };

  /** Breaker input for one settled wave ticket. */
  const observationFor = (
    result: WaveTicketResult
  ): NightBreakerObservation => {
    const recorded = terminalStates.get(result.epicId);
    if (recorded) return recorded;
    // No pipeline ever started (launch refusal or throw): an epic that could
    // not even launch is a failure as far as the breaker is concerned.
    if (!result.success) return "failed";
    return result.outcome === "asked_question" ? "paused_question" : "succeeded";
  };

  const shouldAbortRun = (): string | null => {
    // User intent first: an explicit stop outranks whatever the breaker or
    // the cost cap would have said.
    if (nightRunRegistry.isStopRequested(runId)) {
      return NIGHT_STOPPED_ABORT_REASON;
    }
    const breakerReason = breaker.trippedReason();
    if (breakerReason) return breakerReason;
    if (costCap !== null) {
      try {
        const spent = sumNightRunCost(runId);
        if (spent >= costCap) {
          return `cost cap reached: $${formatUsd(spent)} of $${formatUsd(costCap)}`;
        }
      } catch (error) {
        console.warn(
          "[night] Cost cap check failed:",
          error instanceof Error ? error.message : error
        );
      }
    }
    return null;
  };

  const skipReason = (skip: WaveSkippedTicket): string => {
    if (skip.kind === "aborted") {
      // markSkipped stored the abort reason verbatim.
      return plan.failureReasons.get(skip.epicId) ?? "night run aborted";
    }
    if (skip.kind === "stopped") {
      return `skipped: batch stopped after wave ${skip.wave} failure`;
    }
    const blocker = skip.blockedById
      ? db
          .select({ readableId: epics.readableId, title: epics.title })
          .from(epics)
          .where(eq(epics.id, skip.blockedById))
          .get()
      : null;
    const ref =
      blocker?.readableId || blocker?.title || skip.blockedById || "unknown";
    return skip.kind === "failed"
      ? `skipped: dependency ${ref} failed`
      : `skipped: dependency ${ref} asked a question`;
  };

  let resolveFirstWave!: (sessionIds: string[]) => void;
  let firstWaveResolved = false;
  const firstWaveLaunched = new Promise<string[]>((resolve) => {
    resolveFirstWave = resolve;
  });
  const settleFirstWave = (sessionIds: string[]): void => {
    if (firstWaveResolved) return;
    firstWaveResolved = true;
    resolveFirstWave(sessionIds);
  };

  /**
   * Single terminal choke point (normal finish AND the crash safety net):
   * final counts to both registries, night ring snapshot, monitor cleanup,
   * then EXACTLY ONE summary notification, ONE webhook and — behind the
   * `dreaming_after_night_run` setting — ONE cross-session dream. Never fires
   * for restart-interrupted runs — the process (and this closure) died with
   * them.
   */
  let finished = false;
  const finishRun = (abortInfo: {
    abortReason: string | null;
    abortedAtWave: number | null;
  }): void => {
    if (finished) return;
    finished = true;
    const endedAt = new Date().toISOString();

    try {
      syncRegistries();
      nightRunRegistry.update(runId, abortInfo);
    } catch {
      // registry sync is best-effort
    }
    nightRunRegistry.finish(runId, endedAt);
    dagBatchRegistry.finish(runId);

    const counts = countPlanStatuses(plan);
    let totalCostUsd = 0;
    let costIsPartial = false;
    try {
      totalCostUsd = sumNightRunCost(runId);
      costIsPartial = isNightRunCostPartial(runId);
    } catch (error) {
      console.warn(
        "[night] Cost summary failed:",
        error instanceof Error ? error.message : error
      );
    }

    const durationMs = durationMsBetween(startedAt, endedAt);
    try {
      createNightRunSummaryNotification({
        projectId,
        runId,
        counts,
        totalCostUsd,
        costIsPartial,
        abortReason: abortInfo.abortReason,
        durationMs,
      });
    } catch (error) {
      console.warn(
        "[night] Summary notification failed:",
        error instanceof Error ? error.message : error
      );
    }

    void sendProjectWebhook(projectId, {
      event: "night_run.completed",
      summary: buildNightRunSummaryTitle(
        counts,
        totalCostUsd,
        costIsPartial,
        abortInfo.abortReason
      ),
      durationMs,
      error: abortInfo.abortReason,
      path: `/projects/${projectId}?nightRun=${runId}`,
    });

    // Fire-and-forget cross-session distillation of everything this run just
    // taught (OFF unless `dreaming_after_night_run` says otherwise). It runs
    // AFTER the summary on purpose: the run is already closed and counted, so
    // a dream can neither delay the morning summary nor fail it.
    //
    // Because it starts past the wave engine's last `shouldAbortRun` check,
    // the cap can no longer stop it there — so the cap and the user's stop are
    // handed over explicitly and re-applied by the trigger before it spends
    // anything. The run id still rides along as batch_run_id, so every
    // DB-derived total for the run (detail view, sumNightRunCost) includes the
    // dream; only the summary notification above, already sent, does not.
    void maybeDreamAfterNightRun(projectId, runId, {
      abortReason: abortInfo.abortReason,
      costCapUsd: costCap,
      spentUsd: totalCostUsd,
    });
  };

  const engineRun = runExecutionWaves({
    plan,
    graph,
    failurePolicy,
    launch,
    shouldAbortRun,
    callbacks: {
      onWaveStart: (wave) => {
        dagBatchRegistry.setWave(runId, wave);
        nightRunRegistry.update(runId, { currentWave: wave });
        syncRegistries();
      },
      onWaveLaunched: (_wave, sessionIds) => {
        settleFirstWave(sessionIds);
      },
      onWaveSettled: (_wave, results) => {
        for (const result of results) {
          breaker.observe(observationFor(result));
        }
        syncRegistries();
      },
      onSkip: (skip) => {
        syncRegistries();
        // The skipped ticket never moves — log the decision so the board
        // history answers "why didn't this build?".
        try {
          const held = db
            .select({ status: epics.status })
            .from(epics)
            .where(eq(epics.id, skip.epicId))
            .get();
          const heldStatus = held?.status ?? "backlog";
          logTransition({
            projectId,
            epicId: skip.epicId,
            fromStatus: heldStatus,
            toStatus: heldStatus,
            actor: "system",
            reason: skipReason(skip),
            sessionId: skip.blockedBySessionId ?? undefined,
          });
        } catch (error) {
          console.warn(
            `[night] Failed to log skip for epic ${skip.epicId}`,
            error
          );
        }
      },
      onWaveBlocked: (wave, blocked, waveSkipped) => {
        // Same dedupe as the plain DAG route: a wave blocked *solely* by
        // questions that skipped nothing adds no information beyond the
        // per-session asked-question notifications.
        const onlyUnblockingQuestions =
          blocked.every((b) => b.success) && waveSkipped.length === 0;
        if (onlyUnblockingQuestions) return;

        try {
          createDagWaveOutcomeNotification({
            projectId,
            wave,
            totalWaves,
            blocked: blocked.map((b) => ({
              epicId: b.epicId,
              kind: b.success
                ? ("asked_question" as const)
                : ("failed" as const),
            })),
            skippedCount: waveSkipped.length,
            stopped: failurePolicy === "stop",
          });
        } catch (error) {
          console.warn("[night] Failed to create wave notification", error);
        }
      },
      onFinish: (summary) => {
        finishRun({
          abortReason: summary.abortReason,
          abortedAtWave: summary.abortedAtWave,
        });
      },
    },
  });

  // The engine outlives the HTTP request. Launch failures become wave
  // results, so a rejection here is an engine bug — close the run through
  // the same choke point so it cannot look active forever.
  const engineDone: Promise<void> = engineRun
    .then(
      () => undefined,
      (error) => {
        console.error(`[night] Run ${runId} crashed`, error);
        finishRun({ abortReason: "night engine error", abortedAtWave: null });
      }
    )
    .then(() => {
      // However the run ended, the dispatch response must never hang.
      settleFirstWave([]);
    });

  return { firstWaveLaunched, engineDone };
}
