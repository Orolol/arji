import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  reviewComments,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { agentScheduler } from "@/lib/agents/scheduler";
import { getRunningSessionForTarget } from "@/lib/agents/concurrency";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import {
  findLastSuccessfulBuildProvider,
  findLastSuccessfulReviewProvider,
  pickAlternativeReviewProvider,
} from "@/lib/agent-config/review-segregation";
import { buildSecondOpinionPrompt } from "@/lib/claude/prompt-builder";
import { attachWorktree } from "@/lib/git/manager";
import {
  emitSessionCompleted,
  emitSessionFailed,
  emitSessionStarted,
} from "@/lib/events/emit";
import {
  isMcpToolsEnabled,
  providerSupportsMcp,
} from "@/lib/claude/mcp-injection";
import type { AgentProvider } from "@/lib/agent-config/constants";
import { sessionAtSql } from "@/lib/agent-sessions/session-time";
import { ORDINARY_REVIEW_AGENT_TYPES } from "@/lib/pipeline/findings";
import { autoRunId } from "./constants";

/** Free-form session type: settings/schema migrations are not needed. */
export const SECOND_OPINION_AGENT_TYPE = "review_second_opinion";

const ACTIVE_SESSION_STATUSES = new Set(["queued", "running"]);
const STRUCTURED_VERDICT_RE =
  /^\*\*Review findings \((approved|approved with minor issues|changes requested)\)\*\*/i;
const PROSE_VERDICT_RE =
  /^\*\*Overall Verdict:\s*(Approved with Minor Issues|Approved|Changes Requested)\*\*$/i;

type GateVerdict =
  | "approved"
  | "approved with minor issues"
  | "changes requested";

export type SecondOpinionState =
  | { status: "missing"; sessionId: null }
  | { status: "pending"; sessionId: string }
  | { status: "cancelled"; sessionId: string }
  | { status: "retry"; sessionId: string; reason: string }
  | { status: "approved"; sessionId: string }
  | { status: "rejected"; sessionId: string; reason: string };

export interface SecondOpinionDispatchResult {
  sessionId: string | null;
  error: string | null;
  conflictSessionId: string | null;
  skipReason?: string | null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = Date.parse(zoned);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestOrdinaryReviewAt(
  projectId: string,
  epicId: string
): number | null {
  const row = db
    .select({
      sessionAt: sessionAtSql() as ReturnType<typeof sql<string | null>>,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.epicId, epicId),
        isNull(agentSessions.userStoryId),
        eq(agentSessions.status, "completed"),
        eq(agentSessions.outcome, "answered"),
        inArray(agentSessions.agentType, [...ORDINARY_REVIEW_AGENT_TYPES])
      )
    )
    .orderBy(desc(sessionAtSql()))
    .limit(1)
    .get();
  return timestamp(row?.sessionAt);
}

/**
 * A user response after a rejected gate is new evidence, not permission to
 * reuse the old veto forever. It invalidates that session so Full Auto can
 * ask for a fresh opinion after the ticket is unparked.
 */
function latestUserCommentAt(epicId: string): number | null {
  const commentAt = sql<string>`REPLACE(${ticketComments.createdAt}, ' ', 'T')`;
  const row = db
    .select({ createdAt: commentAt })
    .from(ticketComments)
    .where(
      and(
        eq(ticketComments.epicId, epicId),
        eq(ticketComments.author, "user")
      )
    )
    .orderBy(desc(commentAt))
    .limit(1)
    .get();
  return timestamp(row?.createdAt);
}

function structuredVerdictForSession(sessionId: string): GateVerdict | null {
  const commentAt = sql<string>`REPLACE(${ticketComments.createdAt}, ' ', 'T')`;
  const comments = db
    .select({
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(eq(ticketComments.agentSessionId, sessionId))
    .orderBy(desc(commentAt))
    .all();
  let newestVerdict: GateVerdict | null = null;
  for (const comment of comments) {
    const verdict = comment.content
      .match(STRUCTURED_VERDICT_RE)?.[1]
      ?.toLowerCase() as GateVerdict | undefined;
    if (!verdict) continue;
    // The prompt requires exactly one submission. If an agent submits more
    // than once, a negative verdict must never be hidden by a stale approval.
    if (verdict === "changes requested") return verdict;
    newestVerdict ??= verdict;
  }
  return newestVerdict;
}

/**
 * Compatibility evidence for providers without MCP injection, which cannot
 * call submit_findings. Structured submissions always win when present; this
 * parser only consumes the exact final line the prompt mandates.
 */
function proseVerdictForSession(sessionId: string): GateVerdict | null {
  const commentAt = sql<string>`REPLACE(${ticketComments.createdAt}, ' ', 'T')`;
  const comments = db
    .select({ content: ticketComments.content })
    .from(ticketComments)
    .where(eq(ticketComments.agentSessionId, sessionId))
    .orderBy(desc(commentAt))
    .all();
  let newestVerdict: GateVerdict | null = null;
  for (const comment of comments) {
    const lastLine = comment.content.trim().split(/\r?\n/).at(-1)?.trim();
    const verdict = lastLine
      ?.match(PROSE_VERDICT_RE)?.[1]
      ?.toLowerCase() as GateVerdict | undefined;
    if (!verdict) continue;
    if (verdict === "changes requested") return verdict;
    newestVerdict ??= verdict;
  }
  return newestVerdict;
}

function openFindingCount(sessionId: string): number {
  return db
    .select({ id: reviewComments.id })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.agentSessionId, sessionId),
        eq(reviewComments.status, "open")
      )
    )
    .all().length;
}

