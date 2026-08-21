import type {
  BatchExecutionPlan,
  TicketExecutionStatus,
} from "@/lib/dependencies/scheduler";

/**
 * Wave execution engine for DAG batch builds.
 *
 * Consumes the layered plan produced by `buildExecutionPlan` and runs it
 * wave by wave: every ticket of wave N is launched (through whatever
 * dispatcher the caller injects — production wires the agent scheduler, so
 * per-project budgets still throttle actual CLI spawns within a wave), then
 * the engine waits for ALL of the wave's sessions to settle before wave N+1
 * starts. Dependencies therefore always finish before their dependents run.
 *
 * Blocking semantics: a ticket blocks its dependents when its session failed
 * OR ended with the `asked_question` verdict (an unanswered question means
 * the work is not done, so building on top of it would be building on air).
 * Transitive dependents of a blocked ticket are marked `skipped` — they get
 * no session at all.
 *
 * Failure policies:
 *   - "halt" (default): skip the blocked subtree but keep executing
 *     independent branches in later waves.
 *   - "stop": abandon every remaining wave after the first blocked wave;
 *     all not-yet-launched tickets are marked skipped.
 *
 * The engine is deliberately side-effect free: DB writes (activity log,
 * notifications, registry updates) happen in the caller-provided callbacks.
 * Callbacks are invoked synchronously in deterministic order and must not
 * throw (the route wraps its own side effects).
 */

export type WaveFailurePolicy = "halt" | "stop";

/** Why a ticket was blocked (and why its dependents were skipped). */
export type WaveBlockKind = "failed" | "asked_question";

/**
 * Why a ticket was skipped: a blocked dependency, the stop policy, or a
 * caller-requested mid-run abort (see shouldAbortRun).
 */
export type WaveSkipKind = WaveBlockKind | "stopped" | "aborted";

/** Terminal per-ticket result for a launched session. */
export interface WaveTicketResult {
  epicId: string;
  /** Null when the launch itself failed before a session row existed. */
  sessionId: string | null;
  success: boolean;
  /** Session/workflow verdict (e.g. "answered", "asked_question", "transition_refused"). */
  outcome: string | null;
  error: string | null;
}

export interface WaveSkippedTicket {
  epicId: string;
  kind: WaveSkipKind;
  /** Blocking dependency (null for "stopped"/"aborted" skips). */
  blockedById: string | null;
  /** Session id of the blocking dependency, when it had one. */
  blockedBySessionId: string | null;
  /**
   * 1-based wave whose outcome caused this skip ("aborted": the last
   * executed wave, whose settlement tripped the abort — 0 when the run
   * aborted before any wave launched).
   */
  wave: number;
}

/** Handle returned by the injected launcher for a successfully created session. */
export interface WaveLaunchHandle {
  sessionId: string;
  /** Resolves (never rejects) when the session reaches a terminal state. */
  settled: Promise<WaveTicketResult>;
}

export interface WaveRunnerCallbacks {
  /** A wave is about to launch (only fired for waves with launchable tickets). */
  onWaveStart?(wave: number, totalWaves: number, epicIds: string[]): void;
  /** All launches of the wave were submitted (session ids of the created sessions). */
  onWaveLaunched?(wave: number, sessionIds: string[]): void;
  /** Every session of the wave settled. */
  onWaveSettled?(wave: number, results: WaveTicketResult[]): void;
  /** One ticket was marked skipped. */
  onSkip?(skip: WaveSkippedTicket): void;
  /** A wave ended with at least one blocked ticket (after onSkip calls). */
  onWaveBlocked?(
    wave: number,
    blocked: WaveTicketResult[],
    skipped: WaveSkippedTicket[]
  ): void;
  /** The run is over (all waves executed, or abandoned under "stop"). */
  onFinish?(summary: WaveExecutionSummary): void;
}

export interface WaveExecutionSummary {
  /** Settled results for every ticket that got a launch attempt. */
  results: WaveTicketResult[];
  /** Tickets that never launched. */
  skipped: WaveSkippedTicket[];
  totalWaves: number;
  /** Waves that actually launched at least one ticket. */
  wavesExecuted: number;
  /** Wave after which the run was abandoned ("stop" policy), else null. */
  stoppedAtWave: number | null;
  /**
   * Last executed wave when shouldAbortRun tripped, else null (also null
   * when the option was absent). 0 when the abort fired before any launch.
   */
  abortedAtWave: number | null;
  /** Reason returned by shouldAbortRun, verbatim; null when never aborted. */
  abortReason: string | null;
}

