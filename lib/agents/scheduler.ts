import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, settings } from "@/lib/db/schema";
import { isCodeProducingAgentType } from "@/lib/agent-config/constants";
import {
  isSessionLifecycleConflictError,
  isSessionNotFoundError,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { pullTicketBackIfPromoted } from "@/lib/workflow/automatic-transitions";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  agentMaxConcurrentSettingKey,
  isValidMaxConcurrent,
  parseMaxConcurrentSetting,
} from "@/lib/agents/scheduler-constants";

/**
 * In-process agent scheduler: a real queue behind the DB 'queued' status.
 *
 * Batch-style agent launches (epic/story build, projects/build solo+team,
 * epic/story review, merge auto-agent, QA check) create their session row
 * with `createQueuedSession` and then `submit()` a launch closure here
 * instead of spawning inline. The scheduler gates starts on a per-project
 * "Max concurrent agents" budget; excess submissions wait FIFO in memory
 * while their DB row stays 'queued'. `markSessionRunning` happens inside
 * the launch closure, so the DB status only moves to 'running' when the CLI
 * actually spawns.
 *
 * EXEMPT (launched immediately, never scheduled): interactive
 * chat/conversation spawns (lib/chat, spec generation and other
 * activity-registry flows) — a user is sitting in front of those and
 * queueing them behind batch work would read as a hang. The same reasoning
 * exempts the other single-shot request/response agent paths
 * (resolve-merge, release notes, git pull): the user triggers one and
 * watches it. Only batch-style dispatch goes through the queue.
 *
 * Budget resolution per project (first hit wins; a stored 0 means unlimited):
 *   1. settings key `agent_max_concurrent:<projectId>`
 *   2. settings key `agent_max_concurrent` (global default)
 *   3. DEFAULT_MAX_CONCURRENT_AGENTS (unlimited — nothing queues until the
 *      user sets an explicit cap)
 * The budget is re-read whenever a start decision is made, so setting
 * changes apply to the very next slot without a restart.
 *
 * Like lib/claude/process-manager.ts, the singleton lives in module scope
 * and persists across requests within one server process. Queue entries are
 * launch closures and therefore die with the process: sessions left
 * 'queued' in the DB by a dead server are unrecoverable and are cancelled
 * at boot ('orphaned by restart') by
 * lib/agent-sessions/boot-cleanup.ts, wired in instrumentation.ts.
 */

/** A launch closure waiting for a slot. */
interface QueuedLaunch {
  sessionId: string;
  launch: () => Promise<void>;
}

interface ProjectSchedulerState {
  /** Session ids currently holding a slot (launch closure not settled). */
  running: Set<string>;
  /** FIFO backlog of launches waiting for a slot. */
  queue: QueuedLaunch[];
}

export interface SchedulerProjectCounts {
  projectId: string;
  running: number;
  queued: number;
}

export interface SubmitResult {
  /** True when the launch started immediately; false when it queued. */
  started: boolean;
  /** Number of entries ahead of this one in the queue (0 when started). */
  queuedAhead: number;
}

/**
 * Reads the effective per-project concurrency budget from settings.
 * Exported for the scheduler default wiring and for tests.
 */
export function resolveMaxConcurrentForProject(projectId: string): number {
  for (const key of [
    agentMaxConcurrentSettingKey(projectId),
    AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
  ]) {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();

    const parsed = row ? parseMaxConcurrentSetting(row.value) : null;
    if (parsed !== null) return parsed;
  }

  return DEFAULT_MAX_CONCURRENT_AGENTS;
}

export interface AgentSchedulerOptions {
  /** Injectable budget resolver (tests); defaults to the settings lookup. */
  getMaxConcurrent?: (projectId: string) => number;
}

export class AgentScheduler {
  private readonly states = new Map<string, ProjectSchedulerState>();
  private readonly getMaxConcurrent: (projectId: string) => number;

  constructor(options: AgentSchedulerOptions = {}) {
    this.getMaxConcurrent =
      options.getMaxConcurrent ?? resolveMaxConcurrentForProject;
  }