/**
 * Reads the newest second opinion that is fresh relative to the ordinary
 * review. A structured submit_findings summary is authoritative when the
 * provider can produce one. The exact Overall Verdict line is the fail-safe
 * for non-MCP providers, so missing tool-channel capability cannot
 * turn an opted-in merge gate into a silent parking loop.
 */
export function readSecondOpinionState(
  projectId: string,
  epicId: string
): SecondOpinionState {
  const reviewedAt = latestOrdinaryReviewAt(projectId, epicId);
  if (reviewedAt === null) return { status: "missing", sessionId: null };

  const createdAt = sql<string>`REPLACE(${agentSessions.createdAt}, ' ', 'T')`;
  const session = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.epicId, epicId),
        eq(agentSessions.agentType, SECOND_OPINION_AGENT_TYPE)
      )
    )
    .orderBy(desc(createdAt))
    .all()
    .find(
      (row) =>
        (timestamp(row.createdAt) ?? Number.NEGATIVE_INFINITY) >= reviewedAt
    );

  if (!session) return { status: "missing", sessionId: null };
  if (ACTIVE_SESSION_STATUSES.has(session.status ?? "")) {
    return { status: "pending", sessionId: session.id };
  }

  const completedAt =
    timestamp(session.endedAt) ??
    timestamp(session.completedAt) ??
    timestamp(session.createdAt);
  const userCommentAt = latestUserCommentAt(epicId);
  if (
    completedAt !== null &&
    userCommentAt !== null &&
    userCommentAt > completedAt
  ) {
    return { status: "missing", sessionId: null };
  }

  if (session.status === "cancelled") {
    return { status: "cancelled", sessionId: session.id };
  }
  if (session.status !== "completed" || session.outcome !== "answered") {
    return {
      status: "retry",
      sessionId: session.id,
      reason: `second-opinion session ended ${session.status ?? "without status"}/${session.outcome ?? "without outcome"}`,
    };
  }

  const verdict =
    structuredVerdictForSession(session.id) ?? proseVerdictForSession(session.id);
  if (!verdict) {
    return {
      status: "retry",
      sessionId: session.id,
      reason: "no submit_findings or Overall Verdict evidence was recorded",
    };
  }

  // Full Auto's merge selector and workflow completion guard treat every open
  // finding as blocking, irrespective of its advisory severity label. Match
  // that rule here so a minor finding cannot leave an epic silently stranded.
  const blocking = openFindingCount(session.id);
  if (verdict === "changes requested" || blocking > 0) {
    return {
      status: "rejected",
      sessionId: session.id,
      reason:
        blocking > 0
          ? `${blocking} blocking finding${blocking === 1 ? "" : "s"}`
          : "changes requested",
    };
  }

  return { status: "approved", sessionId: session.id };
}

/**
 * Keeps the general segregation picker and excludes both prior authors. MCP
 * capability is intentionally not a selection requirement: providers that
 * cannot call submit_findings can still produce the exact fallback verdict
 * as prose in their final message.
 */
export function pickSecondOpinionProvider(
  builderProvider: AgentProvider,
  reviewerProvider: AgentProvider
): Promise<AgentProvider | null> {
  return pickAlternativeReviewProvider(
    builderProvider,
    [reviewerProvider]
  );
}

function existingWorktreePath(projectId: string, epicId: string): string | null {
  const rows = db
    .select({ worktreePath: agentSessions.worktreePath })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.epicId, epicId)
      )
    )
    .orderBy(desc(agentSessions.createdAt))
    .all();
  return (
    rows.find(
      (row) => row.worktreePath && fs.existsSync(row.worktreePath)
    )?.worktreePath ?? null
  );
}

