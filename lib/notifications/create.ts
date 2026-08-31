import { and, eq, isNotNull } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import {
  agentSessions,
  projects,
  epics,
  notifications,
  type RoutineKind,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { AGENT_TYPE_LABELS } from "@/lib/agent-config/constants";
import { formatDocumentMention } from "@/lib/documents/mention-format";
import { durationMsBetween, sendProjectWebhook } from "@/lib/webhooks/send";
import { NIGHT_STOPPED_ABORT_REASON } from "@/lib/night/constants";
import {
  DREAMING_AGENT_TYPE,
  MEMORY_DREAMED_TITLE,
} from "@/lib/workflow/dreaming-constants";
import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";
import { ROUTINE_KIND_LABELS } from "@/lib/routines/constants";
import {
  REFINEMENT_AGENT_TYPE,
  REFINEMENT_LABEL,
} from "@/lib/refinement/constants";

const MAX_NOTIFICATIONS = 200;

/**
 * Build a human-readable notification title from session context.
 *
 * Examples:
 *   "Build completed — E-proj-003: Login feature"
 *   "Tech check failed"
 *   "Review: Code completed"
 */
export function buildTitle(
  agentType: string | null,
  status: "completed" | "failed",
  epicTitle?: string | null,
  epicReadableId?: string | null
): string {
  const label =
    (agentType && AGENT_TYPE_LABELS[agentType as keyof typeof AGENT_TYPE_LABELS]) ||
    agentType ||
    "Agent";
  const verb = status === "completed" ? "completed" : "failed";
  const base = `${label} ${verb}`;

  if (epicReadableId && epicTitle) {
    return `${base} \u2014 ${epicReadableId}: ${epicTitle}`;
  }
  if (epicTitle) {
    return `${base} \u2014 ${epicTitle}`;
  }
  return base;
}

/**
 * Build the target URL for a notification.
 *
 * QA report sessions navigate to the QA tab; everything else to the session detail.
 */
export function buildTargetUrl(
  projectId: string,
  sessionId: string,
  agentType: string | null
): string {
  if (
    agentType === "tech_check" ||
    agentType === "e2e_test" ||
    agentType === "failure_digest"
  ) {
    return `/projects/${projectId}/qa`;
  }
  return `/projects/${projectId}/sessions/${sessionId}`;
}

/**
 * Title for an asked_question notification.
 *
 * Examples:
 *   "Agent asked a question on E-proj-003: Login feature"
 *   "Agent asked a question on Login feature"
 *   "Agent asked a question"
 */
export function buildAskedQuestionTitle(
  epicTitle?: string | null,
  epicReadableId?: string | null
): string {
  const base = "Agent asked a question";
  if (epicReadableId && epicTitle) {
    return `${base} on ${epicReadableId}: ${epicTitle}`;
  }
  if (epicReadableId || epicTitle) {
    return `${base} on ${epicReadableId ?? epicTitle}`;
  }
  return base;
}

/**
 * Deep link opening the epic on the kanban board (handled by the project
 * page's `?ticket=` query parameter).
 */
export function buildEpicTargetUrl(projectId: string, epicId: string): string {
  return `/projects/${projectId}?ticket=${epicId}`;
}

/**
 * Persist the visible audit signal for one scheduled trigger. The routine
 * row keeps the durable last-run state; this notification explains the
 * outcome and links to the surface affected by the canonical action.
 */
export function createRoutineRunNotification(input: {
  projectId: string;
  kind: RoutineKind;
  status: "completed" | "skipped" | "failed";
  message: string;
  targetUrl: string;
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const label = ROUTINE_KIND_LABELS[input.kind];
  const outcome =
    input.status === "failed"
      ? "failed"
      : input.status === "skipped"
        ? "skipped"
        : "triggered";

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: null,
      agentType: "routine",
      status: input.status === "failed" ? "failed" : "completed",
      title: `${label} routine ${outcome}`,
      message: input.message,
      targetUrl: input.targetUrl,
    })
    .run();

  pruneNotifications();
}

