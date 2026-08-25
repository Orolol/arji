import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { routines, type Routine } from "@/lib/db/schema";
import { createRoutineRunNotification } from "@/lib/notifications/create";
import {
  executeRoutineAction,
  type RoutineActionResult,
} from "@/lib/routines/actions";
import { DEFAULT_CI_WATCH_INTERVAL_MINUTES } from "@/lib/routines/ci-watch";

export const ROUTINE_SWEEP_INTERVAL_MS = 60_000;

const DAILY_KINDS = new Set<Routine["kind"]>([
  "night_run",
  "github_issue_sync",
]);
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Calendar comparison deliberately uses the server's local timezone. */
export function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Pure dueness decision. Daily routines compare local calendar days; CI watch
 * compares its minute interval. `lastRunAt` is durable, so a new scheduler
 * instance after a server restart reaches the same answer as the old one.
 */
export function isRoutineDue(
  routine: Routine,
  now: Date = new Date(),
): boolean {
  if (!routine.enabled) return false;

  if (routine.kind === "ci_watch") {
    let intervalMinutes = DEFAULT_CI_WATCH_INTERVAL_MINUTES;
    try {
      const config = JSON.parse(routine.config) as {
        intervalMinutes?: unknown;
      };
      if (
        Number.isInteger(config?.intervalMinutes) &&
        (config.intervalMinutes as number) > 0
      ) {
        intervalMinutes = config.intervalMinutes as number;
      }
    } catch {
      // Let the action report malformed config after the default interval.
    }

    if (!routine.lastRunAt) return true;
    const lastRunAt = new Date(routine.lastRunAt);
    if (Number.isNaN(lastRunAt.getTime())) return true;
    return now.getTime() - lastRunAt.getTime() >= intervalMinutes * 60_000;
  }

  if (!DAILY_KINDS.has(routine.kind)) return false;
  if (!TIME_OF_DAY_PATTERN.test(routine.timeOfDay)) return false;

  const [hours, minutes] = routine.timeOfDay.split(":").map(Number);
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  if (currentMinute < hours * 60 + minutes) return false;

  if (routine.lastRunAt) {
    const lastRunAt = new Date(routine.lastRunAt);
    if (!Number.isNaN(lastRunAt.getTime()) && isSameLocalDay(lastRunAt, now)) {
      return false;
    }
  }

  return true;
}

export interface RoutineSchedulerDeps {
  listEnabledRoutines(): Routine[];
  markStarted(routineId: string, startedAt: string): void;
  markFinished(routineId: string, status: Routine["lastStatus"]): void;
  execute(routine: Routine): Promise<RoutineActionResult>;
  notify(input: {
    projectId: string;
    kind: Routine["kind"];
    status: "completed" | "skipped" | "failed";
    message: string;
    targetUrl: string;
  }): void;
}

export const defaultRoutineSchedulerDeps: RoutineSchedulerDeps = {
  listEnabledRoutines: () =>
    db.select().from(routines).where(eq(routines.enabled, true)).all(),
  markStarted: (routineId, startedAt) => {
    db.update(routines)
      .set({ lastRunAt: startedAt, lastStatus: "running" })
      .where(eq(routines.id, routineId))
      .run();
  },
  markFinished: (routineId, status) => {
    db.update(routines)
      .set({ lastStatus: status })
      .where(eq(routines.id, routineId))
      .run();
  },
  execute: executeRoutineAction,
  notify: createRoutineRunNotification,
};

export interface InterruptedRoutineRecoveryDeps {
  listInterruptedRoutines(): Routine[];
  markFailed(routineId: string): void;
  notify(input: {
    projectId: string;
    kind: Routine["kind"];
    status: "failed";
    message: string;
    targetUrl: string;
  }): void;
}

const defaultInterruptedRoutineRecoveryDeps: InterruptedRoutineRecoveryDeps = {
  listInterruptedRoutines: () =>
    db.select().from(routines).where(eq(routines.lastStatus, "running")).all(),
  markFailed: (routineId) => {
    db.update(routines)
      .set({ lastStatus: "failed" })
      .where(eq(routines.id, routineId))
      .run();
  },
  notify: createRoutineRunNotification,
};

/**
 * A process restart loses every in-flight action. Reconcile its durable
 * `running` claim once at boot so the settings UI and audit signal describe
 * the interrupted terminal outcome instead of remaining stuck forever.
 */
export function recoverInterruptedRoutineRuns(
  deps: InterruptedRoutineRecoveryDeps = defaultInterruptedRoutineRecoveryDeps,
): number {
  const interrupted = deps.listInterruptedRoutines();
  let recovered = 0;

  for (const routine of interrupted) {
    try {
      deps.markFailed(routine.id);
      recovered += 1;
    } catch (error) {
      console.error(
        `[routines] Failed to reconcile interrupted routine ${routine.id}`,
        error,
      );
      continue;
    }

    try {
      deps.notify({
        projectId: routine.projectId,
        kind: routine.kind,
        status: "failed",
        message: "Routine execution was interrupted by a server restart.",
        targetUrl: `/projects/${routine.projectId}`,
      });
    } catch (error) {
      console.error(
        `[routines] Failed to notify interrupted routine ${routine.id}`,
        error,
      );
    }
  }

  return recovered;
}

export interface RoutineSweepResult {
  routineId: string;
  status: "completed" | "skipped" | "failed";
  message: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Routine execution failed";
}

