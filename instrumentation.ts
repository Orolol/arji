/**
 * Next.js instrumentation hook — runs once when the server boots
 * (dev and production). Applies pending database migrations and seeds
 * before any request is served, then cancels agent sessions orphaned in
 * 'queued' by the previous process (their scheduler launch closures died
 * with it — see lib/agent-sessions/boot-cleanup.ts).
 *
 * API routes remain safe even if a route module loads before this runs
 * (or in environments that skip instrumentation): lib/db initializes
 * lazily on first use. This hook just front-loads that work to startup.
 *
 * Also starts the three standing loops — the silent-session watchdog
 * (lib/agents/watchdog.ts), Full Auto Mode (lib/auto-mode/engine.ts), and the
 * daily routine scheduler (lib/routines/scheduler.ts). All are globalThis-
 * backed singletons with idempotent starts, so dev hot reloads (which re-run
 * instrumentation) cannot stack a second timer. Full Auto Mode resumes purely
 * from the `auto_mode_enabled:<projectId>` settings keys; daily routines use
 * their durable last_run_at claim to avoid a replay after restart.
 *
 * Finally registers the session terminal hook
 * (lib/agent-sessions/terminal-hooks.ts). That slot holds exactly ONE
 * callback, so the consumers are composed here rather than racing to
 * overwrite each other:
 *   - the memory auto-distillation trigger (lib/workflow/memory-distill.ts),
 *     a no-op unless the 'memory_auto_distill' setting is on,
 *   - the Full Auto Mode kick — a freed slot should be refilled now, not up
 *     to 15s later (the interval sweep stays as the backstop),
 *   - the failed-session notification (lib/agent-sessions/terminal-notification.ts)
 *     — a session that is finalized as failed by a path whose closure dies
 *     first (scheduler safety net, boot cleanup, engines) must still ring
 *     the bell with the full error message, not just sit there labelled
 *     "Agent error".
 * The hook slot is globalThis-backed and registration simply replaces it, so
 * hot reloads are safe here too.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Cap test-runner parallelism in every child this server spawns. Agent
    // sessions run in worktrees snapshotted from main at branch creation, so
    // the maxWorkers cap in vitest.config.ts only reaches worktrees created
    // after it landed; these env vars ride `{ ...process.env }` into every
    // spawn and vitest applies them over whatever the checkout's config says.
    // `??=` keeps a value the operator set when launching the server.
    process.env.VITEST_MAX_FORKS ??= "4";
    process.env.VITEST_MAX_THREADS ??= "4";

    const { ensureDbReady } = await import("@/lib/db");
    ensureDbReady();

    const { cancelOrphanedQueuedSessions, failOrphanedRunningSessions } =
      await import("@/lib/agent-sessions/boot-cleanup");
    cancelOrphanedQueuedSessions();
    failOrphanedRunningSessions();

    const { startSessionWatchdog } = await import("@/lib/agents/watchdog");
    startSessionWatchdog();

    const { startAutoMode, kickAutoModeForSession } = await import(
      "@/lib/auto-mode/engine"
    );
    startAutoMode();

    const { startRoutineScheduler } = await import(
      "@/lib/routines/scheduler"
    );
    startRoutineScheduler();

    const { setSessionTerminalHook } = await import(
      "@/lib/agent-sessions/terminal-hooks"
    );
    const { maybeAutoDistillAfterSessionTerminal } = await import(
      "@/lib/workflow/memory-distill"
    );
    const { createTerminalSessionNotification } = await import(
      "@/lib/agent-sessions/terminal-notification"
    );
    setSessionTerminalHook((event) => {
      // Every terminal status frees a scheduler slot, so the supervisor is
      // kicked regardless of how the session ended.
      kickAutoModeForSession(event.sessionId);

      // A failure finalized outside a live route closure (scheduler safety
      // net, boot cleanup, night/auto-mode engines) is notified here, at
      // the moment the row is finalized. The routes' own emit path hits
      // createNotificationFromSession's per-session idempotency guard.
      createTerminalSessionNotification(event);

      if (event.status !== "completed") return;
      // Fire-and-forget: the trigger owns its guards and never rejects.
      void maybeAutoDistillAfterSessionTerminal(event.sessionId);
    });
  }
}
