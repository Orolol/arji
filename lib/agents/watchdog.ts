import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, epics, settings } from "@/lib/db/schema";
import { lastSessionChunkAt } from "@/lib/agent-sessions/chunks";
import {
  latestActivityTimestamp,
  parseStoredTimestamp,
} from "@/lib/agent-sessions/last-activity";
import { createStalledSessionNotification } from "@/lib/notifications/create";
import { logTransition } from "@/lib/workflow/log";
import {
  DEFAULT_WATCHDOG_THRESHOLD_MINUTES,
  WATCHDOG_THRESHOLD_GLOBAL_SETTING_KEY,
  isWatchdogExemptAgentType,
  parseWatchdogThresholdMinutes,
  watchdogThresholdSettingKey,
} from "@/lib/agents/watchdog-constants";

/**
 * Silent-session watchdog: detects running agents that stopped producing
 * output.
 *
 * The monitor shows elapsed time, but elapsed time alone can't distinguish
 * "thinking hard" from "hung CLI". Every sweep (~30s) the watchdog compares
 * now against each RUNNING session's last activity — the newest chunk
 * `createdAt` (lib/agent-sessions/chunks.ts `lastSessionChunkAt`), falling
 * back to `startedAt` for sessions that never emitted a chunk. A session
 * whose silence crosses its threshold gets, exactly once:
 *
 *   1. a notification ("Agent seems stalled on <ticket> — no output for
 *      Xm") deep-linking to the session detail, and
 *   2. a ticketActivityLog entry (actor 'system', from == to) when the
 *      session is epic-scoped, so the stall is auditable from the ticket.
 *
 * The watchdog never auto-kills — stopping a stalled agent stays a human
 * decision (the monitor and session detail expose cancel).
 *
 * Threshold resolution per agent type (first hit wins):
 *   1. settings key `watchdog_threshold_minutes:<agentType>`
 *   2. settings key `watchdog_threshold_minutes` (global default)
 *   3. DEFAULT_WATCHDOG_THRESHOLD_MINUTES (5)
 * Chat sessions are exempt (see WATCHDOG_EXEMPT_AGENT_TYPES). Thresholds
 * are re-read on every sweep, so setting changes apply without a restart.
 *
 * Like the scheduler and process manager, the watchdog is a per-process
 * singleton — but its interval must survive dev hot reloads without
 * doubling, so the instance is stashed on `globalThis` (module scope is
 * re-evaluated on reload; globalThis is not).
 */

export const WATCHDOG_SWEEP_INTERVAL_MS = 30_000;

/** Activity-log reason for a stall hold entry (from == to, actor system). */
export function buildStalledReason(staleMinutes: number): string {
  return `Agent seems stalled — no output for ${staleMinutes}m`;
}

/**
 * Reads the effective staleness threshold (minutes) for an agent type from
 * settings. Exported for the active-sessions route and for tests.
 */
export function resolveWatchdogThresholdMinutes(
  agentType: string | null | undefined
): number {
  const keys = agentType
    ? [
        watchdogThresholdSettingKey(agentType),
        WATCHDOG_THRESHOLD_GLOBAL_SETTING_KEY,
      ]
    : [WATCHDOG_THRESHOLD_GLOBAL_SETTING_KEY];

  for (const key of keys) {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();

    const parsed = row ? parseWatchdogThresholdMinutes(row.value) : null;
    if (parsed !== null) return parsed;
  }

  return DEFAULT_WATCHDOG_THRESHOLD_MINUTES;
}

/**
 * Last known activity for a session across output and lifecycle changes.
 * Once a terminal timestamp exists, it bounds all legitimate output, so
 * historical sessions avoid a chunk lookup entirely. Live/legacy sessions
 * use the indexed per-session chunk lookup on a best-effort basis: a broken
 * chunk store must not take the monitor or sessions list down.
 */
export function getSessionLastActivityAt(session: {
  id: string;
  status?: string | null;
  startedAt: string | null;
  endedAt?: string | null;
  completedAt?: string | null;
  createdAt: string | null;
}): string | null {
  const terminalActivityAt = latestActivityTimestamp(
    session.endedAt,
    session.completedAt
  );
  let lastChunkAt: string | null = null;
  if (!terminalActivityAt && session.status !== "queued") {
    try {
      lastChunkAt = lastSessionChunkAt(session.id);
    } catch {
      // chunk store unavailable — fall back to lifecycle timestamps
    }
  }

  return latestActivityTimestamp(
    session.createdAt,
    session.startedAt,
    terminalActivityAt,
    lastChunkAt
  );
}