/**
 * One scheduler instance owns an in-memory claim set. Production stores the
 * instance itself on globalThis, so hot reload cannot create a second set and
 * overlap a still-running trigger. The DB claim (`lastRunAt`) covers restart.
 */
export class RoutineScheduler {
  private readonly runningRoutineIds = new Set<string>();

  constructor(
    private readonly deps: RoutineSchedulerDeps = defaultRoutineSchedulerDeps,
  ) {}

  async sweep(now: Date = new Date()): Promise<RoutineSweepResult[]> {
    let candidates: Routine[];
    try {
      candidates = this.deps.listEnabledRoutines();
    } catch (error) {
      console.error("[routines] Failed to list routines", error);
      return [];
    }

    return Promise.all(
      candidates
        .filter((routine) => isRoutineDue(routine, now))
        .map((routine) => this.run(routine, now)),
    );
  }

  isRunning(routineId: string): boolean {
    return this.runningRoutineIds.has(routineId);
  }

  private async run(routine: Routine, now: Date): Promise<RoutineSweepResult> {
    // A second interval can fire while a slow GitHub request is still in
    // flight. The durable timestamp also stops it, but this guard closes the
    // window for concurrent sweeps that loaded candidates before the claim.
    if (this.runningRoutineIds.has(routine.id)) {
      return {
        routineId: routine.id,
        status: "skipped",
        message: "Routine is already running.",
      };
    }

    this.runningRoutineIds.add(routine.id);
    let claimed = false;
    try {
      const startedAt = now.toISOString();
      this.deps.markStarted(routine.id, startedAt);
      claimed = true;
      console.info(
        `[routines] Triggering ${routine.kind} routine ${routine.id} for project ${routine.projectId}`,
      );

      const result = await this.deps.execute({
        ...routine,
        lastRunAt: startedAt,
        lastStatus: "running",
      });
      this.deps.markFinished(routine.id, result.status);
      if (result.shouldNotify !== false) {
        this.notifySafely(routine, {
          ...result,
          status: result.status,
        });
      }
      return {
        routineId: routine.id,
        status: result.status,
        message: result.message,
      };
    } catch (error) {
      const message = errorMessage(error);
      if (claimed) {
        try {
          this.deps.markFinished(routine.id, "failed");
        } catch (persistError) {
          console.error(
            `[routines] Failed to persist failure for routine ${routine.id}`,
            persistError,
          );
        }
      }
      this.notifySafely(routine, {
        status: "failed",
        message,
        targetUrl: `/projects/${routine.projectId}`,
      });
      console.error(`[routines] Routine ${routine.id} failed`, error);
      return { routineId: routine.id, status: "failed", message };
    } finally {
      this.runningRoutineIds.delete(routine.id);
    }
  }

  private notifySafely(
    routine: Routine,
    result:
      | RoutineActionResult
      | {
          status: "failed";
          message: string;
          targetUrl: string;
        },
  ): void {
    try {
      this.deps.notify({
        projectId: routine.projectId,
        kind: routine.kind,
        status: result.status,
        message: result.message,
        targetUrl: result.targetUrl,
      });
    } catch (error) {
      console.error(
        `[routines] Failed to create notification for routine ${routine.id}`,
        error,
      );
    }
  }
}

const ROUTINE_SCHEDULER_GLOBAL_KEY = Symbol.for("arij.routine-scheduler");

interface RoutineSchedulerSlot {
  scheduler: RoutineScheduler;
  timer: ReturnType<typeof setInterval> | null;
  recoveredInterruptedRuns: boolean;
}

type RoutineSchedulerGlobal = {
  [ROUTINE_SCHEDULER_GLOBAL_KEY]?: RoutineSchedulerSlot;
};

function schedulerSlot(): RoutineSchedulerSlot {
  const store = globalThis as RoutineSchedulerGlobal;
  if (!store[ROUTINE_SCHEDULER_GLOBAL_KEY]) {
    store[ROUTINE_SCHEDULER_GLOBAL_KEY] = {
      scheduler: new RoutineScheduler(),
      timer: null,
      recoveredInterruptedRuns: false,
    };
  }
  return store[ROUTINE_SCHEDULER_GLOBAL_KEY];
}

export function getRoutineScheduler(): RoutineScheduler {
  return schedulerSlot().scheduler;
}

/** Boot entry point. Idempotent across instrumentation/hot reloads. */
export function startRoutineScheduler(): void {
  const slot = schedulerSlot();
  if (slot.timer) return;

  if (!slot.recoveredInterruptedRuns) {
    slot.recoveredInterruptedRuns = true;
    try {
      recoverInterruptedRoutineRuns();
    } catch (error) {
      // A boot cleanup failure must not disable all future routine sweeps.
      console.error("[routines] Failed to reconcile interrupted runs", error);
    }
  }

  slot.timer = setInterval(() => {
    void slot.scheduler.sweep().catch((error) => {
      console.error("[routines] Sweep failed", error);
    });
  }, ROUTINE_SWEEP_INTERVAL_MS);
  slot.timer.unref?.();
}

export function stopRoutineScheduler(): void {
  const slot = schedulerSlot();
  if (!slot.timer) return;
  clearInterval(slot.timer);
  slot.timer = null;
}

export function isRoutineSchedulerRunning(): boolean {
  return schedulerSlot().timer !== null;
}
