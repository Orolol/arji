/**
 * Workflow effects for sessions that ended with the `asked_question`
 * delivery verdict.
 *
 * When an agent stops to ask the user a question, the workflow must:
 *   1. Hold the ticket where it is (callers skip their advance path —
 *      this module is the shared side-effect handler, not the guard),
 *   2. Notify the user with a deep link to the ticket awaiting a reply,
 *   3. Record the decision in the ticket activity log so the hold is
 *      auditable ("why didn't this ticket move?").
 */

import { logTransition } from "./log";
import { createAskedQuestionNotificationFromSession } from "@/lib/notifications/create";

export const AGENT_ASKED_QUESTION_REASON = "Agent asked a question";

export interface AskedQuestionOutcomeInput {
  projectId: string;
  sessionId: string;
  /**
   * Epics held by this session. Single-epic dispatches pass one id; team
   * builds pass every epic the session coordinated. Nullish entries
   * (sessions without a ticket) are ignored for logging.
   */
  epicIds: Array<string | null | undefined>;
  /**
   * Status the ticket is being held at (defaults to "in_progress").
   * Logged as a from == to entry: the decision NOT to advance.
   */
  ticketStatus?: string;
  /**
   * Per-epic override of `ticketStatus`, keyed by epic id. A team build
   * holds several epics that can sit in different columns — a single
   * status would put the same guess on every feed. Falls back to
   * `ticketStatus` for epics absent from the map.
   */
  ticketStatusByEpicId?: Record<string, string | undefined>;
}

/**
 * Applies the shared asked_question side effects: one notification for the
 * session (deep-linking to the epic when the session is epic-scoped) and one
 * activity-log entry per held epic (actor "system").
 *
 * Best-effort by design — it runs inside background completion blocks and
 * must never throw into them.
 */
export function handleAskedQuestionOutcome(
  input: AskedQuestionOutcomeInput
): void {
  try {
    createAskedQuestionNotificationFromSession(input.sessionId);
  } catch (err) {
    console.warn(
      "[agent-question] Failed to create asked-question notification:",
      (err as Error).message
    );
  }

  const fallbackStatus = input.ticketStatus ?? "in_progress";
  for (const epicId of input.epicIds) {
    if (!epicId) continue;
    const heldStatus =
      input.ticketStatusByEpicId?.[epicId] ?? fallbackStatus;
    // logTransition is itself best-effort (catches internally).
    logTransition({
      projectId: input.projectId,
      epicId,
      fromStatus: heldStatus,
      toStatus: heldStatus,
      actor: "system",
      reason: AGENT_ASKED_QUESTION_REASON,
      sessionId: input.sessionId,
    });
  }
}
