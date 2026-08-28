/**
 * "Latest session wins" failure indicator for epic cards.
 *
 * A retry creates a NEW agent_sessions row and statuses are terminal
 * (ALLOWED_TRANSITIONS.failed = [] in lifecycle.ts), so an old failed row
 * stays in the database forever. The badge must therefore reflect only the
 * most recent session of an epic: a queued/running/completed retry clears
 * it immediately, and it never comes back unless that retry fails too.
 *
 * created_at is a SQLite CURRENT_TIMESTAMP (second precision). When the
 * newest timestamp is shared by several sessions — e.g. a retry created in
 * the same second as the failure it replaces — ties break in favor of
 * CLEARING the badge. Within an all-failed tie group, the session that
 * ended most recently wins so the badge shows the retry's error.
 */

export interface FailedSessionInfo {
  sessionId: string;
  error: string;
  agentType: string;
  /**
   * Who ran the session that failed. The card's Retry button reuses this
   * agent — when the session was code-producing — instead of falling through
   * to the seeded default, and needs the provider to know whether that CLI
   * can resume at all (lib/agent-sessions/retry-dispatch.ts). Null on legacy
   * rows.
   */
  provider?: string | null;
  namedAgentId?: string | null;
  /**
   * Story the failed session was scoped to. Story builds carry their parent
   * epic's id too, so they land on the EPIC's card — an epic-wide retry must
   * be able to tell them apart. Null for epic-scoped sessions.
   */
  userStoryId?: string | null;
  /**
   * Whether the run ever streamed a non-empty output line. claude-code's CLI
   * session id is minted before the process starts, so a run that died at
   * launch still stores an id for a conversation that was never written;
   * resuming it fails where a cold start would have worked.
   */
  producedOutput?: boolean;
}

/** Minimal shape of a unified session row as returned by /api/projects/:id/sessions. */
export interface FailureCandidateSession {
  id: string;
  kind: string;
  status: string;
  epicId?: string | null;
  error?: string | null;
  agentType?: string | null;
  provider?: string | null;
  namedAgentId?: string | null;
  userStoryId?: string | null;
  /**
   * Whether the run ever streamed a non-empty output line. Decided in SQL by
   * the list route: the underlying `last_non_empty_text` is uncapped at the
   * write side (a CLI that emits one 4 MB line stores 4 MB), and this badge is
   * the only thing in the list that ever read it — so the column is reduced to
   * this boolean before it leaves the database.
   */
  producedOutput?: boolean;
  createdAt?: string | null;
  endedAt?: string | null;
}

export function selectLatestFailures(
  sessions: FailureCandidateSession[],
  runningEpicIds: Set<string>
): Record<string, FailedSessionInfo> {
  const byEpic = new Map<string, FailureCandidateSession[]>();
  for (const session of sessions) {
    if (session.kind !== "agent_session") continue;
    if (!session.epicId) continue;
    const list = byEpic.get(session.epicId);
    if (list) list.push(session);
    else byEpic.set(session.epicId, [session]);
  }

  const failed: Record<string, FailedSessionInfo> = {};
  for (const [epicId, epicSessions] of byEpic) {
    // Registry-only active agents have no DB row yet; never badge those epics.
    if (runningEpicIds.has(epicId)) continue;

    let newest = "";
    for (const s of epicSessions) {
      if ((s.createdAt ?? "") > newest) newest = s.createdAt ?? "";
    }
    const newestGroup = epicSessions.filter((s) => (s.createdAt ?? "") === newest);

    // Same-second tie with any non-failed session → clear the badge.
    if (newestGroup.some((s) => s.status !== "failed")) continue;

    // All-failed tie: prefer the session that ended most recently.
    let latest = newestGroup[0];
    for (const s of newestGroup) {
      if ((s.endedAt ?? "") > (latest.endedAt ?? "")) latest = s;
    }
    failed[epicId] = {
      sessionId: latest.id,
      error: latest.error || "Unknown error",
      agentType: latest.agentType || "build",
      provider: latest.provider ?? null,
      namedAgentId: latest.namedAgentId ?? null,
      userStoryId: latest.userStoryId ?? null,
      producedOutput: latest.producedOutput === true,
    };
  }
  return failed;
}
