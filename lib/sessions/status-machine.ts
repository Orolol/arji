/**
 * Session status state machine.
 *
 * Enforces valid transitions between session states to prevent
 * inconsistent data in the DB and in-memory process manager.
 */

export type SessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Allowed status transitions. Each key is a source status, and the value
 * is the set of valid target statuses it can move to.
 */
const VALID_TRANSITIONS: Record<SessionStatus, Set<SessionStatus>> = {
  pending: new Set(["running", "cancelled", "failed"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(), // terminal
  failed: new Set(),    // terminal
  cancelled: new Set(), // terminal
};

/**
 * Returns true if transitioning from `from` to `to` is a valid status change.
 */
export function isValidTransition(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Asserts a valid transition; throws if invalid.
 * Returns the target status for convenience.
 */
export function assertValidTransition(
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
): SessionStatus {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid session status transition for ${sessionId}: ${from} -> ${to}`,
    );
  }
  return to;
}

/**
 * Returns true if the given status is terminal (no further transitions allowed).
 */
export function isTerminalStatus(status: SessionStatus): boolean {
  return VALID_TRANSITIONS[status]?.size === 0;
}