/**
 * Whether a running session's silence has crossed its threshold. Shared by
 * the watchdog sweep and the active-sessions endpoint so the amber monitor
 * state and the stall notification can never disagree.
 */
export function isSessionStale(
  lastActivityAt: string | null,
  agentType: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!lastActivityAt) return false;
  if (isWatchdogExemptAgentType(agentType)) return false;

  const last = parseStoredTimestamp(lastActivityAt);
  if (last === null) return false;

  const thresholdMs = resolveWatchdogThresholdMinutes(agentType) * 60_000;
  return now.getTime() - last >= thresholdMs;
}

/** One stalled session flagged by a sweep (returned for tests/logging). */
export interface StalledSessionNotice {
  sessionId: string;
  projectId: string;
  epicId: string | null;
  staleMinutes: number;
}

export class SessionWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Sessions already notified — a session stalls loudly at most once. */
  private readonly notifiedSessionIds = new Set<string>();

  /** Idempotent: a second start() while running is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        console.error("[watchdog] Sweep failed", error);
      }
    }, WATCHDOG_SWEEP_INTERVAL_MS);
    // Never keep the process alive just to watch for stalls.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Whether a session has already received its stall notification. */
  hasNotified(sessionId: string): boolean {
    return this.notifiedSessionIds.has(sessionId);
  }

  /**
   * One detection pass over all RUNNING sessions. Exposed for tests (fake
   * timers drive it via start(); direct calls skip the interval).
   */
  sweep(now: Date = new Date()): StalledSessionNotice[] {
    const rows = db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        epicId: agentSessions.epicId,
        agentType: agentSessions.agentType,
        startedAt: agentSessions.startedAt,
        createdAt: agentSessions.createdAt,
        epicStatus: epics.status,
      })
      .from(agentSessions)
      .leftJoin(epics, eq(agentSessions.epicId, epics.id))
      .where(eq(agentSessions.status, "running"))
      .all();

    // Sessions that left 'running' can never re-enter it (terminal states
    // are final), so pruning here both bounds the set and keeps the
    // at-most-once guarantee intact for sessions still running.
    const runningIds = new Set(rows.map((row) => row.id));
    for (const notified of this.notifiedSessionIds) {
      if (!runningIds.has(notified)) {
        this.notifiedSessionIds.delete(notified);
      }
    }

    const flagged: StalledSessionNotice[] = [];

    for (const row of rows) {
      if (isWatchdogExemptAgentType(row.agentType)) continue;
      if (this.notifiedSessionIds.has(row.id)) continue;

      const lastActivityAt = getSessionLastActivityAt(row);
      if (!isSessionStale(lastActivityAt, row.agentType, now)) continue;

      const lastActivityMs = parseStoredTimestamp(lastActivityAt!);
      if (lastActivityMs === null) continue;
      const staleMinutes = Math.floor(
        (now.getTime() - lastActivityMs) / 60_000
      );

      this.notifiedSessionIds.add(row.id);

      try {
        createStalledSessionNotification(row.id, staleMinutes);
      } catch (error) {
        console.warn(
          "[watchdog] Failed to create stalled notification:",
          (error as Error).message
        );
      }

      if (row.epicId) {
        // logTransition is itself best-effort (catches internally). A
        // from == to entry: the observation that work is NOT advancing.
        const heldStatus = row.epicStatus ?? "in_progress";
        logTransition({
          projectId: row.projectId,
          epicId: row.epicId,
          fromStatus: heldStatus,
          toStatus: heldStatus,
          actor: "system",
          reason: buildStalledReason(staleMinutes),
          sessionId: row.id,
        });
      }

      flagged.push({
        sessionId: row.id,
        projectId: row.projectId,
        epicId: row.epicId ?? null,
        staleMinutes,
      });
    }

    return flagged;
  }
}

/**
 * globalThis-backed singleton: dev hot reloads re-evaluate this module but
 * must reuse the already-ticking watchdog instead of stacking intervals.
 */
const WATCHDOG_GLOBAL_KEY = Symbol.for("arij.session-watchdog");

type WatchdogGlobal = { [WATCHDOG_GLOBAL_KEY]?: SessionWatchdog };

export function getSessionWatchdog(): SessionWatchdog {
  const store = globalThis as WatchdogGlobal;
  if (!store[WATCHDOG_GLOBAL_KEY]) {
    store[WATCHDOG_GLOBAL_KEY] = new SessionWatchdog();
  }
  return store[WATCHDOG_GLOBAL_KEY];
}

/** Boot entry point (instrumentation.ts). Safe to call repeatedly. */
export function startSessionWatchdog(): SessionWatchdog {
  const watchdog = getSessionWatchdog();
  watchdog.start();
  return watchdog;
}