/** One durable, ticket-scoped alarm for a failing PR head SHA. */
export function createCiWatchFailureNotification(input: {
  projectId: string;
  epicId: string;
  epicTitle: string;
  epicReadableId: string | null;
  prNumber: number;
  headSha: string;
  failedChecks: string[];
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const ticket = input.epicReadableId
    ? `${input.epicReadableId}: ${input.epicTitle}`
    : input.epicTitle;
  const failedChecks = input.failedChecks.join(", ") || "unknown check";

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: null,
      agentType: "ci_watch",
      status: "failed",
      title: `CI failed on PR #${input.prNumber} — ${ticket}`,
      message: `Failing checks: ${failedChecks}. Head ${input.headSha.slice(0, 12)}.`,
      targetUrl: buildEpicTargetUrl(input.projectId, input.epicId),
    })
    .run();

  pruneNotifications();
}

/**
 * A successful autofix only changes the local epic branch. Make the required
 * manual push explicit instead of letting the generic "Build completed"
 * notification imply that GitHub has already received the fix.
 */
export function createCiAutofixReadyNotification(input: {
  projectId: string;
  epicId: string;
  sessionId: string;
  branchName: string;
  prNumber: number;
  headSha: string;
}): void {
  const existing = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.sessionId, input.sessionId),
        isNotNull(notifications.message)
      )
    )
    .limit(1)
    .get();
  if (existing) return;

  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  const epic = db
    .select({ title: epics.title, readableId: epics.readableId })
    .from(epics)
    .where(eq(epics.id, input.epicId))
    .get();
  if (!project || !epic) return;

  const ticket = epic.readableId
    ? `${epic.readableId}: ${epic.title}`
    : epic.title;
  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: "ci_autofix",
      status: "completed",
      title: `CI autofix completed locally — push ${input.branchName} for PR #${input.prNumber} — ${ticket}`,
      message: `The branch contains a fix for head ${input.headSha.slice(0, 12)}, but Arij did not push it automatically. Push the branch to rerun CI.`,
      targetUrl: buildTargetUrl(input.projectId, input.sessionId, "build"),
    })
    .run();

  pruneNotifications();
}

/**
 * Title for a watchdog "agent seems stalled" notification.
 *
 * Examples:
 *   "Agent seems stalled on E-proj-003: Login feature — no output for 5m"
 *   "Agent seems stalled on Login feature — no output for 12m"
 *   "Agent seems stalled — no output for 5m"
 */
export function buildStalledTitle(
  staleMinutes: number,
  epicTitle?: string | null,
  epicReadableId?: string | null
): string {
  const base = "Agent seems stalled";
  const suffix = `— no output for ${staleMinutes}m`;
  if (epicReadableId && epicTitle) {
    return `${base} on ${epicReadableId}: ${epicTitle} ${suffix}`;
  }
  if (epicReadableId || epicTitle) {
    return `${base} on ${epicReadableId ?? epicTitle} ${suffix}`;
  }
  return `${base} ${suffix}`;
}

/**
 * Title for a run launched with document mentions Arij could not resolve.
 *
 * Examples:
 *   "Build ran without @spec.md — no such document in Docs"
 *   "Code review ran without @spec.md, @notes.md — no such document in Docs"
 */
export function buildUnresolvedMentionsTitle(
  missing: string[],
  agentType: string | null
): string {
  const label =
    (agentType && AGENT_TYPE_LABELS[agentType as keyof typeof AGENT_TYPE_LABELS]) ||
    agentType ||
    "Agent";
  const list = missing.map((name) => formatDocumentMention(name)).join(", ");
  return `${label} ran without ${list} — no such document in Docs`;
}

/**
 * Notify that a prompt referenced documents that do not exist in Docs.
 *
 * The run still launched: an agent writing `@some/file.ts` about the project's
 * own codebase must never block a build or a review, and a user typo should
 * cost a notification, not a refused launch.
 */
export function createUnresolvedMentionsNotification(input: {
  projectId: string;
  missing: string[];
  agentType: string | null;
  targetUrl: string;
  sessionId?: string | null;
}): void {
  if (input.missing.length === 0) return;

  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId ?? null,
      agentType: input.agentType,
      status: "failed",
      title: buildUnresolvedMentionsTitle(input.missing, input.agentType),
      targetUrl: input.targetUrl,
    })
    .run();

  pruneNotifications();
}

