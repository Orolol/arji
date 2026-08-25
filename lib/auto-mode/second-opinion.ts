import fs from "fs";
import path from "path";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import { autoRunId } from "./constants";

/** Free-form session type: settings/schema migrations are not needed. */
export const SECOND_OPINION_AGENT_TYPE = "review_second_opinion";

const ORDINARY_REVIEW_AGENT_TYPES = [
  "review_security",
  "review_code",
  "review_compliance",
  "review_feature",
];
const ACTIVE_SESSION_STATUSES = new Set(["queued", "running"]);
const STRUCTURED_VERDICT_RE =
  /^\*\*Review findings \((approved|approved with minor issues|changes requested)\)\*\*/i;

export type SecondOpinionState =
  | { status: "missing"; sessionId: null }
  | { status: "pending"; sessionId: string }
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
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestOrdinaryReviewAt(
  projectId: string,
  epicId: string
): number | null {
  const row = db
    .select({
      createdAt: agentSessions.createdAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.epicId, epicId),
        eq(agentSessions.status, "completed"),
        eq(agentSessions.outcome, "answered"),
        inArray(agentSessions.agentType, ORDINARY_REVIEW_AGENT_TYPES)
      )
    )
    .orderBy(desc(agentSessions.createdAt))
    .limit(1)
    .get();
  return row
    ? timestamp(row.endedAt) ??
        timestamp(row.completedAt) ??
        timestamp(row.createdAt)
    : null;
}

function structuredVerdictForSession(sessionId: string): string | null {
  const comments = db
    .select({
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(eq(ticketComments.agentSessionId, sessionId))
    .orderBy(desc(ticketComments.createdAt))
    .all();
  let newestVerdict: string | null = null;
  for (const comment of comments) {
    const verdict = comment.content
      .match(STRUCTURED_VERDICT_RE)?.[1]
      ?.toLowerCase();
    if (!verdict) continue;
    // The prompt requires exactly one submission. If an agent submits more
    // than once, a negative verdict must never be hidden by a stale approval.
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
 * review. The structured submit_findings summary is authoritative here;
 * prose is deliberately not a pass signal for an unattended merge gate.
 */
export function readSecondOpinionState(
  projectId: string,
  epicId: string
): SecondOpinionState {
  const reviewedAt = latestOrdinaryReviewAt(projectId, epicId);
  if (reviewedAt === null) return { status: "missing", sessionId: null };

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
    .orderBy(desc(agentSessions.createdAt))
    .all()
    .find(
      (row) =>
        (timestamp(row.createdAt) ?? Number.NEGATIVE_INFINITY) >= reviewedAt
    );

  if (!session) return { status: "missing", sessionId: null };
  if (ACTIVE_SESSION_STATUSES.has(session.status ?? "")) {
    return { status: "pending", sessionId: session.id };
  }
  if (session.status !== "completed" || session.outcome !== "answered") {
    return {
      status: "retry",
      sessionId: session.id,
      reason: `second-opinion session ended ${session.status ?? "without status"}/${session.outcome ?? "without outcome"}`,
    };
  }

  const verdict = structuredVerdictForSession(session.id);
  if (!verdict) {
    return {
      status: "rejected",
      sessionId: session.id,
      reason: "no structured submit_findings verdict was recorded",
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
 * A structured second opinion needs the per-spawn MCP channel that carries
 * submit_findings. Keep the general segregation picker, but restrict this
 * gate to providers that can actually produce its authoritative evidence.
 */
export function pickSecondOpinionProvider(
  builderProvider: AgentProvider,
  reviewerProvider: AgentProvider
): Promise<AgentProvider | null> {
  return pickAlternativeReviewProvider(
    builderProvider,
    [reviewerProvider],
    providerSupportsMcp
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

/** Dispatches the short plan-mode gate and returns as soon as it is queued. */
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

    if (!isMcpToolsEnabled()) {
      return {
        sessionId: null,
        error: null,
        conflictSessionId: null,
        skipReason: "structured MCP tools are disabled",
      };
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
          "no installed MCP-capable provider differs from both the builder and reviewer",
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
    const prompt = buildSecondOpinionPrompt(
      project,
      epic,
      stories,
      epic.branchName,
      baseBranch
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
      mode: "plan",
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
          mode: "plan",
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
