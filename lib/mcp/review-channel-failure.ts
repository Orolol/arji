/**
 * The 401 trace for `submit_findings` — making a broken review channel
 * visible instead of silent.
 *
 * A rejected tool call is normally the caller's problem. This one is Arij's:
 * when a REVIEW session's `submit_findings` is refused, the reviewer's
 * findings never become rows, the session still ends `answered`, and every
 * downstream gate sees "a review completed and found nothing". That is the
 * exact shape of the failure this module exists for — three consecutive
 * rounds on one epic whose reviewer had no usable MCP token, ending in a
 * mergeable epic whose findings only ever existed in a ticket comment.
 *
 * The verdict half of the fix lives in lib/pipeline/findings.ts (a reviewer
 * that HAD the channel and filed no verdict is unverifiable, and blocks).
 * This module is the observability half: one activity-log entry on the
 * ticket and one notification, so the operator learns the channel is down
 * rather than inferring it from a gate that quietly refuses.
 *
 * ATTRIBUTION. A 401 means the token did not authenticate, so the caller's
 * identity has to be recovered some other way. Two routes, best first:
 *
 *   1. The token record itself. The store keeps records after revocation
 *      (see lib/mcp/token-store.ts), so a reviewer whose session ended
 *      mid-call — or was cancelled — is still identifiable exactly.
 *   2. The single running review session. A token the store never issued
 *      (the failure mode this module is named after: a provider that never
 *      delivered ARIJ_MCP_TOKEN to its child, or a server restart that
 *      dropped the store) carries no identity at all. When exactly ONE
 *      review session is running anywhere, it is the caller by elimination
 *      and the trace is worth more than the residual doubt. Zero or several,
 *      and this module stays silent rather than blaming the wrong ticket.
 *
 * Route 2 runs ONLY when route 1 found no record. A known token settles the
 * caller's identity whether or not that caller turns out to be a review —
 * guessing past it would let a build session's revoked token pin a
 * "review does not count" trace onto whichever review happens to be running,
 * and the dedupe would key that false trace to the innocent review's id.
 *
 * Everything here is best-effort and never throws: the route's job is to
 * return its 401, and a failed trace must not turn an auth rejection into a
 * 500.
 */

import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, epics, ticketActivityLog } from "@/lib/db/schema";
import { findMcpTokenRecord } from "@/lib/mcp/token-store";
import { createReviewChannelFailureNotification } from "@/lib/notifications/create";
import { logTransition } from "@/lib/workflow/log";

/**
 * Agent types that constitute a review. Same family
 * lib/workflow/context.ts recognises; kept local for the same reason the
 * other copies are (lib/agent-config/constants.ts documents that these lists
 * serve different purposes and must stay separate).
 */
function isReviewAgentType(agentType: string | null | undefined): boolean {
  if (!agentType) return false;
  return (
    agentType.includes("review") ||
    agentType === "security_reviewer" ||
    agentType === "code_reviewer" ||
    agentType === "compliance_reviewer" ||
    agentType === "feature_reviewer"
  );
}

/**
 * Stable prefix of the activity-log reason. Doubles as the dedupe key: a
 * reviewer that retries its rejected call twenty times must leave one entry,
 * not twenty, and the check has to survive a restart — so it queries the
 * durable row rather than an in-process set.
 */
export const REVIEW_CHANNEL_FAILURE_REASON_PREFIX =
  "submit_findings was rejected (401 UNAUTHORIZED)";

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

interface AttributedReviewSession {
  sessionId: string;
  projectId: string;
  epicId: string;
  agentType: string | null;
  /** How the session was identified, for the reason line. */
  attribution: "token" | "sole-running-review";
}

function readSession(sessionId: string) {
  return db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      agentType: agentSessions.agentType,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
}

/**
 * Route 1 — the (possibly revoked) token record names its session.
 *
 * Returns the attribution when that session is a review worth tracing, and
 * `null` when it is not — but the CALLER must still treat a resolvable record
 * as final. `attributeByTokenRecord` reports both facts so the two cannot be
 * confused: `known` says the token was ours, `attributed` says it is a review
 * with a ticket to trace against.
 */
