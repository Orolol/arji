/**
 * Boot wiring for Full Auto Mode (instrumentation.ts).
 *
 * `setSessionTerminalHook` holds exactly ONE callback, so the regression this
 * suite guards is a composition bug: registering the auto-mode kick must not
 * silently detach the memory auto-distillation trigger that already lived
 * there (nor the other way round).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const bootMocks = vi.hoisted(() => ({
  ensureDbReady: vi.fn(),
  cancelOrphanedQueuedSessions: vi.fn(),
  failOrphanedRunningSessions: vi.fn(),
  reconcileStrandedQaReports: vi.fn(),
  startSessionWatchdog: vi.fn(),
  startAutoMode: vi.fn(),
  startRoutineScheduler: vi.fn(),
  kickAutoModeForSession: vi.fn(),
  maybeAutoDistillAfterSessionTerminal: vi.fn(async () => {}),
  createTerminalSessionNotification: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  ensureDbReady: bootMocks.ensureDbReady,
  db: {},
  sqlite: {},
}));

vi.mock("@/lib/agent-sessions/boot-cleanup", () => ({
  cancelOrphanedQueuedSessions: bootMocks.cancelOrphanedQueuedSessions,
  failOrphanedRunningSessions: bootMocks.failOrphanedRunningSessions,
}));

vi.mock("@/lib/qa/boot-cleanup", () => ({
  reconcileStrandedQaReports: bootMocks.reconcileStrandedQaReports,
}));

vi.mock("@/lib/agents/watchdog", () => ({
  startSessionWatchdog: bootMocks.startSessionWatchdog,
}));

vi.mock("@/lib/auto-mode/engine", () => ({
  startAutoMode: bootMocks.startAutoMode,
  kickAutoModeForSession: bootMocks.kickAutoModeForSession,
}));

vi.mock("@/lib/routines/scheduler", () => ({
  startRoutineScheduler: bootMocks.startRoutineScheduler,
}));

vi.mock("@/lib/workflow/memory-distill", () => ({
  maybeAutoDistillAfterSessionTerminal:
    bootMocks.maybeAutoDistillAfterSessionTerminal,
}));

vi.mock("@/lib/agent-sessions/terminal-notification", () => ({
  createTerminalSessionNotification:
    bootMocks.createTerminalSessionNotification,
}));

const { register } = await import("@/instrumentation");
const { notifySessionTerminal, setSessionTerminalHook } = await import(
  "@/lib/agent-sessions/terminal-hooks"
);

beforeEach(() => {
  vi.clearAllMocks();
  setSessionTerminalHook(null);
  process.env.NEXT_RUNTIME = "nodejs";
});

describe("register()", () => {
  it("starts the standing loops after boot cleanup", async () => {
    await register();

    expect(bootMocks.ensureDbReady).toHaveBeenCalled();
    expect(bootMocks.cancelOrphanedQueuedSessions).toHaveBeenCalled();
    expect(bootMocks.failOrphanedRunningSessions).toHaveBeenCalled();
    // The QA report reconciliation reads the session to decide whether a
    // report still on 'running' is live, so it must run AFTER the sweep that
    // makes the previous process's sessions terminal — never before.
    expect(bootMocks.reconcileStrandedQaReports).toHaveBeenCalledTimes(1);
    expect(
      bootMocks.reconcileStrandedQaReports.mock.invocationCallOrder[0]
    ).toBeGreaterThan(
      bootMocks.failOrphanedRunningSessions.mock.invocationCallOrder[0]
    );
    expect(bootMocks.startSessionWatchdog).toHaveBeenCalledTimes(1);
    expect(bootMocks.startAutoMode).toHaveBeenCalledTimes(1);
    expect(bootMocks.startRoutineScheduler).toHaveBeenCalledTimes(1);
  });

  it("registers ONE hook that runs both the auto-mode kick and auto-distill", async () => {
    await register();

    notifySessionTerminal({ sessionId: "s1", status: "completed" });

    expect(bootMocks.kickAutoModeForSession).toHaveBeenCalledWith("s1");
    expect(bootMocks.maybeAutoDistillAfterSessionTerminal).toHaveBeenCalledWith(
      "s1"
    );
  });

  it("kicks the supervisor for failed and cancelled sessions too, but never distills them", async () => {
    await register();

    notifySessionTerminal({ sessionId: "s-failed", status: "failed" });
    notifySessionTerminal({ sessionId: "s-cancelled", status: "cancelled" });

    expect(bootMocks.kickAutoModeForSession).toHaveBeenCalledWith("s-failed");
    expect(bootMocks.kickAutoModeForSession).toHaveBeenCalledWith("s-cancelled");
    expect(
      bootMocks.maybeAutoDistillAfterSessionTerminal
    ).not.toHaveBeenCalled();
  });

  it("does nothing outside the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(bootMocks.startAutoMode).not.toHaveBeenCalled();
    expect(bootMocks.startRoutineScheduler).not.toHaveBeenCalled();
    expect(bootMocks.reconcileStrandedQaReports).not.toHaveBeenCalled();
    process.env.NEXT_RUNTIME = "nodejs";
  });
});