interface SessionNotificationContext {
  session: {
    id: string;
    projectId: string;
    epicId: string | null;
    status: string | null;
    agentType: string | null;
    outcome: string | null;
    startedAt: string | null;
    endedAt: string | null;
    error: string | null;
  };
  projectName: string;
  epicTitle: string | null;
  epicReadableId: string | null;
}

/**
 * Shared session/project/epic lookup for notification creators.
 * Returns null when the session or project no longer exists.
 */
function loadSessionNotificationContext(
  sessionId: string
): SessionNotificationContext | null {
  const session = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      status: agentSessions.status,
      agentType: agentSessions.agentType,
      outcome: agentSessions.outcome,
      startedAt: agentSessions.startedAt,
      endedAt: agentSessions.endedAt,
      error: agentSessions.error,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session) return null;

  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, session.projectId))
    .get();

  if (!project) return null;

  let epicTitle: string | null = null;
  let epicReadableId: string | null = null;
  if (session.epicId) {
    const epic = db
      .select({ title: epics.title, readableId: epics.readableId })
      .from(epics)
      .where(eq(epics.id, session.epicId))
      .get();
    if (epic) {
      epicTitle = epic.title;
      epicReadableId = epic.readableId;
    }
  }

  return { session, projectName: project.name, epicTitle, epicReadableId };
}

/**
 * Create a notification row from a completed/failed agent session.
 *
 * Looks up the session, project, and optional epic context, then inserts
 * a notification row and prunes old entries beyond MAX_NOTIFICATIONS.
 *
 * A FAILED notification carries the full error message (0031
 * `notifications.message`) so the bell — the cross-project "what just went
 * wrong" surface — explains the failure instead of showing a bare title.
 * Thanks to the failure-message synthesis in
 * lib/agent-sessions/lifecycle.ts, a new failed session always has a
 * non-NULL error (explicit no-output wording included), so the message is
 * never a bare label.
 *
 * Idempotent per session: the terminal hook (instrumentation.ts) creates
 * the notification the moment the session row is finalized, and the
 * dispatch routes' emitSessionFailed/emitSessionCompleted then call this
 * same function. A message-bearing row means a terminal path already supplied
 * full context — either a failure or a specialized completion signal such as
 * a local CI autofix awaiting a push. Other session rows (stalled-watchdog
 * alarms, merge-parked, …) carry NULL and never suppress it.
 *
 * Sessions whose delivery verdict is `asked_question` are skipped here: the
 * question-flavored notification is owned by
 * `createAskedQuestionNotificationFromSession` (invoked by the workflow's
 * asked-question handling), so the generic "completed" copy never shows up
 * for a run that actually stopped to ask the user something.
 */
export function createNotificationFromSession(sessionId: string): void {
  const existing = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.sessionId, sessionId),
        isNotNull(notifications.message)
      )
    )
    .limit(1)
    .get();
  if (existing) return;

  const context = loadSessionNotificationContext(sessionId);
  if (!context) return;
  const { session, projectName, epicTitle, epicReadableId } = context;

  if (session.outcome === "asked_question") return;

  const notifStatus =
    session.status === "failed" ? "failed" : "completed";

  const title = buildTitle(session.agentType, notifStatus, epicTitle, epicReadableId);
  const targetUrl = buildTargetUrl(session.projectId, session.id, session.agentType);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: session.projectId,
      projectName,
      sessionId: session.id,
      agentType: session.agentType,
      status: notifStatus,
      title,
      // The full failure reason, not just the title — see the doc above.
      // NULL for completed sessions: there is nothing to explain.
      message: notifStatus === "failed" ? session.error : null,
      targetUrl,
    })
    .run();

  // Prune old notifications beyond MAX_NOTIFICATIONS
  pruneNotifications();

  // Fire-and-forget outbound webhook (no-op unless the project configured one).
  void sendProjectWebhook(session.projectId, {
    event: notifStatus === "failed" ? "session.failed" : "session.completed",
    ticketTitle: epicTitle,
    epicId: session.epicId,
    sessionId: session.id,
    durationMs: durationMsBetween(session.startedAt, session.endedAt),
    error: notifStatus === "failed" ? session.error : null,
    path: targetUrl,
  });
}