/** Dispatches the short pre-merge gate and returns as soon as it is queued. */
export async function dispatchSecondOpinion(input: {
  projectId: string;
  epicId: string;
}): Promise<SecondOpinionDispatchResult> {
  const active = getRunningSessionForTarget({
    scope: "epic",
    projectId: input.projectId,
    epicId: input.epicId,
  });
  if (active) {
    return { sessionId: null, error: null, conflictSessionId: active.id };
  }

  try {
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .get();
    if (!project?.gitRepoPath) {
      throw new Error("Project has no git repository configured");
    }

    const epic = db
      .select()
      .from(epics)
      .where(eq(epics.id, input.epicId))
      .get();
    if (!epic?.branchName) throw new Error("Epic has no branch to review");

    const builderProvider = findLastSuccessfulBuildProvider({
      projectId: input.projectId,
      epicId: input.epicId,
    });
    const reviewerProvider = findLastSuccessfulReviewProvider({
      projectId: input.projectId,
      epicId: input.epicId,
    });
    if (!builderProvider || !reviewerProvider) {
      throw new Error("Could not identify both the builder and reviewer providers");
    }

    const provider = await pickSecondOpinionProvider(
      builderProvider,
      reviewerProvider
    );
    if (!provider) {
      return {
        sessionId: null,
        error: null,
        conflictSessionId: null,
        skipReason:
          "no installed provider differs from both the builder and reviewer",
      };
    }

    const worktreePath =
      existingWorktreePath(input.projectId, input.epicId) ??
      (await attachWorktree(project.gitRepoPath, epic.branchName)).worktreePath;
    const stories = db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, epic.id))
      .orderBy(userStories.position)
      .all();
    const baseBranch = project.defaultBranch || "main";
    const finalDiff = await simpleGit(worktreePath).diff([
      `${baseBranch}...HEAD`,
      "-U3",
    ]);
    const prompt = buildSecondOpinionPrompt(
      project,
      epic,
      stories,
      epic.branchName,
      baseBranch,
      finalDiff,
      isMcpToolsEnabled() && providerSupportsMcp(provider)
    );

    const sessionId = createId();
    const createdAt = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");
    const cliSessionId = providerAcceptsAssignedSessionId(provider)
      ? crypto.randomUUID()
      : undefined;

    // Availability checks and worktree attachment can take seconds. Repeat
    // both mutable guards immediately before the session row is created so a
    // human move or another dispatch in that window wins.
    const racedSession = getRunningSessionForTarget({
      scope: "epic",
      projectId: input.projectId,
      epicId: input.epicId,
    });
    if (racedSession) {
      return {
        sessionId: null,
        error: null,
        conflictSessionId: racedSession.id,
      };
    }
    const currentEpic = db
      .select({ status: epics.status, branchName: epics.branchName })
      .from(epics)
      .where(eq(epics.id, input.epicId))
      .get();
    if (
      currentEpic?.status !== "review" ||
      currentEpic.branchName !== epic.branchName
    ) {
      return {
        sessionId: null,
        error: null,
        conflictSessionId: null,
        skipReason: "the epic left Review or its branch changed",
      };
    }

    createQueuedSession({
      id: sessionId,
      projectId: input.projectId,
      epicId: input.epicId,
      // Code mode so the gate can call submit_findings (plan mode refuses
      // mutating MCP tools); the prompt itself forbids editing files.
      mode: "code",
      orchestrationMode: "solo",
      provider,
      prompt,
      logsPath,
      branchName: epic.branchName,
      worktreePath,
      cliSessionId,
      namedAgentId: null,
      agentType: SECOND_OPINION_AGENT_TYPE,
      namedAgentName: null,
      model: null,
      batchRunId: autoRunId(input.projectId),
      createdAt,
    });
    emitSessionStarted(
      input.projectId,
      input.epicId,
      sessionId,
      SECOND_OPINION_AGENT_TYPE
    );

    agentScheduler.submit(input.projectId, sessionId, async () => {
      markSessionRunning(sessionId);
      processManager.start(
        sessionId,
        {
          mode: "code",
          prompt,
          cwd: worktreePath,
          cliSessionId,
        },
        provider
      );

      const info = await waitForProcessCompletion(sessionId);
      const completedAt = new Date().toISOString();
      const result = info?.result;
      try {
        fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
      } catch {
        // Session rows/chunks remain authoritative if the convenience file fails.
      }

      const outcome = classifySessionOutcome(result, sessionId);
      try {
        markSessionTerminal(
          sessionId,
          {
            success: !!result?.success,
            error: result?.error || null,
            outcome,
            usage: extractSessionUsage(result),
          },
          completedAt
        );
      } catch (error) {
        if (!isSessionLifecycleConflictError(error)) {
          console.error(
            "[auto-mode/second-opinion] Failed to finalize session",
            error
          );
        }
      }

      db.insert(ticketComments)
        .values({
          id: createId(),
          epicId: input.epicId,
          author: "agent",
          content: `**Independent second opinion**\n\n${resolveSessionOutput(
            result,
            sessionId,
            "Second-opinion agent completed without output."
          )}`,
          agentSessionId: sessionId,
          createdAt: completedAt,
        })
        .run();

      if (result?.success) {
        emitSessionCompleted(input.projectId, input.epicId, sessionId);
      } else {
        emitSessionFailed(
          input.projectId,
          input.epicId,
          sessionId,
          result?.error || "Second opinion failed"
        );
      }
    });

    return { sessionId, error: null, conflictSessionId: null };
  } catch (error) {
    return {
      sessionId: null,
      conflictSessionId: null,
      error:
        error instanceof Error
          ? error.message
          : "Second-opinion dispatch failed",
    };
  }
}
