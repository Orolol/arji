/**
 * Failed-session terminal notification — the missing half of the failure
 * story.
 *
 * Dispatch routes notify through emitSessionFailed/emitSessionCompleted
 * inside their launch closures, but a closure can die before reaching that
 * line: the scheduler's launch safety net, the boot cleanup that fails
 * orphaned running sessions, the pipeline/night/auto-mode engines — all of
 * them finalize the session through transitionSessionStatus (marking it
 * failed, with a full error message since
 * lib/agent-sessions/failure-message.ts) and then stop. The session row
 * says "failed", nothing else did.
 *
 * So the terminal hook (registered in instrumentation.ts) creates the
 * notification the moment the row is finalized. The routes' own
 * emitSessionFailed call lands on the idempotency guard in
 * createNotificationFromSession and no-ops, which is what makes "hook +
 * route" safe to compose without duplicates.
 *
 * Only FAILED transitions create one here: completed sessions are already
 * notified by the routes, and asking-question runs must not get a generic
 * "completed" notification before the route classifies their outcome (the
 * question notification is owned by
 * createAskedQuestionNotificationFromSession).
 */
import { createNotificationFromSession } from "@/lib/notifications/create";
import type { SessionTerminalEvent } from "./terminal-hooks";

export function createTerminalSessionNotification(
  event: SessionTerminalEvent
): void {
  if (event.status !== "failed") return;
  try {
    createNotificationFromSession(event.sessionId);
  } catch (err) {
    // A broken notification must never break the terminal transition.
    console.warn(
      "[terminal-notification] Failed to notify session failure",
      event.sessionId,
      err instanceof Error ? err.message : err
    );
  }
}