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
 * Two separate decisions, and conflating them is its own bug: WHICH AGENT to
 * run, and WHETHER TO RESUME its conversation. selectLatestFailures badges an
 * epic from any session carrying that epicId — reviews, grading passes and
 * story builds included — while this button only ever dispatches an
 * epic-wide build. So each decision is gated on what the badged session
 * actually proves about that build.
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
 *                            only when the failed session names no reusable
 *                            agent.
 */
export function buildRetryDispatch(
  projectId: string,
  epicId: string,
  failed: FailedSessionInfo | undefined,
  selectedNamedAgentId: string | null,
): RetryDispatch {
  const url = `/api/projects/${projectId}/epics/${epicId}/build`;
  const namedAgentId = resolveRetryAgent(failed, selectedNamedAgentId);

  const body: RetryDispatch["body"] = {};
  if (namedAgentId) body.namedAgentId = namedAgentId;
  if (shouldResume(failed, namedAgentId)) {
    body.resumeSessionId = failed!.sessionId;
  }
  return { url, body };
}

/**
 * Which agent runs the retry.
 *
 * Only a previous CODE-PRODUCING session says anything about how to build
 * this epic. A failed review or grading pass badges the same card, and
 * resolveAgentByNamedId() looks a named agent up by id without consulting
 * the agent type it was asked for — so forwarding the reviewer's id would
 * run the BUILD on the reviewer's agent and model, and the route would then
 * seed the whole pipeline with it via startPipelineRun({ buildNamedAgentId }).
 * Under review-provider segregation that agent was deliberately chosen to be
 * a different provider from the builder, which is this ticket's own bug with
 * a different wrong agent.
 *
 * Falling through for those cases is not a regression: with no build agent
 * known, the server's default chain resolves the project's or global BUILD
 * role assignment, which is the right answer for a build.
 *
 * A story build is kept: it is the same code-producing role on the same
 * epic, so its agent is a better answer than the default. Only its
 * conversation is story-shaped — see shouldResume.
 */
function resolveRetryAgent(
  failed: FailedSessionInfo | undefined,
  selectedNamedAgentId: string | null,
): string | null {
  const reusable =
    failed?.namedAgentId && isCodeProducingAgentType(failed.agentType)
      ? failed.namedAgentId
      : null;
  return reusable || selectedNamedAgentId || null;
}

/**
 * Whether to continue the failed session's conversation.
 *
 * The server re-checks most of this (validateResumeSession) and silently
 * starts fresh when it disagrees; deciding it here too keeps the request
 * honest about its intent — and covers the two cases the server cannot see
 * from the epic route.
 */
function shouldResume(
  failed: FailedSessionInfo | undefined,
  namedAgentId: string | null,
): boolean {
  if (!failed?.sessionId) return false;

  // Fell back to the toolbar's agent (or to the server's default chain):
  // whatever runs next is not the process that minted the session id. This
  // also covers every non-code-producing type, which resolveRetryAgent has
  // already refused to carry over.
  if (!failed.namedAgentId || failed.namedAgentId !== namedAgentId) return false;

  // A CLI that cannot continue a session would be handed an id it has no
  // flag for — codex above all, which never reports the thread it created.
  if (!failed.provider || !isResumableProvider(failed.provider)) return false;

  // Scope. A story build carries its parent epic's id, so it badges this
  // card, but this retry dispatches an EPIC-wide prompt. The epic route calls
  // validateResumeSession without a userStoryId and that helper only compares
  // stories when the caller supplies one, so the server would accept the
  // resume on matching epic scope alone and append an epic prompt to a
  // one-story conversation. Only the client knows enough to refuse.
  if (failed.userStoryId) return false;

  // Evidence the conversation exists. claude-code's cliSessionId is minted
  // with crypto.randomUUID() before the process starts and persisted whatever
  // happens next, so a run that died at launch still stores an id for a
  // transcript that was never written; `--resume <uuid>` then fails at launch
  // and — since the badge survives a failed retry — clicking Retry again just
  // reproduces it, instead of falling back to the cold start that works.
  // Providers that report their own id are immune (no output, no id), so this
  // only bites the case it is meant to.
  return !!failed.producedOutput;
}