/**
 * Create the "Agent asked a question on <ticket>" notification for a session
 * that ended with the `asked_question` delivery verdict.
 *
 * Deep-links to the epic on the board when the session is epic-scoped,
 * falling back to the session detail otherwise (e.g. team builds).
 */
export function createAskedQuestionNotificationFromSession(
  sessionId: string
): void {
  const context = loadSessionNotificationContext(sessionId);
  if (!context) return;
  const { session, projectName, epicTitle, epicReadableId } = context;

  const title = buildAskedQuestionTitle(epicTitle, epicReadableId);
  const targetUrl = session.epicId
    ? buildEpicTargetUrl(session.projectId, session.epicId)
    : buildTargetUrl(session.projectId, session.id, session.agentType);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: session.projectId,
      projectName,
      sessionId: session.id,
      agentType: session.agentType,
      status: "completed",
      title,
      targetUrl,
    })
    .run();

  pruneNotifications();

  // The run did complete — keep the stable webhook vocabulary, but point the
  // deep link at the ticket awaiting the user's reply.
  void sendProjectWebhook(session.projectId, {
    event: "session.completed",
    ticketTitle: epicTitle,
    epicId: session.epicId,
    sessionId: session.id,
    durationMs: durationMsBetween(session.startedAt, session.endedAt),
    error: null,
    path: targetUrl,
  });
}

/**
 * Create the "Full Auto Mode could not merge <ticket>" notification.
 *
 * The one path where Full Auto Mode gives up and needs a human: a merge
 * conflict survived the merge-fix agent and the retry, so the epic is parked
 * and its branch is still unmerged. Deep-links to the epic on the board —
 * the actionable place is the ticket, not the (already finished) session.
 * Uses the "failed" status for alarm styling.
 */
export function createAutoModeMergeParkedNotification(input: {
  projectId: string;
  epicId: string;
  sessionId: string | null;
  error: string;
}): void {
  createAutoModeMergeNotification(input, (label, error) =>
    `Auto mode could not merge ${label} — ${error}`
  );
}

/**
 * Create the "Full Auto Mode will not merge <ticket>" notification.
 *
 * Raised when the deterministic-verification gate has refused the same epic
 * repeatedly: nothing failed and nothing is parked, so the mode would
 * otherwise stay silent forever while the epic sits in Review unmergeable.
 * Deep-links to the epic, where the verification panel shows the evidence.
 */
export function createAutoModeMergeBlockedNotification(input: {
  projectId: string;
  epicId: string;
  error: string;
}): void {
  createAutoModeMergeNotification(
    { ...input, sessionId: null },
    (label, error) =>
      `Auto mode will not merge ${label} without verification — ${error}`
  );
}

function createAutoModeMergeNotification(
  input: {
    projectId: string;
    epicId: string;
    sessionId: string | null;
    error: string;
  },
  buildTitle: (label: string, error: string) => string
): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const epic = db
    .select({ title: epics.title, readableId: epics.readableId })
    .from(epics)
    .where(eq(epics.id, input.epicId))
    .get();

  const label = epic?.readableId
    ? epic.title
      ? `${epic.readableId}: ${epic.title}`
      : epic.readableId
    : (epic?.title ?? input.epicId);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: "merge",
      status: "failed",
      title: buildTitle(label, input.error),
      targetUrl: buildEpicTargetUrl(input.projectId, input.epicId),
    })
    .run();

  pruneNotifications();
}

/**
 * Alarm raised when a review session's `submit_findings` call is rejected.
 *
 * This is the one failure the rest of the system cannot see: the reviewer
 * runs, finishes, and reports "answered", but the findings it tried to file
 * never became rows. Without this notification the only symptom is an epic
 * that looks reviewed and clean — which is precisely how a broken channel
 * used to unlock a merge. Deep-links to the epic, where the Review column
 * now shows the same refusal.
 */
export function createReviewChannelFailureNotification(input: {
  projectId: string;
  epicId: string;
  sessionId: string;
  reason: string;
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const epic = db
    .select({ title: epics.title, readableId: epics.readableId })
    .from(epics)
    .where(eq(epics.id, input.epicId))
    .get();

  const label = epic?.readableId
    ? epic.title
      ? `${epic.readableId}: ${epic.title}`
      : epic.readableId
    : (epic?.title ?? input.epicId);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: "review",
      status: "failed",
      title: `Review findings could not be filed on ${label} — the review does not count`,
      message: input.reason,
      targetUrl: buildEpicTargetUrl(input.projectId, input.epicId),
    })
    .run();

  pruneNotifications();
}

