/**
 * Acceptance-criteria grader dispatch.
 *
 * Grading is intentionally observational: it creates a plan-mode session and
 * a grading report, but never changes epic/story status. Epics without a
 * usable rubric are a successful, journalled no-op.
 */
import fs from "fs";
import path from "path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  epics,
  gradingReports,
  projects,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { assembleGradingPrompt } from "@/lib/tokens";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  classifySessionOutcome,
  extractSessionUsage,
} from "@/lib/claude/resolve-session-output";
import { resolveAgentForDispatch } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { agentScheduler } from "@/lib/agents/scheduler";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
  type AgentAlreadyRunningPayload,
} from "@/lib/agents/concurrency";
import { logTransition } from "@/lib/workflow/log";
import {
  emitSessionCompleted,
  emitSessionFailed,
  emitSessionStarted,
} from "@/lib/events/emit";

export const GRADING_AGENT_TYPE = "grading" as const;

export const GRADING_NO_STORIES_REASON =
  "Grading skipped — this epic has no user stories.";
export const GRADING_NO_CRITERIA_REASON =
  "Grading skipped — no user story has acceptance criteria.";

const GRADING_MISSING_REPORT_ERROR =
  "The grading agent finished without calling submit_grading; no structured grading report was saved.";

type ProjectRow = typeof projects.$inferSelect;
type EpicRow = typeof epics.$inferSelect;
type StoryRow = typeof userStories.$inferSelect;

export interface GradingSessionResult {
  sessionId: string;
  success: boolean;
  outcome: string | null;
  error: string | null;
  reportId: string | null;
}

export type DispatchGradingResult =
  | {
      skipped: true;
      reason: string;
    }
  | {
      skipped: false;
      sessionId: string;
      provider: string;
      segregated: boolean;
      builderProvider: string | null;
      settled: Promise<GradingSessionResult>;
    };

/** Error with the HTTP response contract the thin route should expose. */
export class GradingDispatchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly payload?: AgentAlreadyRunningPayload,
  ) {
    super(message);
    this.name = "GradingDispatchError";
  }
}

export interface DispatchGradingInput {
  projectId: string;
  epicId: string;
  /** Pipeline story runs grade only their own rubric; manual runs grade the epic. */
  userStoryId?: string | null;
  namedAgentId?: string | null;
  batchRunId?: string | null;
}

/** Non-empty criteria are the rubric; stories without criteria are omitted. */
export function gradableStories(stories: StoryRow[]): StoryRow[] {
  return stories.filter(
    (story) =>
      typeof story.acceptanceCriteria === "string" &&
      story.acceptanceCriteria.trim().length > 0,
  );
}

function gradingSkipReason(stories: StoryRow[]): string | null {
  if (stories.length === 0) return GRADING_NO_STORIES_REASON;
  if (gradableStories(stories).length === 0) return GRADING_NO_CRITERIA_REASON;
  return null;
}

function journalSkip(projectId: string, epic: EpicRow, reason: string): void {
  const status = epic.status ?? "backlog";
  logTransition({
    projectId,
    epicId: epic.id,
    fromStatus: status,
    toStatus: status,
    actor: "system",
    reason,
  });
}

function loadScope(input: DispatchGradingInput): {
  project: ProjectRow;
  epic: EpicRow;
  stories: StoryRow[];
} {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) {
    throw new GradingDispatchError("Project not found", 404, "PROJECT_NOT_FOUND");
  }

  const epic = db
    .select()
    .from(epics)
    .where(and(eq(epics.id, input.epicId), eq(epics.projectId, input.projectId)))
    .get();
  if (!epic) {
    throw new GradingDispatchError("Epic not found", 404, "EPIC_NOT_FOUND");
  }

  const stories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, input.epicId))
    .orderBy(userStories.position)
    .all();

  return { project, epic, stories };
}

/**
 * Creates and schedules one epic-scoped grader session, or returns the
 * journalled no-op without touching Git/session state.
 */
