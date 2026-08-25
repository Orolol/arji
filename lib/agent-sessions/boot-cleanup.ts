import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { isCodeProducingAgentType } from "@/lib/agent-config/constants";
import {
  isSessionLifecycleConflictError,
  markSessionCancelled,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { pullTicketBackIfPromoted } from "@/lib/workflow/automatic-transitions";

/**
 * Reason string persisted on sessions cancelled by the boot sweep.
 * Surfaced verbatim in the sessions UI, so keep it human-readable.
 */
export const ORPHANED_BY_RESTART_REASON = "orphaned by restart";

/**
 * Once-per-process guard, globalThis-backed like the watchdog's double-start
 * guard (module scope is re-evaluated on a dev hot reload; globalThis is
 * not). Next.js can re-run `register()` in the same process — a second sweep
 * would then see sessions legitimately queued/running by live requests and
 * cancel them as "orphaned by restart". Only the FIRST sweep of a process
 * sees a provably orphaned table.
 */
const BOOT_CLEANUP_GLOBAL_KEY = Symbol.for("arij.boot-cleanup");

interface BootCleanupState {
  queuedSwept: boolean;
  runningSwept: boolean;
}

type BootCleanupGlobal = { [BOOT_CLEANUP_GLOBAL_KEY]?: BootCleanupState };

function bootCleanupState(): BootCleanupState {
  const store = globalThis as BootCleanupGlobal;
  if (!store[BOOT_CLEANUP_GLOBAL_KEY]) {
    store[BOOT_CLEANUP_GLOBAL_KEY] = {
      queuedSwept: false,
      runningSwept: false,
    };
  }
  return store[BOOT_CLEANUP_GLOBAL_KEY];
}

/** Test seam: forget that this process already swept. */
export function resetBootCleanupGuard(): void {
  (globalThis as BootCleanupGlobal)[BOOT_CLEANUP_GLOBAL_KEY] = {
    queuedSwept: false,
    runningSwept: false,
  };
}

/**
 * Cancels agent sessions left in 'queued' by a dead server process.
 *
 * Queued sessions only exist as launch closures inside the in-process
 * agent scheduler (lib/agents/scheduler.ts); when the process dies, those
 * closures die with it and the DB rows can never start. This sweep runs at
 * boot — from instrumentation.ts, right after the database is ready and
 * before any request can enqueue new work — so every 'queued' row it sees
 * is provably orphaned.
 *
 * Uses the lifecycle transition functions (queued -> cancelled is a legal
 * transition), never raw status updates. Returns the number of sessions
 * cancelled — 0 on every call after the first in a process (see
 * `resetBootCleanupGuard`).
 */
export function cancelOrphanedQueuedSessions(): number {
  const state = bootCleanupState();
  if (state.queuedSwept) return 0;
  state.queuedSwept = true;

  const orphans = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.status, "queued"))
    .all();

  let cancelled = 0;
  for (const orphan of orphans) {
    try {
      markSessionCancelled(orphan.id, ORPHANED_BY_RESTART_REASON);
      cancelled++;
    } catch (error) {
      // A concurrent transition here would be surprising (we run before any
      // request), but a single bad row must not abort the whole sweep.
      if (!isSessionLifecycleConflictError(error)) {
        console.error(
          `[boot-cleanup] Failed to cancel orphaned session ${orphan.id}`,
          error
        );
      }
    }
  }

  if (cancelled > 0) {
    console.log(
      `[boot-cleanup] Cancelled ${cancelled} queued session(s) orphaned by restart`
    );
  }

  return cancelled;
}

/**
 * Fails agent sessions left in 'running' by a dead server process.
 *
 * CLI children are child processes of the server: when the server dies they
 * die with it, so at boot any 'running' row is provably a zombie — it can
 * never produce chunks again, and the watchdog would flag it as stalled
 * forever. Mark them failed (outcome 'error') so the UI tells the truth.
 *
 * Board effect: a zombie build may have promoted its own ticket to Review
 * before the server died (owning-session exemption). The in-process
 * terminal handler that would normally undo that on failure never ran, so
 * the sweep pulls such a promotion back through pullTicketBackIfPromoted —
 * the fourth terminal path, and the one that fires precisely when the
 * in-process handler could not. Full Auto starts in the same boot and
 * would otherwise pick the orphaned review ticket up as a review candidate.
 *
 * Known trade-off, deliberately accepted: `status = 'running'` cannot
 * distinguish "the handler never ran" from "the handler promoted the
 * ticket but its own lifecycle write failed" (the row then stays
 * `running` while the board is already in Review). In the second case
 * this sweep demotes delivered work; it errs toward `in_progress`
 * because the alternative — trusting an unverifiable promotion — can
 * feed unverified work into Full Auto's merge path.
 *
 * Once per process, like `cancelOrphanedQueuedSessions`: a repeat call would
 * kill sessions started by live requests.
 */
export function failOrphanedRunningSessions(): number {
  const state = bootCleanupState();
  if (state.runningSwept) return 0;
  state.runningSwept = true;

  const zombies = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      agentType: agentSessions.agentType,
    })
    .from(agentSessions)
    .where(eq(agentSessions.status, "running"))
    .all();

  let failed = 0;
  for (const zombie of zombies) {
    try {
      markSessionTerminal(zombie.id, {
        success: false,
        error: ORPHANED_BY_RESTART_REASON,
        outcome: "error",
      });
      failed++;
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error(
          `[boot-cleanup] Failed to mark zombie session ${zombie.id}`,
          error
        );
      }
      // A row that could not be marked terminal here was not marked by
      // anyone else either (nothing else runs at boot) — leave the board
      // untouched and let the next boot retry the whole sweep.
      continue;
    }
    // Pull the zombie's mid-run review promotion back, if any — only for
    // rows this sweep actually finalized. No-op unless the ticket is
    // actually in Review; a code-producing zombie without an epicId
    // (team builds) has nothing to address. One bad row must not abort
    // the sweep, matching the loop's existing style.
    if (zombie.epicId && isCodeProducingAgentType(zombie.agentType)) {
      try {
        pullTicketBackIfPromoted({
          projectId: zombie.projectId,
          epicId: zombie.epicId,
          scope: zombie.userStoryId ? "story" : "epic",
          userStoryId: zombie.userStoryId,
          sessionId: zombie.id,
          reason: `Build session was ${ORPHANED_BY_RESTART_REASON}; returning ticket to in_progress`,
        });
      } catch (error) {
        console.error(
          `[boot-cleanup] Failed to pull back ticket of zombie session ${zombie.id}`,
          error
        );
      }
    }
  }

  if (failed > 0) {
    console.log(
      `[boot-cleanup] Failed ${failed} running session(s) orphaned by restart`
    );
  }

  return failed;
}