/**
 * Alarm raised when Full Auto's independent pre-merge reviewer vetoes the
 * branch or repeatedly fails to return usable evidence. The session is the
 * evidence, so unlike a git-conflict park this notification deep-links
 * directly to the completed second-opinion run.
 */
export function createAutoModeSecondOpinionParkedNotification(input: {
  projectId: string;
  epicId: string;
  sessionId: string;
  reason: string;
}): void {
  const duplicate = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.sessionId, input.sessionId),
        eq(notifications.agentType, "review_second_opinion")
      )
    )
    .get();
  if (duplicate) return;

  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const epic = db
    .select({ title: epics.title, readableId: epics.readableId })
    .from(epics)
    .where(eq(epics.id, input.epicId))
    .get();
  const label = epic?.readableId
    ? epic.title
      ? `${epic.readableId}: ${epic.title}`
      : epic.readableId
    : (epic?.title ?? input.epicId);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: "review_second_opinion",
      status: "failed",
      title: `Second opinion blocked auto-merge for ${label} — ${input.reason}`,
      targetUrl: `/projects/${input.projectId}/sessions/${input.sessionId}`,
    })
    .run();

  pruneNotifications();
}

/**
 * Create the "Approval blocked — could not merge <ticket>" notification.
 *
 * Fired by the approve routes when the pre-approval merge fails. The approve
 * flow merges FIRST and only then marks anything done, so a failed merge
 * means the ticket deliberately stayed put — nothing was resolved, nothing
 * moved. The user has to act: open the epic, run Resolve Merge, and approve
 * again. Deep-links to the epic on the board (the actionable place is the
 * ticket, not a session — no agent ran). Uses the "failed" status for alarm
 * styling.
 */
export function createApproveMergeFailedNotification(input: {
  projectId: string;
  epicId: string;
  error: string;
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const epic = db
    .select({ title: epics.title, readableId: epics.readableId })
    .from(epics)
    .where(eq(epics.id, input.epicId))
    .get();

  const label = epic?.readableId
    ? epic.title
      ? `${epic.readableId}: ${epic.title}`
      : epic.readableId
    : (epic?.title ?? input.epicId);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: null,
      // Own type string (not "merge"): approval blockage is user-actionable,
      // not an agent run, and must stay distinguishable from auto-mode rows.
      agentType: "approve_merge_failed",
      status: "failed",
      title: `Approval blocked — could not merge ${label}: ${input.error}. Use Resolve Merge, then approve again.`,
      targetUrl: buildEpicTargetUrl(input.projectId, input.epicId),
    })
    .run();

  pruneNotifications();
}

/**
 * Create the "merge-fix agent ran, but the merge STILL failed" notification.
 *
 * Fired by the resolve-merge route and the merge route's autoAgent retry
 * when the post-agent merge attempt comes back `merged: false` — e.g. the
 * agent committed the conflict markers instead of resolving them, tripping
 * the conflict-marker guard. Without this the failure would be silent: the
 * routes' background closures have no HTTP response left to carry it, so a
 * notification is the only way the user learns why the epic did not close.
 * Deep-links to the epic on the board; uses "failed" for alarm styling.
 */
export function createMergeRetryFailedNotification(input: {
  projectId: string;
  epicId: string;
  sessionId: string | null;
  error: string;
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const epic = db
    .select({ title: epics.title, readableId: epics.readableId })
    .from(epics)
    .where(eq(epics.id, input.epicId))
    .get();

  const label = epic?.readableId
    ? epic.title
      ? `${epic.readableId}: ${epic.title}`
      : epic.readableId
    : (epic?.title ?? input.epicId);

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: "merge",
      status: "failed",
      title: `Merge-fix agent finished, but the merge still failed for ${label} — ${input.error}`,
      targetUrl: buildEpicTargetUrl(input.projectId, input.epicId),
    })
    .run();

  pruneNotifications();
}

