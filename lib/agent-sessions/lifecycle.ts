import { and, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { notifySessionTerminal } from "./terminal-hooks";
import { buildSessionFailureMessage, buildSessionLogsRecord } from "./failure-message";
import { estimateTokens } from "@/lib/tokens/estimator";
import { capTextHeadTail } from "./head-tail-cap";
import {
  promptElisionMarker,
  SESSION_PROMPT_MAX_STORED_BYTES,
  SESSION_PROMPT_STORED_HEAD_BYTES,
  SESSION_PROMPT_STORED_TAIL_BYTES,
} from "./prompt-cap";
/**
 * The lifecycle vocabulary lives in a LEAF module and is re-exported here.
 *
 * This file imports `@/lib/db`, so anything a client component needs cannot be
 * read from it — `lib/qa/aggregate.ts` doing exactly that pulled
 * `better-sqlite3` into the browser bundle. Server-side importers keep using
 * these names from here; `./lifecycle-status` is where they are defined.
 */
export {
  SESSION_LIFECYCLE_STATUSES,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
} from "./lifecycle-status";
export type { AgentSessionLifecycleStatus } from "./lifecycle-status";

import {
  TERMINAL_STATUSES,
  type AgentSessionLifecycleStatus,
} from "./lifecycle-status";

/**
 * Delivery verdict for a terminal session — the persisted, first-class signal
 * of how the agent's run ended:
 *
 *   - answered:       the agent delivered textual output (default success)
 *   - asked_question: the agent ended by asking the user a question
 *   - silent:         the run succeeded but produced no textual deliverable
 *   - error:          the session failed
 *   - transition_refused: output was delivered but the required ticket move
 *                         was rejected by a workflow guard
 *
 * NULL in the database means "not classified": legacy rows, non-terminal
 * sessions, and user-cancelled sessions (cancellation is a user decision,
 * not a delivery verdict).
 */
export const SESSION_TRANSITION_REFUSED_OUTCOME = "transition_refused";

export const SESSION_OUTCOMES = [
  "answered",
  "asked_question",
  "silent",
  "error",
  SESSION_TRANSITION_REFUSED_OUTCOME,
] as const;

export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export function isSessionOutcome(value: unknown): value is SessionOutcome {
  return (
    typeof value === "string" &&
    (SESSION_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Token/cost usage reported by the provider CLI for a finished run (see
 * `extractSessionUsage` in lib/claude/resolve-session-output.ts). Fields are
 * present only when the provider actually reported them — the corresponding
 * columns stay NULL otherwise, never fake zeros.
 */
export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export const SESSION_LIFECYCLE_CONFLICT_CODE = "INVALID_SESSION_TRANSITION";
export const SESSION_NOT_FOUND_CODE = "SESSION_NOT_FOUND";

const ALLOWED_TRANSITIONS: Record<
  AgentSessionLifecycleStatus,
  AgentSessionLifecycleStatus[]
> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [], // terminal
  failed: [], // terminal
  cancelled: [], // terminal
};

export interface SessionLifecycleSnapshot {
  id: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  completedAt: string | null;
  /**
   * Optional context for the failed-session error synthesis (see
   * buildSessionTransitionPatch): whether any text output was captured and
   * where the full log lives. Absent when the snapshot is hand-built.
   */
  lastNonEmptyText?: string | null;
  logsPath?: string | null;
  projectId?: string | null;
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

/**
 * Asserts a valid transition; throws a SessionLifecycleConflictError if
 * invalid. Returns the target status for convenience.
 */
export function assertValidSessionTransition(
  sessionId: string,
  fromStatus: AgentSessionLifecycleStatus,
  toStatus: AgentSessionLifecycleStatus
): AgentSessionLifecycleStatus {
  if (!isValidSessionTransition(fromStatus, toStatus)) {
    throw new SessionLifecycleConflictError({
      sessionId,
      fromStatus,
      toStatus,
    });
  }
  return toStatus;
}

/**
 * Returns true if the given status is terminal (no further transitions
 * allowed).
 */
export function isTerminalSessionStatus(
  status: AgentSessionLifecycleStatus
): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export interface SessionTransitionPatch {
  status: AgentSessionLifecycleStatus;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  error?: string | null;
  outcome?: SessionOutcome;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export function buildSessionTransitionPatch(
  session: SessionLifecycleSnapshot,
  toStatus: AgentSessionLifecycleStatus,
  at: string,
  error?: string | null,
  outcome?: SessionOutcome,
  usage?: SessionUsage
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
    // A failed session must never end up with a NULL/empty error: the card
    // would fall back to a bare "Agent error"-style label and the
    // notification would carry no reason at all. When the caller brought no
    // message (empty stderr, lost result), synthesize an explicit one that
    // says what happened and where the full capture is.
    if (toStatus === "failed" && !(patch.error && patch.error.trim())) {
      patch.error = buildSessionFailureMessage({
        hadOutput: !!(session.lastNonEmptyText && session.lastNonEmptyText.trim()),
        logPath: session.logsPath ?? null,
      });
    }
    if (outcome !== undefined) {
      patch.outcome = outcome;
    }
    if (usage) {
      // Usage is only known once the run ended; copy the fields the
      // provider actually reported (finite numbers only). Omitted fields
      // leave their columns untouched (NULL for fresh sessions).
      if (Number.isFinite(usage.inputTokens)) {
        patch.inputTokens = usage.inputTokens;
      }
      if (Number.isFinite(usage.outputTokens)) {
        patch.outputTokens = usage.outputTokens;
      }
      if (Number.isFinite(usage.totalCostUsd)) {
        patch.totalCostUsd = usage.totalCostUsd;
      }
    }
  }

  return patch;
}

export interface TransitionSessionStatusInput {
  sessionId: string;
  toStatus: AgentSessionLifecycleStatus;
  at?: string;
  error?: string | null;
  outcome?: SessionOutcome;
  usage?: SessionUsage;
}

export function transitionSessionStatus({
  sessionId,
  toStatus,
  at = new Date().toISOString(),
  error,
  outcome,
  usage,
}: TransitionSessionStatusInput): SessionTransitionPatch {
  const session = db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      startedAt: agentSessions.startedAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
      lastNonEmptyText: agentSessions.lastNonEmptyText,
      logsPath: agentSessions.logsPath,
      projectId: agentSessions.projectId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  const patch = buildSessionTransitionPatch(
    session,
    toStatus,
    at,
    error,
    outcome,
    usage
  );

  db.update(agentSessions)
    .set(patch)
    .where(eq(agentSessions.id, sessionId))
    .run();

  // Traceability backstop: a failed session whose result envelope never
  // reached the dispatch route (process lost, launch closure crashed before
  // it could write logs) must still leave an on-disk record — the routes
  // write logsPath themselves whenever a result exists, so a MISSING file
  // is the signal that nobody captured the run. Writing the synthesized
  // record here covers every failure funnel (routes, scheduler safety net,
  // boot cleanup, night runs, auto mode) in one place.
  if (patch.status === "failed") {
    backfillMissingSessionLog(session, patch.error ?? null);
  }

  // Post-terminal side effects (e.g. auto memory distillation) hang off the
  // boot-registered hook — a no-op unless instrumentation wired one, and
  // never able to throw into the transition (see terminal-hooks.ts).
  if (TERMINAL_STATUSES.has(patch.status)) {
    notifySessionTerminal({
      sessionId,
      status: patch.status as "completed" | "failed" | "cancelled",
    });
  }

  return patch;
}

export type CreateQueuedSessionInput = Omit<
  typeof agentSessions.$inferInsert,
  "status" | "startedAt" | "endedAt" | "completedAt"
>;

/**
 * Cut a prompt down to {@link SESSION_PROMPT_MAX_STORED_BYTES} for storage.
 *
 * The write-path cap on `agent_sessions.prompt`. It applies to what is
 * PERSISTED and never to what is spawned: every dispatch path hands the CLI
 * the prompt it composed, and only the row that records it is bounded. See
 * `prompt-cap.ts` for why the column is diagnostic and where 128 KiB comes
 * from.
 *
 * Null-tolerant because the column and the insert type are. Every dispatch
 * path today composes a prompt, but a cap that turned an absent one into an
 * empty string would be a silent schema change, and `""` and NULL read
 * differently everywhere downstream.
 */
export function capSessionPrompt(prompt: string): string;
export function capSessionPrompt(
  prompt: string | null | undefined
): string | null | undefined;
export function capSessionPrompt(
  prompt: string | null | undefined
): string | null | undefined {
  if (!prompt) return prompt;
  return capTextHeadTail(prompt, {
    maxBytes: SESSION_PROMPT_MAX_STORED_BYTES,
    headBytes: SESSION_PROMPT_STORED_HEAD_BYTES,
    tailBytes: SESSION_PROMPT_STORED_TAIL_BYTES,
    marker: promptElisionMarker,
  }).text;
}

export function createQueuedSession(values: CreateQueuedSessionInput): void {
  let estimatedPromptTokens = values.estimatedPromptTokens;
  const estimatedPromptBreakdown = values.estimatedPromptBreakdown;

  if (
    values.prompt &&
    (estimatedPromptTokens === undefined || estimatedPromptTokens === null)
  ) {
    // Deliberately the UNCAPPED prompt. The estimate describes what the agent
    // is about to be handed — the same reason `appendChunk` derives
    // `lastNonEmptyText` from uncapped content. An estimate computed off the
    // stored row would under-report exactly the runs whose prompt size is
    // worth knowing about.
    estimatedPromptTokens = estimateTokens(values.prompt);
  }

  db.insert(agentSessions)
    .values({
      ...values,
      prompt: capSessionPrompt(values.prompt),
      estimatedPromptTokens: estimatedPromptTokens ?? null,
      estimatedPromptBreakdown: estimatedPromptBreakdown ?? null,
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
  result: {
    success: boolean;
    error?: string | null;
    /**
     * Delivery verdict for this run (see `classifySessionOutcome` in
     * lib/claude/resolve-session-output.ts). When omitted, failed sessions
     * still get 'error' so the verdict column never lies about failures;
     * successful sessions stay unclassified (NULL).
     */
    outcome?: SessionOutcome;
    /**
     * Token/cost usage reported by the provider CLI (see
     * `extractSessionUsage`). Omitted for providers whose results carry no
     * usage — the columns stay NULL.
     */
    usage?: SessionUsage;
  },
  at?: string
): SessionTransitionPatch {
  return transitionSessionStatus({
    sessionId,
    toStatus: result.success ? "completed" : "failed",
    at,
    error: result.error ?? null,
    outcome: result.outcome ?? (result.success ? undefined : "error"),
    usage: result.usage,
  });
}

/**
 * A provider run may complete successfully while its required board
 * transition is refused. Preserve the completed lifecycle status (the agent
 * did deliver output), but replace the delivery verdict so supervisors and
 * pipeline settle handlers do not credit it as completed work.
 */
export function recordSessionTransitionRefusal(
  sessionId: string,
  error: string
): boolean {
  const session = db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (normalizeSessionLifecycleStatus(session?.status) !== "completed") {
    return false;
  }

  const result = db
    .update(agentSessions)
    .set({ outcome: SESSION_TRANSITION_REFUSED_OUTCOME, error })
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "completed"))
    )
    .run();
  return result.changes > 0;
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

/**
 * Writes the session's log file when it is missing (see the backstop call
 * in transitionSessionStatus). Best-effort: a failed filesystem write must
 * never break the terminal transition — the DB row (status + error) already
 * carries the truth, the file only adds the raw capture.
 */
export function backfillMissingSessionLog(
  session: SessionLifecycleSnapshot,
  terminalError: string | null
): void {
  const logsPath = session.logsPath;
  if (!logsPath) return;

  try {
    if (fs.existsSync(logsPath)) return;
    fs.mkdirSync(path.dirname(logsPath), { recursive: true });
    fs.writeFileSync(
      logsPath,
      JSON.stringify(buildSessionLogsRecord(null, terminalError), null, 2)
    );
  } catch (error) {
    console.warn(
      `[lifecycle] Could not backfill missing session log for ${session.id}`,
      error instanceof Error ? error.message : error
    );
  }
}