export async function dispatchGradingSession(
  input: DispatchGradingInput,
): Promise<DispatchGradingResult> {
  const { project, epic, stories } = loadScope(input);
  const scopedStories = input.userStoryId
    ? stories.filter((story) => story.id === input.userStoryId)
    : stories;
  if (input.userStoryId && scopedStories.length === 0) {
    throw new GradingDispatchError(
      "Story not found in this epic",
      404,
      "STORY_NOT_FOUND",
    );
  }
  const skipReason = gradingSkipReason(scopedStories);
  if (skipReason) {
    journalSkip(input.projectId, epic, skipReason);
    return { skipped: true, reason: skipReason };
  }

  const gradingTarget = input.userStoryId ? scopedStories[0] : epic;
  if (gradingTarget.status !== "review" && gradingTarget.status !== "done") {
    throw new GradingDispatchError(
      `${input.userStoryId ? "Story" : "Epic"} must be in review or done status for acceptance grading`,
      400,
      input.userStoryId ? "INVALID_STORY_STATUS" : "INVALID_EPIC_STATUS",
    );
  }

  const target = input.userStoryId
    ? {
        scope: "story" as const,
        projectId: input.projectId,
        storyId: input.userStoryId,
        epicId: input.epicId,
      }
    : {
        scope: "epic" as const,
        projectId: input.projectId,
        epicId: input.epicId,
      };
  const conflict = getRunningSessionForTarget(target);
  if (conflict) {
    const payload = createAgentAlreadyRunningPayload(
      target,
      conflict,
      "Another agent is already running for this epic.",
    );
    throw new GradingDispatchError(payload.error, 409, payload.code, payload);
  }

  if (!project.gitRepoPath) {
    throw new GradingDispatchError(
      "Project has no git repository path configured",
      400,
      "MISSING_GIT_REPOSITORY",
    );
  }
  if (!(await isGitRepo(project.gitRepoPath))) {
    throw new GradingDispatchError(
      `Path is not a git repository: ${project.gitRepoPath}`,
      400,
      "INVALID_GIT_REPOSITORY",
    );
  }

  const rubric = gradableStories(scopedStories);
  const assembled = await assembleGradingPrompt({
    projectId: input.projectId,
    epicId: input.epicId,
    project,
    epic,
    stories: rubric,
  });
  const prompt = assembled.prompt;
  const resolvedAgent = await resolveAgentForDispatch(
    GRADING_AGENT_TYPE,
    input.projectId,
    input.namedAgentId ?? null,
    {
      purpose: "grading",
      projectId: input.projectId,
      epicId: input.epicId,
      ...(input.userStoryId ? { storyId: input.userStoryId } : {}),
    },
  );

  const { worktreePath, branchName } = await createWorktree(
    project.gitRepoPath,
    epic.id,
    epic.title,
    { defaultBranch: project.defaultBranch },
  );

  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");
  const cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
    ? crypto.randomUUID()
    : undefined;

  createQueuedSession({
    id: sessionId,
    projectId: input.projectId,
    epicId: input.epicId,
    userStoryId: input.userStoryId ?? null,
    mode: "code",
    provider: resolvedAgent.provider,
    prompt,
    estimatedPromptTokens: assembled.tokens.total,
    estimatedPromptBreakdown: JSON.stringify(assembled.tokens.breakdown),
    logsPath,
    branchName,
    worktreePath,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    compositeAgentId: resolvedAgent.compositeAgentId ?? null,
    namedAgentName: resolvedAgent.name ?? null,
    model: resolvedAgent.model ?? null,
    agentType: GRADING_AGENT_TYPE,
    batchRunId: input.batchRunId ?? null,
    createdAt: now,
  });

  emitSessionStarted(
    input.projectId,
    input.epicId,
    sessionId,
    GRADING_AGENT_TYPE,
  );

  let settle!: (result: GradingSessionResult) => void;
  const settled = new Promise<GradingSessionResult>((resolve) => {
    settle = resolve;
  });

  agentScheduler.submit(input.projectId, sessionId, async () => {
    let terminal: GradingSessionResult = {
      sessionId,
      success: false,
      outcome: null,
      error: "Grading session did not run",
      reportId: null,
    };

    try {
      markSessionRunning(sessionId);
      processManager.start(
        sessionId,
        {
          mode: "code",
          prompt,
          cwd: worktreePath,
          model: resolvedAgent.model,
          cliSessionId,
        },
        resolvedAgent.provider,
      );

      const info = await waitForProcessCompletion(sessionId);
      const completedAt = new Date().toISOString();
      const result = info?.result;

      try {
        fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
      } catch {
        // Best-effort log write.
      }

      const outcome = classifySessionOutcome(result, sessionId);
      const report = db
        .select({ id: gradingReports.id })
        .from(gradingReports)
        .where(eq(gradingReports.agentSessionId, sessionId))
        .orderBy(desc(gradingReports.createdAt))
        .limit(1)
        .get();
      const success = Boolean(result?.success && report);
      const error = success
        ? null
        : result?.error ??
          (result?.success
            ? GRADING_MISSING_REPORT_ERROR
            : "The grading session failed without reporting an error.");

      terminal = {
        sessionId,
        success,
        outcome,
        error,
        reportId: report?.id ?? null,
      };

      try {
        markSessionTerminal(
          sessionId,
          {
            success,
            error,
            outcome,
            usage: extractSessionUsage(result),
          },
          completedAt,
        );
      } catch (lifecycleError) {
        if (!isSessionLifecycleConflictError(lifecycleError)) {
          console.error("[grading] Failed to finalize session", lifecycleError);
        }
      }

      if (success) {
        emitSessionCompleted(input.projectId, input.epicId, sessionId);
      } else {
        emitSessionFailed(
          input.projectId,
          input.epicId,
          sessionId,
          error ?? "Acceptance grading failed",
        );
      }
    } catch (error) {
      terminal = {
        sessionId,
        success: false,
        outcome: "error",
        error: error instanceof Error ? error.message : "Grading launch failed",
        reportId: null,
      };
      throw error;
    } finally {
      settle(terminal);
    }
  });

  return {
    skipped: false,
    sessionId,
    provider: resolvedAgent.provider,
    segregated: resolvedAgent.segregated === true,
    builderProvider: resolvedAgent.builderProvider ?? null,
    settled,
  };
}
