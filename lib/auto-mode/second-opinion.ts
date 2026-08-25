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

function timestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function latestOrdinaryReviewAt(projectId: string, epicId: string): number {
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
    ? timestamp(row.endedAt ?? row.completedAt ?? row.createdAt)
    : Number.POSITIVE_INFINITY;
}

function structuredVerdictForSession(sessionId: string): string | null {
  const comments = db
    .select({ content: ticketComments.content })
    .from(ticketComments)
    .where(eq(ticketComments.agentSessionId, sessionId))
    .all();
  for (const comment of comments) {
    const verdict = comment.content.match(STRUCTURED_VERDICT_RE)?.[1];
    if (verdict) return verdict.toLowerCase();
  }
  return null;
}

function blockingFindingCount(sessionId: string): number {
  return db
    .select({ body: reviewComments.body })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.agentSessionId, sessionId),
        eq(reviewComments.status, "open")
      )
    )
    .all()
    .filter(
      (row) =>
        row.body.startsWith("[critical]") || row.body.startsWith("[major]")
    ).length;
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
  if (!Number.isFinite(reviewedAt)) return { status: "missing", sessionId: null };

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
    .find((row) => timestamp(row.createdAt) >= reviewedAt);

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

  const blocking = blockingFindingCount(session.id);
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

    const provider = await pickAlternativeReviewProvider(builderProvider, [
      reviewerProvider,
    ]);
    if (!provider) {
      throw new Error(
        "No installed provider differs from both the builder and reviewer"
      );
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
