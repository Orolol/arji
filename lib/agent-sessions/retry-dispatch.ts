/**
 * What the "Retry" button on a failed epic card actually dispatches.
 *
 * The historical handler posted to the BATCH build route with the board
 * toolbar's currently-selected agent. Both halves were wrong:
 *
 *   - the toolbar selection is null unless the user picked an agent for this
 *     visit, so the server fell through resolveAgent()'s default chain and
 *     retried on the seeded "Claude Code" agent — never mind that the run
 *     that just failed belonged to some other named agent;
 *   - the batch route has no `resumeSessionId` parameter at all, so a retry
 *     could only ever start from a cold prompt.
 *
 * A retry is a second attempt at the SAME work by the SAME agent, so it
 * reuses the failed session's named agent and asks the single-epic route
 * (the one that does accept `resumeSessionId`) to continue that session.
 *
 * This is deliberately a pure function: the decision is the bug, and it is
 * worth testing without mounting the kanban page.
 */

import { isCodeProducingAgentType } from "@/lib/agent-config/constants";
import { isResumableProvider } from "./resume-capability";
import type { FailedSessionInfo } from "./latest-failure";

export interface RetryDispatch {
  /** Single-epic build route — the batch route ignores resumeSessionId. */
  url: string;
  body: {
    namedAgentId?: string;
    resumeSessionId?: string;
  };
}

/**
 * Builds the retry request for a failed epic session.
 *
 * @param failed              The badge's failed-session info, when the card
 *                            still carries one.
 * @param selectedNamedAgentId The board toolbar's current selection, used
 *                            only when the failed session names no agent.
 */
export function buildRetryDispatch(
  projectId: string,
  epicId: string,
  failed: FailedSessionInfo | undefined,
  selectedNamedAgentId: string | null,
): RetryDispatch {
  const url = `/api/projects/${projectId}/epics/${epicId}/build`;
  const namedAgentId = failed?.namedAgentId || selectedNamedAgentId || null;

  const body: RetryDispatch["body"] = {};
  if (namedAgentId) body.namedAgentId = namedAgentId;
  if (shouldResume(failed, namedAgentId)) {
    body.resumeSessionId = failed!.sessionId;
  }
  return { url, body };
}

/**
 * Resume is only coherent when the retry lands on the very agent that owns
 * the stored CLI session id. The server re-checks all of this
 * (validateResumeSession) and silently starts fresh when it disagrees;
 * deciding it here too keeps the request honest about its intent.
 */
function shouldResume(
  failed: FailedSessionInfo | undefined,
  namedAgentId: string | null,
): boolean {
  if (!failed?.sessionId) return false;

  // Fell back to the toolbar's agent (or to the server's default chain):
  // whatever runs next is not the process that minted the session id.
  if (!failed.namedAgentId || failed.namedAgentId !== namedAgentId) return false;

  // A CLI that cannot continue a session would be handed an id it has no
  // flag for — codex above all, which never reports the thread it created.
  if (!failed.provider || !isResumableProvider(failed.provider)) return false;

  // The retry always dispatches a BUILD. Resuming a review (or grading, or
  // forensic) thread would append a build prompt to a conversation shaped
  // for another task, so only a code-producing session is continued.
  return isCodeProducingAgentType(failed.agentType);
}