function attributeByTokenRecord(token: string): {
  known: boolean;
  attributed: AttributedReviewSession | null;
} {
  const record = findMcpTokenRecord(token);
  if (!record) return { known: false, attributed: null };

  const session = readSession(record.sessionId);
  const agentType = session?.agentType ?? record.agentType;
  const epicId = session?.epicId ?? record.epicId;
  if (!isReviewAgentType(agentType) || !epicId) {
    return { known: true, attributed: null };
  }
  return {
    known: true,
    attributed: {
      sessionId: record.sessionId,
      projectId: session?.projectId ?? record.projectId,
      epicId,
      agentType: agentType ?? null,
      attribution: "token",
    },
  };
}

/**
 * Route 2 — exactly one review session is running, so it is the caller.
 *
 * Deliberately NOT narrowed to the token's project: an unissued token has no
 * project. Uniqueness across the whole store is what makes the inference
 * safe, and it is also what makes it decline in a busy multi-project server.
 */
function attributeBySoleRunningReview(): AttributedReviewSession | null {
  const running = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      agentType: agentSessions.agentType,
    })
    .from(agentSessions)
    .where(eq(agentSessions.status, "running"))
    .all()
    .filter((row) => isReviewAgentType(row.agentType) && row.epicId);

  if (running.length !== 1) return null;
  const session = running[0];
  return {
    sessionId: session.id,
    projectId: session.projectId,
    epicId: session.epicId!,
    agentType: session.agentType,
    attribution: "sole-running-review",
  };
}

/** True when this session already has its trace on the ticket. */
function alreadyTraced(sessionId: string): boolean {
  return (
    db
      .select({ id: ticketActivityLog.id })
      .from(ticketActivityLog)
      .where(
        and(
          eq(ticketActivityLog.sessionId, sessionId),
          like(
            ticketActivityLog.reason,
            `${REVIEW_CHANNEL_FAILURE_REASON_PREFIX}%`
          )
        )
      )
      .get() !== undefined
  );
}

/**
 * Record that a review session's `submit_findings` call was rejected 401.
 *
 * Called from the route's 401 branch, after the response is decided — it
 * changes nothing about the rejection itself.
 */
export function recordSubmitFindingsAuthFailure(request: Request): void {
  try {
    const header = request.headers.get("authorization") ?? "";
    const token = BEARER_PATTERN.exec(header)?.[1]?.trim() ?? "";

    // A token we minted answers the question outright — including when the
    // answer is "not a review". Only an unknown or absent token may fall
    // through to the by-elimination inference.
    const byToken = token
      ? attributeByTokenRecord(token)
      : { known: false, attributed: null };
    const attributed = byToken.known
      ? byToken.attributed
      : attributeBySoleRunningReview();
    if (!attributed) return;
    if (alreadyTraced(attributed.sessionId)) return;

    const status =
      db
        .select({ status: epics.status })
        .from(epics)
        .where(eq(epics.id, attributed.epicId))
        .get()?.status ?? "review";

    const reason =
      `${REVIEW_CHANNEL_FAILURE_REASON_PREFIX}: this review's findings never ` +
      `reached Arij, so the review does not count as clean and cannot unlock ` +
      `the merge. Re-run a review once the session's MCP token is valid. ` +
      `[attribution: ${attributed.attribution}]`;

    // Same-state entry: nothing moved, and the feed's job here is to say why
    // the ticket is stuck where it is — the pattern guard refusals already
    // use (lib/workflow/transition-service.ts).
    logTransition({
      projectId: attributed.projectId,
      epicId: attributed.epicId,
      fromStatus: status,
      toStatus: status,
      actor: "system",
      reason,
      sessionId: attributed.sessionId,
    });

    createReviewChannelFailureNotification({
      projectId: attributed.projectId,
      epicId: attributed.epicId,
      sessionId: attributed.sessionId,
      reason,
    });
  } catch (error) {
    console.warn(
      "[review-channel-failure] could not trace a submit_findings 401:",
      (error as Error).message
    );
  }
}