export interface RunExecutionWavesOptions {
  plan: BatchExecutionPlan;
  /**
   * Predecessor adjacency for the project (ticketId -> ids it depends on),
   * as returned by `loadProjectGraph`. Only edges between plan tickets are
   * considered; the engine never touches the database itself.
   */
  graph: Map<string, Set<string>>;
  failurePolicy: WaveFailurePolicy;
  /**
   * Creates the session for one epic. Returns null when the epic cannot be
   * launched (e.g. it no longer exists); a thrown error is treated the same
   * as a failed session — dependents get skipped either way.
   */
  launch(epicId: string): Promise<WaveLaunchHandle | null>;
  /**
   * Mid-run abort hook (circuit breaker, cost cap): polled at the top of
   * every wave iteration, BEFORE that wave launches anything. A non-null
   * return aborts the run: every still-pending ticket is skipped with kind
   * "aborted" and the returned reason verbatim, and the summary carries
   * abortedAtWave/abortReason. In-flight waves are never interrupted — all
   * launches of a wave are submitted before any settle, so the wave
   * boundary is exactly "stop launching, let in-flight settle". Must not
   * throw (same convention as the callbacks). Absent option = unchanged
   * behavior.
   */
  shouldAbortRun?(): string | null;
  callbacks?: WaveRunnerCallbacks;
}

/** Successor adjacency restricted to the plan's tickets. */
function buildSuccessors(
  planTickets: Set<string>,
  graph: Map<string, Set<string>>
): Map<string, Set<string>> {
  const successors = new Map<string, Set<string>>();
  for (const ticket of planTickets) {
    const deps = graph.get(ticket);
    if (!deps) continue;
    for (const dep of deps) {
      if (!planTickets.has(dep)) continue;
      if (!successors.has(dep)) {
        successors.set(dep, new Set());
      }
      successors.get(dep)!.add(ticket);
    }
  }
  return successors;
}

/** All transitive dependents of `root` within the plan (BFS, root excluded). */
function transitiveDependents(
  successors: Map<string, Set<string>>,
  root: string
): string[] {
  const result: string[] = [];
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of successors.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
}

/** Snapshot of the plan's per-status counts (for monitors/registries). */
export function countPlanStatuses(
  plan: BatchExecutionPlan
): Record<TicketExecutionStatus, number> {
  const counts: Record<TicketExecutionStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    asked: 0,
    failed: 0,
    skipped: 0,
  };
  for (const status of plan.ticketStatus.values()) {
    counts[status] += 1;
  }
  return counts;
}

function toBlockKind(result: WaveTicketResult): WaveBlockKind {
  return result.success ? "asked_question" : "failed";
}

/**
 * Executes the plan wave by wave. Resolves with the run summary; never
 * rejects for per-ticket launch/session failures (those become results).
 */