/**
 * Create the watchdog's "Agent seems stalled" notification for a running
 * session that has produced no output chunks past its staleness threshold
 * (see lib/agents/watchdog.ts, which also guarantees at-most-once delivery
 * per session).
 *
 * Deep-links to the session detail — the actionable place for a stall:
 * inspect the output streams, then cancel if the agent really hung.
 * Uses the "failed" notification status for alarm styling; the session row
 * itself is untouched (the watchdog never auto-kills).
 *
 * No outbound webhook: the session has not ended, and the webhook
 * vocabulary (session.completed / session.failed) is strictly terminal.
 */
export function createStalledSessionNotification(
  sessionId: string,
  staleMinutes: number
): void {
  const context = loadSessionNotificationContext(sessionId);
  if (!context) return;
  const { session, projectName, epicTitle, epicReadableId } = context;

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: session.projectId,
      projectName,
      sessionId: session.id,
      agentType: session.agentType,
      status: "failed",
      title: buildStalledTitle(staleMinutes, epicTitle, epicReadableId),
      targetUrl: `/projects/${session.projectId}/sessions/${session.id}`,
    })
    .run();

  pruneNotifications();
}

export interface MemoryDreamedNotificationInput {
  projectId: string;
  /** The 'dreaming' session that rewrote the document. */
  sessionId: string;
  /** Sessions the digest carried. */
  sessionsAnalyzed: number;
  /** Length of the memory the dream replaced (0 when there was none). */
  previousChars: number;
  /** Length of the memory now stored. */
  newChars: number;
}

/**
 * Title for a memory rewritten by a dream — the "summary of the change" the
 * user needs before deciding whether to open it.
 *
 * Examples:
 *   "Project memory updated by Dreaming — 12 sessions analyzed, 3200 → 5100 chars"
 *   "Project memory updated by Dreaming — 4 sessions analyzed, written from scratch (900 chars)"
 */
export function buildMemoryDreamedTitle(
  input: Pick<
    MemoryDreamedNotificationInput,
    "sessionsAnalyzed" | "previousChars" | "newChars"
  >
): string {
  const sessions = `${input.sessionsAnalyzed} session${
    input.sessionsAnalyzed === 1 ? "" : "s"
  } analyzed`;
  const change =
    input.previousChars > 0
      ? `${input.previousChars} → ${input.newChars} chars`
      : `written from scratch (${input.newChars} chars)`;
  return `${MEMORY_DREAMED_TITLE} — ${sessions}, ${change}`;
}

/**
 * Notification for a dream that actually replaced the project memory (a dream
 * that failed, stayed silent or found nothing new never gets here — see
 * lib/workflow/dreaming.ts).
 *
 * Deep-links to the Spec & Memory section, where the memory panel shows the
 * new text (provenance, cap, the pre-dream snapshot to restore from, and the
 * editor): the actionable place is the document, not the (already finished)
 * session. Status "completed" — this is good news, not an alarm.
 */
export function createMemoryDreamedNotification(
  input: MemoryDreamedNotificationInput
): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: DREAMING_AGENT_TYPE,
      status: "completed",
      title: buildMemoryDreamedTitle(input),
      targetUrl: `/projects/${input.projectId}/spec#memory-panel`,
    })
    .run();

  pruneNotifications();
}

/**
 * Notification for a successful per-session distillation: the
 * 'memory_distill' session merged what a just-finished run taught into the
 * memory document. Deep-links to the SOURCE session when one was distilled —
 * the run that taught the lesson: the user's interest is "what did my build
 * learn", and the source session is where that run lives. A manual distill
 * without a source session falls back to the distiller's own session page.
 */
export function createMemoryDistilledNotification(input: {
  projectId: string;
  /** The 'memory_distill' session that wrote the memory. */
  sessionId: string;
  /** The completed session whose learnings were merged in (manual: none). */
  sourceSessionId?: string | null;
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: "memory_distill",
      status: "completed",
      title: "Project memory updated by distillation",
      targetUrl: `/projects/${input.projectId}/sessions/${
        input.sourceSessionId ?? input.sessionId
      }`,
    })
    .run();

  pruneNotifications();
}

