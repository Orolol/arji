import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";

export type AgentSessionLifecycleStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const SESSION_LIFECYCLE_CONFLICT_CODE = "INVALID_SESSION_TRANSITION";
export const SESSION_NOT_FOUND_CODE = "SESSION_NOT_FOUND";

type TerminalStatus = Extract<
  AgentSessionLifecycleStatus,
  "completed" | "failed" | "cancelled"
>;

const TERMINAL_STATUSES = new Set<TerminalStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Record<
  AgentSessionLifecycleStatus,
  AgentSessionLifecycleStatus[]
> = {
  queued: ["running"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface SessionLifecycleSnapshot {
  id: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  completedAt: string | null;
}

export interface SessionLifecycleConflictDetails {
  sessionId: string;
  fromStatus: string | null;
  toStatus: AgentSessionLifecycleStatus;
}

export class SessionLifecycleConflictError extends Error {
  readonly code = SESSION_LIFECYCLE_CONFLICT_CODE;
  readonly details: SessionLifecycleConflictDetails;

  constructor(details: SessionLifecycleConflictDetails) {
    super(
      `Invalid session transition from ${details.fromStatus ?? "unknown"} to ${details.toStatus}`
    );
    this.name = "SessionLifecycleConflictError";
    this.details = details;
  }
}

export class SessionNotFoundError extends Error {
  readonly code = SESSION_NOT_FOUND_CODE;
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export function isSessionLifecycleConflictError(
  error: unknown
): error is SessionLifecycleConflictError {
  return error instanceof SessionLifecycleConflictError;
}

export function isSessionNotFoundError(
  error: unknown
): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError;
}

export function normalizeSessionLifecycleStatus(
  status: string | null | undefined
): AgentSessionLifecycleStatus | null {
  if (!status) return null;
  if (status === "pending") return "queued";
  if (
    status === "queued" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return null;
}

export function getSessionStatusForApi(
  status: string | null | undefined
): string {
  return normalizeSessionLifecycleStatus(status) ?? (status ?? "queued");
}

export function isValidSessionTransition(
  fromStatus: AgentSessionLifecycleStatus,
  toStatus: AgentSessionLifecycleStatus
): boolean {
  return ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

export interface SessionTransitionPatch {
  status: AgentSessionLifecycleStatus;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  error?: string | null;
}

export function buildSessionTransitionPatch(
  session: SessionLifecycleSnapshot,
  toStatus: AgentSessionLifecycleStatus,
  at: string,
  error?: string | null
): SessionTransitionPatch {
  const fromStatus = normalizeSessionLifecycleStatus(session.status);
  if (!fromStatus || !isValidSessionTransition(fromStatus, toStatus)) {
    throw new SessionLifecycleConflictError({
      sessionId: session.id,
      fromStatus: session.status,
      toStatus,
    });
  }

  const patch: SessionTransitionPatch = {
    status: toStatus,
  };

  if (toStatus === "running" && !session.startedAt) {
    patch.startedAt = at;
  }

  if (TERMINAL_STATUSES.has(toStatus)) {
    if (!session.endedAt) {
      patch.endedAt = at;
    }
    if (!session.completedAt) {
      patch.completedAt = at;
    }
    if (error !== undefined) {
      patch.error = error;
    } else if (toStatus === "completed") {
      patch.error = null;
    }
  }

  return patch;
}

export interface TransitionSessionStatusInput {
  sessionId: string;
  toStatus: AgentSessionLifecycleStatus;
  at?: string;
  error?: string | null;
}

export function transitionSessionStatus({
  sessionId,
  toStatus,
  at = new Date().toISOString(),
  error,
}: TransitionSessionStatusInput): SessionTransitionPatch {
  const session = db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      startedAt: agentSessions.startedAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  const patch = buildSessionTransitionPatch(session, toStatus, at, error);

  db.update(agentSessions)
    .set(patch)
    .where(eq(agentSessions.id, sessionId))
    .run();

  return patch;
}

export interface CreateQueuedSessionInput
  extends Omit<
    typeof agentSessions.$inferInsert,
    "status" | "startedAt" | "endedAt" | "completedAt"
  > {}

export function createQueuedSession(values: CreateQueuedSessionInput): void {
  db.insert(agentSessions)
    .values({
      ...values,
      status: "queued",
    })
    .run();
}

export function markSessionRunning(
  sessionId: string,
  at?: string
): SessionTransitionPatch {
  return transitionSessionStatus({
    sessionId,
    toStatus: "running",
    at,
  });
}

export function markSessionTerminal(
  sessionId: string,
  result: { success: boolean; error?: string | null },
  at?: string
): SessionTransitionPatch {
  return transitionSessionStatus({
    sessionId,
    toStatus: result.success ? "completed" : "failed",
    at,
    error: result.error ?? null,
  });
}

export function markSessionCancelled(
  sessionId: string,
  error = "Cancelled by user",
  at?: string
): SessionTransitionPatch {
  return transitionSessionStatus({
    sessionId,
    toStatus: "cancelled",
    at,
    error,
  });
}