export async function runExecutionWaves(
  options: RunExecutionWavesOptions
): Promise<WaveExecutionSummary> {
  const { plan, graph, failurePolicy, launch } = options;
  const callbacks = options.callbacks ?? {};

  const planTickets = new Set<string>(plan.ticketStatus.keys());
  const successors = buildSuccessors(planTickets, graph);

  const results: WaveTicketResult[] = [];
  const skipped: WaveSkippedTicket[] = [];
  const totalWaves = plan.layers.length;
  let wavesExecuted = 0;
  let stoppedAtWave: number | null = null;
  /** Last wave that actually launched tickets (0 before the first launch). */
  let lastExecutedWave = 0;
  let abortedAtWave: number | null = null;
  let abortReason: string | null = null;

  const markSkipped = (
    epicId: string,
    skip: Omit<WaveSkippedTicket, "epicId">,
    reasonOverride?: string
  ): void => {
    plan.ticketStatus.set(epicId, "skipped");
    plan.failureReasons.set(
      epicId,
      reasonOverride ??
        (skip.kind === "stopped"
          ? `batch stopped after wave ${skip.wave}`
          : `dependency ${skip.blockedById} ${
              skip.kind === "failed" ? "failed" : "asked a question"
            }`)
    );
    const entry: WaveSkippedTicket = { epicId, ...skip };
    skipped.push(entry);
    callbacks.onSkip?.(entry);
  };

  for (let i = 0; i < plan.layers.length; i++) {
    // Abort poll (circuit breaker / cost cap): checked at the wave boundary,
    // before this wave launches anything. Every still-pending ticket —
    // dependent or not — is skipped with the reason verbatim.
    const abort = options.shouldAbortRun?.() ?? null;
    if (abort !== null) {
      abortedAtWave = lastExecutedWave;
      abortReason = abort;
      for (const ticket of planTickets) {
        if (plan.ticketStatus.get(ticket) !== "pending") continue;
        markSkipped(
          ticket,
          {
            kind: "aborted",
            blockedById: null,
            blockedBySessionId: null,
            wave: lastExecutedWave,
          },
          abort
        );
      }
      break;
    }

    const wave = i + 1;
    const toLaunch = plan.layers[i].filter(
      (id) => plan.ticketStatus.get(id) === "pending"
    );
    if (toLaunch.length === 0) continue;

    wavesExecuted += 1;
    lastExecutedWave = wave;
    callbacks.onWaveStart?.(wave, totalWaves, toLaunch);

    // Launches are submitted sequentially (worktree creation is cheap and
    // this keeps ordering deterministic); the injected dispatcher decides
    // how many sessions actually run concurrently.
    const launched: Array<{ epicId: string; handle: WaveLaunchHandle }> = [];
    const immediateFailures: WaveTicketResult[] = [];
    for (const epicId of toLaunch) {
      plan.ticketStatus.set(epicId, "running");
      try {
        const handle = await launch(epicId);
        if (handle) {
          launched.push({ epicId, handle });
        } else {
          immediateFailures.push({
            epicId,
            sessionId: null,
            success: false,
            outcome: "error",
            error: "Launch failed: epic not found",
          });
        }
      } catch (error) {
        immediateFailures.push({
          epicId,
          sessionId: null,
          success: false,
          outcome: "error",
          error:
            error instanceof Error
              ? error.message
              : typeof error === "object" && error !== null && "error" in error
                ? String((error as { error: unknown }).error)
                : "Launch failed",
        });
      }
    }

    callbacks.onWaveLaunched?.(
      wave,
      launched.map((l) => l.handle.sessionId)
    );

    const settledResults = await Promise.all(
      launched.map((l) => l.handle.settled)
    );
    const waveResults = [...immediateFailures, ...settledResults];

    for (const result of waveResults) {
      const status: TicketExecutionStatus = !result.success
        ? "failed"
        : result.outcome === "asked_question"
          ? "asked"
          : "done";
      plan.ticketStatus.set(result.epicId, status);
      if (!result.success) {
        plan.failureReasons.set(
          result.epicId,
          result.error || "Session failed"
        );
      }
    }
    results.push(...waveResults);
    callbacks.onWaveSettled?.(wave, waveResults);

    const blocked = waveResults.filter(
      (r) => !r.success || r.outcome === "asked_question"
    );
    if (blocked.length === 0) continue;

    const waveSkipped: WaveSkippedTicket[] = [];
    const skipFrom = skipped.length;

    // Skip the transitive dependents of every blocked ticket (first blocking
    // cause wins — already-skipped tickets are not re-marked).
    for (const blocker of blocked) {
      const kind = toBlockKind(blocker);
      for (const dependent of transitiveDependents(
        successors,
        blocker.epicId
      )) {
        if (plan.ticketStatus.get(dependent) !== "pending") continue;
        markSkipped(dependent, {
          kind,
          blockedById: blocker.epicId,
          blockedBySessionId: blocker.sessionId,
          wave,
        });
      }
    }

    if (failurePolicy === "stop") {
      // Abandon everything that has not launched yet, dependent or not.
      for (const ticket of planTickets) {
        if (plan.ticketStatus.get(ticket) !== "pending") continue;
        markSkipped(ticket, {
          kind: "stopped",
          blockedById: null,
          blockedBySessionId: null,
          wave,
        });
      }
      stoppedAtWave = wave;
    }

    waveSkipped.push(...skipped.slice(skipFrom));
    callbacks.onWaveBlocked?.(wave, blocked, waveSkipped);

    if (stoppedAtWave !== null) break;
  }

  const summary: WaveExecutionSummary = {
    results,
    skipped,
    totalWaves,
    wavesExecuted,
    stoppedAtWave,
    abortedAtWave,
    abortReason,
  };
  callbacks.onFinish?.(summary);
  return summary;
}