  /**
   * Submits a session launch. Starts it synchronously when the project has
   * a free slot (so immediate dispatches behave exactly like the historical
   * inline spawn), otherwise appends it to the project's FIFO queue.
   *
   * The launch closure owns the whole session lifetime: it must call
   * `markSessionRunning`, spawn the CLI, wait for completion, and finalize
   * the session row. Its settled promise — resolved or rejected — frees the
   * slot. Errors it throws never propagate to the submitter; they surface
   * on the session row (see `handleLaunchFailure`).
   */
  submit(
    projectId: string,
    sessionId: string,
    launch: () => Promise<void>
  ): SubmitResult {
    const state = this.stateFor(projectId);

    if (
      state.running.has(sessionId) ||
      state.queue.some((entry) => entry.sessionId === sessionId)
    ) {
      throw new Error(`Session ${sessionId} is already scheduled`);
    }

    // A budget below 1 is impossible (0 resolves to unlimited), so an idle
    // project always starts immediately — without paying a settings read.
    if (
      state.running.size === 0 ||
      state.running.size < this.effectiveLimit(projectId)
    ) {
      this.start(projectId, state, { sessionId, launch });
      return { started: true, queuedAhead: 0 };
    }

    state.queue.push({ sessionId, launch });
    return { started: false, queuedAhead: state.queue.length - 1 };
  }

  /**
   * Removes a not-yet-started session from the queue (e.g. cancelled by the
   * user while waiting). Returns false when the session is not queued —
   * already started, already finished, or never submitted.
   */
  remove(sessionId: string): boolean {
    for (const [projectId, state] of this.states) {
      const index = state.queue.findIndex(
        (entry) => entry.sessionId === sessionId
      );
      if (index !== -1) {
        state.queue.splice(index, 1);
        this.cleanup(projectId, state);
        return true;
      }
    }
    return false;
  }

  /** Introspection: live counts for one project (for monitors/tests). */
  getCounts(projectId: string): { running: number; queued: number } {
    const state = this.states.get(projectId);
    return {
      running: state?.running.size ?? 0,
      queued: state?.queue.length ?? 0,
    };
  }