/**
 * Notification for a manual write to the memory document: a hand save or a
 * one-click restore of the pre-dream snapshot. Every memory write produces
 * an activity entry in the project feed, manual ones included — the user
 * (and any parallel agent session they can see) should be able to tell when
 * someone poked the document by hand. Status "completed"; no session to
 * link, so `sessionId`/`agentType` stay null.
 */
export function createMemoryManualWriteNotification(input: {
  projectId: string;
  /** True for a restore of the pre-dream snapshot, false for a hand save. */
  restored: boolean;
}): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      status: "completed",
      title: input.restored
        ? "Project memory restored from the pre-dream snapshot"
        : "Project memory updated (manual edit)",
      targetUrl: `/projects/${input.projectId}/spec#memory-panel`,
    })
    .run();

  pruneNotifications();
}

export interface DagWaveOutcomeInput {
  projectId: string;
  /** 1-based wave that just settled with blocked tickets. */
  wave: number;
  totalWaves: number;
  /** Tickets whose session failed or ended by asking a question. */
  blocked: Array<{ epicId: string; kind: "failed" | "asked_question" }>;
  /** How many tickets were skipped as a consequence (dependents + stop policy). */
  skippedCount: number;
  /** True when the "stop" failure policy abandoned the remaining waves. */
  stopped: boolean;
}

/**
 * Title for a DAG wave that ended with blocked tickets.
 *
 * Examples:
 *   "Wave 2/4: E-proj-003 failed — 2 dependents skipped"
 *   "Wave 1/3: E-proj-001 asked a question — 1 dependent skipped"
 *   "Wave 1/3: 2 epics blocked — batch stopped, 4 tickets skipped"
 */
export function buildDagWaveOutcomeTitle(
  input: DagWaveOutcomeInput,
  epicLabel: (epicId: string) => string
): string {
  const head = `Wave ${input.wave}/${input.totalWaves}: `;
  const mid =
    input.blocked.length === 1
      ? `${epicLabel(input.blocked[0].epicId)} ${
          input.blocked[0].kind === "failed" ? "failed" : "asked a question"
        }`
      : `${input.blocked.length} epics blocked`;
  const tail = input.stopped
    ? ` — batch stopped, ${input.skippedCount} ticket${
        input.skippedCount === 1 ? "" : "s"
      } skipped`
    : input.skippedCount > 0
      ? ` — ${input.skippedCount} dependent${
          input.skippedCount === 1 ? "" : "s"
        } skipped`
      : "";
  return head + mid + tail;
}

/**
 * Notification summarizing a DAG build wave that blocked (failed sessions or
 * unanswered agent questions), skipping the blocked tickets' dependents.
 *
 * Not session-scoped: one wave can block on several sessions, and the
 * actionable place is the board where the skipped tickets sit — so the deep
 * link targets the project board rather than a single session.
 */
export function createDagWaveOutcomeNotification(
  input: DagWaveOutcomeInput
): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const epicLabel = (epicId: string): string => {
    const epic = db
      .select({ readableId: epics.readableId, title: epics.title })
      .from(epics)
      .where(eq(epics.id, epicId))
      .get();
    return epic?.readableId || epic?.title || epicId;
  };

  // Alarm styling only when something actually failed; a wave blocked purely
  // by questions matches the asked-question notifications' "completed" state.
  const status = input.blocked.some((b) => b.kind === "failed")
    ? "failed"
    : "completed";

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: null,
      agentType: "build",
      status,
      title: buildDagWaveOutcomeTitle(input, epicLabel),
      targetUrl: `/projects/${input.projectId}`,
    })
    .run();

  pruneNotifications();
}

export interface NightRunSummaryNotificationInput {
  projectId: string;
  /** `night_`-prefixed run id; drives the `?nightRun=` deep link. */
  runId: string;
  counts: Record<TicketExecutionStatus, number>;
  /** SUM of Claude-reported costs (lower bound, see costIsPartial). */
  totalCostUsd: number;
  /** True when at least one tagged session reported no cost. */
  costIsPartial: boolean;
  /** Wave-engine abort reason (circuit breaker / cost cap), else null. */
  abortReason: string | null;
  durationMs: number | null;
}

