import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Routine } from "@/lib/db/schema";
import {
  ROUTINE_SWEEP_INTERVAL_MS,
  RoutineScheduler,
  isRoutineDue,
  isRoutineSchedulerRunning,
  startRoutineScheduler,
  stopRoutineScheduler,
  type RoutineSchedulerDeps,
} from "@/lib/routines/scheduler";

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    projectId: "project-1",
    kind: "night_run",
    enabled: true,
    timeOfDay: "09:30",
    config: "{}",
    lastRunAt: null,
    lastStatus: null,
    ...overrides,
  };
}

function localDate(
  day: number,
  hours: number,
  minutes: number
): Date {
  return new Date(2026, 7, day, hours, minutes, 0, 0);
}

function schedulerDeps(
  row: Routine,
  execute = vi.fn(async () => ({
    status: "completed" as const,
    message: "launched",
    targetUrl: "/projects/project-1",
  }))
): RoutineSchedulerDeps {
  return {
    listEnabledRoutines: vi.fn(() => [row]),
    markStarted: vi.fn((_id, startedAt) => {
      row.lastRunAt = startedAt;
      row.lastStatus = "running";
    }),
    markFinished: vi.fn((_id, status) => {
      row.lastStatus = status;
    }),
    execute,
    notify: vi.fn(),
  };
}

describe("isRoutineDue", () => {
  it("waits until the configured local server time", () => {
    const row = routine();
    expect(isRoutineDue(row, localDate(25, 9, 29))).toBe(false);
    expect(isRoutineDue(row, localDate(25, 9, 30))).toBe(true);
    expect(isRoutineDue(row, localDate(25, 18, 0))).toBe(true);
  });

  it("does not run twice on the same local calendar day", () => {
    const row = routine({ lastRunAt: localDate(25, 8, 0).toISOString() });
    expect(isRoutineDue(row, localDate(25, 18, 0))).toBe(false);

    row.lastRunAt = localDate(24, 23, 59).toISOString();
    expect(isRoutineDue(row, localDate(25, 18, 0))).toBe(true);
  });

  it("ignores disabled, invalid-time, and not-yet-daily kinds", () => {
    expect(isRoutineDue(routine({ enabled: false }), localDate(25, 12, 0))).toBe(
      false
    );
    expect(
      isRoutineDue(routine({ timeOfDay: "25:00" }), localDate(25, 12, 0))
    ).toBe(false);
    expect(
      isRoutineDue(routine({ kind: "ci_watch" }), localDate(25, 12, 0))
    ).toBe(false);
  });
});

describe("RoutineScheduler", () => {
  it("persists the claim before dispatch and notifies the result", async () => {
    const row = routine();
    const deps = schedulerDeps(row);
    const scheduler = new RoutineScheduler(deps);

    const result = await scheduler.sweep(localDate(25, 9, 30));

    expect(deps.markStarted).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.markFinished).toHaveBeenCalledWith(row.id, "completed");
    expect(deps.notify).toHaveBeenCalledWith({
      projectId: row.projectId,
      kind: "night_run",
      status: "completed",
      message: "launched",
      targetUrl: "/projects/project-1",
    });
    expect(result).toEqual([
      { routineId: row.id, status: "completed", message: "launched" },
    ]);
  });

  it("uses lastRunAt to prevent replay after a server restart", async () => {
    const row = routine();
    const execute = vi.fn(async () => ({
      status: "completed" as const,
      message: "launched",
      targetUrl: "/projects/project-1",
    }));
    const deps = schedulerDeps(row, execute);

    await new RoutineScheduler(deps).sweep(localDate(25, 9, 30));
    // A fresh object models the new process. Only the DB-backed row survives.
    await new RoutineScheduler(deps).sweep(localDate(25, 18, 0));

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent sweeps from launching the same routine twice", async () => {
    const row = routine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return {
        status: "completed" as const,
        message: "launched",
        targetUrl: "/projects/project-1",
      };
    });
    const deps = schedulerDeps(row, execute);
    // Simulate two sweeps that both loaded a stale pre-claim DB snapshot. The
    // in-memory set, rather than lastRunAt, must close this race.
    deps.listEnabledRoutines = vi.fn(() => [routine()]);
    const scheduler = new RoutineScheduler(deps);

    const first = scheduler.sweep(localDate(25, 9, 30));
    expect(scheduler.isRunning(row.id)).toBe(true);
    const second = await scheduler.sweep(localDate(25, 9, 30));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second).toEqual([
      {
        routineId: row.id,
        status: "skipped",
        message: "Routine is already running.",
      },
    ]);

    release();
    await first;
    expect(scheduler.isRunning(row.id)).toBe(false);
  });

  it("records and notifies execution failures", async () => {
    const row = routine({ kind: "github_issue_sync" });
    const deps = schedulerDeps(
      row,
      vi.fn(async () => {
        throw new Error("GitHub unavailable");
      })
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await new RoutineScheduler(deps).sweep(
      localDate(25, 9, 30)
    );

    expect(deps.markFinished).toHaveBeenCalledWith(row.id, "failed");
    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "github_issue_sync",
        status: "failed",
        message: "GitHub unavailable",
      })
    );
    expect(result[0].status).toBe("failed");
    errorSpy.mockRestore();
  });
});

describe("routine timer singleton", () => {
  beforeEach(() => {
    stopRoutineScheduler();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopRoutineScheduler();
    vi.useRealTimers();
  });

  it("starts one unref-compatible one-minute interval", () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    startRoutineScheduler();
    startRoutineScheduler();

    expect(isRoutineSchedulerRunning()).toBe(true);
    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      ROUTINE_SWEEP_INTERVAL_MS
    );
  });
});