  /** Introspection: live counts for every project with scheduler state. */
  listCounts(): SchedulerProjectCounts[] {
    return Array.from(this.states.entries()).map(([projectId, state]) => ({
      projectId,
      running: state.running.size,
      queued: state.queue.length,
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private stateFor(projectId: string): ProjectSchedulerState {
    let state = this.states.get(projectId);
    if (!state) {
      state = { running: new Set(), queue: [] };
      this.states.set(projectId, state);
    }
    return state;
  }

  private effectiveLimit(projectId: string): number {
    try {
      const limit = this.getMaxConcurrent(projectId);
      return isValidMaxConcurrent(limit) ? limit : DEFAULT_MAX_CONCURRENT_AGENTS;
    } catch (error) {
      console.error(
        `[agent-scheduler] Failed to resolve max concurrency for project ${projectId}; using default`,
        error
      );
      return DEFAULT_MAX_CONCURRENT_AGENTS;
    }
  }

  private start(
    projectId: string,
    state: ProjectSchedulerState,
    entry: QueuedLaunch
  ): void {
    state.running.add(entry.sessionId);

    // The async wrapper funnels synchronous throws from `launch()` into the
    // same rejection path as async failures, so a bad spawn can never crash
    // the submitting route or leak the slot.
    void (async () => entry.launch())()
      .catch((error) => this.handleLaunchFailure(entry.sessionId, error))
      .finally(() => this.release(projectId, entry.sessionId));
  }

  /**
   * Safety net for launch closures that reject: without it the session row
   * would sit 'queued'/'running' forever. Lifecycle conflicts are expected
   * noise (the session was cancelled while queued, or the closure already
   * finalized the row before failing) and stay silent.
   */
  private handleLaunchFailure(sessionId: string, error: unknown): void {
    if (
      isSessionLifecycleConflictError(error) ||
      isSessionNotFoundError(error)
    ) {
      return;
    }

    console.error(
      `[agent-scheduler] Launch for session ${sessionId} failed`,
      error
    );

    let markedTerminalHere = false;
    try {
      markSessionTerminal(sessionId, {
        success: false,
        error: error instanceof Error ? error.message : "Agent launch failed",
      });
      markedTerminalHere = true;
    } catch (finalizeError) {
      if (
        !isSessionLifecycleConflictError(finalizeError) &&
        !isSessionNotFoundError(finalizeError)
      ) {
        console.error(
          `[agent-scheduler] Failed to finalize crashed session ${sessionId}`,
          finalizeError
        );
      }
    }

    // Board effect: the owning-session exemption can leave a code-producing
    // session's ticket in Review while the session is live. A launch that
    // never settles means no in-process terminal handler will undo that
    // promotion, so the safety net does — the same pullback the boot sweep
    // performs for restart orphans. No-op unless the ticket is actually in
    // Review; a ticket-less row (team builds) has nothing to address.
    //
    // Only a session this net finalized itself can have an unsettled board.
    // If the row was already terminal, the closure owned every board effect
    // — including a legitimate Review promotion — before it threw on the
    // way out; reverting then would strand delivered work in in_progress
    // and hand it back to Full Auto's build selector. A lifecycle conflict
    // from markSessionTerminal is exactly that signal, so no pullback.
    if (!markedTerminalHere) return;
    try {
      const row = db
        .select({
          projectId: agentSessions.projectId,
          epicId: agentSessions.epicId,
          userStoryId: agentSessions.userStoryId,
          agentType: agentSessions.agentType,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get();
      if (row?.epicId && isCodeProducingAgentType(row.agentType)) {
        pullTicketBackIfPromoted({
          projectId: row.projectId,
          epicId: row.epicId,
          scope: row.userStoryId ? "story" : "epic",
          userStoryId: row.userStoryId,
          sessionId,
          reason: "Build session launch failed; returning ticket to in_progress",
        });
      }
    } catch (pullbackError) {
      console.error(
        `[agent-scheduler] Failed to pull back ticket of crashed session ${sessionId}`,
        pullbackError
      );
    }
  }

  private release(projectId: string, sessionId: string): void {
    const state = this.states.get(projectId);
    if (!state) return;

    state.running.delete(sessionId);

    // Re-read the budget on every drain so setting changes take effect on
    // the next slot. `while` (not `if`) copes with a raised limit.
    while (
      state.queue.length > 0 &&
      state.running.size < this.effectiveLimit(projectId)
    ) {
      const next = state.queue.shift()!;
      this.start(projectId, state, next);
    }

    this.cleanup(projectId, state);
  }

  private cleanup(projectId: string, state: ProjectSchedulerState): void {
    if (state.running.size === 0 && state.queue.length === 0) {
      this.states.delete(projectId);
    }
  }
}

/**
 * globalThis-backed singleton (same pattern as the watchdog): module scope
 * is re-evaluated on a dev hot reload, and a fresh scheduler there would
 * start with an empty running-set while the previous instance still holds
 * live launch closures — the budget would silently double. globalThis
 * survives the reload, so every module generation shares one queue.
 */
const SCHEDULER_GLOBAL_KEY = Symbol.for("arij.agent-scheduler");

type SchedulerGlobal = { [SCHEDULER_GLOBAL_KEY]?: AgentScheduler };

export function getAgentScheduler(): AgentScheduler {
  const store = globalThis as SchedulerGlobal;
  if (!store[SCHEDULER_GLOBAL_KEY]) {
    store[SCHEDULER_GLOBAL_KEY] = new AgentScheduler();
  }
  return store[SCHEDULER_GLOBAL_KEY];
}

/**
 * Singleton scheduler instance. Production code must use this; the class is
 * exported for unit tests that need isolated instances.
 */
export const agentScheduler = getAgentScheduler();