/**
 * Title for the single morning-summary notification of a night run.
 *
 * Examples:
 *   "Night run finished: 5 to merge, 1 paused, 2 failed, 1 skipped — $4.20"
 *   "Night run finished: 3 to merge — ≥$1.10"
 *   "Night run finished: 2 failed, 4 skipped — circuit breaker tripped"
 *
 * Zero buckets are omitted; wave status "done" reads "to merge" (the night
 * run never merges; the passing review already promoted the ticket to To
 * Merge, awaiting the morning merge) and "asked" reads "paused". The cost suffix
 * appears only when > 0, prefixed "≥" when partial (non-Claude providers
 * report no cost). A breaker/cost-cap abort appends its marker.
 */
export function buildNightRunSummaryTitle(
  counts: Record<TicketExecutionStatus, number>,
  totalCostUsd: number,
  costIsPartial: boolean,
  abortReason: string | null
): string {
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${counts.done} to merge`);
  if (counts.asked > 0) parts.push(`${counts.asked} paused`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);

  let title =
    parts.length > 0
      ? `Night run finished: ${parts.join(", ")}`
      : "Night run finished";

  if (totalCostUsd > 0) {
    title += ` — ${costIsPartial ? "≥" : ""}$${totalCostUsd.toFixed(2)}`;
  }

  if (abortReason === NIGHT_STOPPED_ABORT_REASON) {
    title += " — stopped by you";
  } else if (abortReason?.startsWith("circuit breaker")) {
    title += " — circuit breaker tripped";
  } else if (abortReason?.startsWith("cost cap")) {
    title += " — cost cap reached";
  }

  return title;
}

/**
 * The EXACTLY-ONE morning-summary notification of a night run (fired from
 * the night engine's terminal choke point — never on restart-interrupted
 * runs). Not session-scoped: the run owns many sessions, and the actionable
 * place is the summary dialog the `?nightRun=` deep link opens.
 */
export function createNightRunSummaryNotification(
  input: NightRunSummaryNotificationInput
): void {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return;

  const status =
    input.counts.failed > 0 || input.abortReason !== null
      ? "failed"
      : "completed";

  db.insert(notifications)
    .values({
      id: createId(),
      projectId: input.projectId,
      projectName: project.name,
      sessionId: null,
      agentType: "build",
      status,
      title: buildNightRunSummaryTitle(
        input.counts,
        input.totalCostUsd,
        input.costIsPartial,
        input.abortReason
      ),
      targetUrl: `/projects/${input.projectId}?nightRun=${input.runId}`,
    })
    .run();

  pruneNotifications();
}

export interface RefinementReportNotificationInput {
  projectId: string;
  /** The refinement session that made the pass. */
  sessionId: string;
  /** Aggregate line, e.g. "4 tickets promoted to To do · 2 sent back". */
  summary: string;
  /** False when the session failed or was cancelled part-way. */
  succeeded: boolean;
}

/**
 * Notification for a finished board refinement re-pass.
 *
 * Deep-links to the board rather than the session: the pass reshaped the
 * planning columns, and that is where the user checks the result. A run that
 * ended early still notifies — its partial writes are already on the board,
 * so silence would leave unexplained movement.
 */
export function createRefinementReportNotification(
  input: RefinementReportNotificationInput
): string | null {
  const project = db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return null;

  const id = createId();
  db.insert(notifications)
    .values({
      id,
      projectId: input.projectId,
      projectName: project.name,
      sessionId: input.sessionId,
      agentType: REFINEMENT_AGENT_TYPE,
      status: input.succeeded ? "completed" : "failed",
      title: input.succeeded
        ? `${REFINEMENT_LABEL} — ${input.summary}`
        : `${REFINEMENT_LABEL} ended early — ${input.summary}`,
      targetUrl: `/projects/${input.projectId}`,
    })
    .run();

  pruneNotifications();
  return id;
}

function pruneNotifications(): void {
  const count = sqlite
    .prepare("SELECT COUNT(*) AS cnt FROM notifications")
    .get() as { cnt: number };

  if (count.cnt > MAX_NOTIFICATIONS) {
    sqlite.exec(`
      DELETE FROM notifications
      WHERE id NOT IN (
        SELECT id FROM notifications
        ORDER BY created_at DESC
        LIMIT ${MAX_NOTIFICATIONS}
      )
    `);
  }
}
