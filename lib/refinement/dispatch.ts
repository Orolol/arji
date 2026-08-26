/**
 * Board refinement dispatch.
 *
 * A refinement run is project-scoped, not ticket-scoped: the session row
 * carries no epicId, so every MCP call it makes names its target explicitly
 * and its token cannot default to "the ticket I was launched for". That is
 * also why it needs no worktree — it produces no code, so it runs in the
 * project's checkout with a prompt-level no-edit contract, the same shape
 * the review and grading agents use.
 *
 * Code mode, not plan mode: the pass's entire deliverable is mutating MCP
 * calls, which plan mode refuses.
 */
import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, projects } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { buildRefinementPrompt } from "@/lib/claude/prompt-builder";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  classifySessionOutcome,
  extractSessionUsage,
} from "@/lib/claude/resolve-session-output";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentForDispatch } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { agentScheduler } from "@/lib/agents/scheduler";
import { REFINEMENT_AGENT_TYPE } from "./constants";
import { loadRefinementSnapshot, snapshotSize } from "./snapshot";
import { publishRefinementReport, type RefinementReport } from "./report";
import { takeRefinementChanges } from "./registry";

export const REFINEMENT_EMPTY_BOARD_REASON =
  "Refinement skipped — Backlog and To do are both empty.";

export interface RefinementSessionResult {
  sessionId: string;
  success: boolean;
  outcome: string | null;
  error: string | null;
  report: RefinementReport | null;
  summary: string | null;
}

export type DispatchRefinementResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      sessionId: string;
      provider: string;
      ticketCount: number;
      settled: Promise<RefinementSessionResult>;
    };

/** Error with the HTTP response contract the thin route should expose. */
export class RefinementDispatchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = "RefinementDispatchError";
  }
}

/**
 * The queued or running refinement session for a project, if any.
 *
 * Project-scoped rather than the usual ticket-scoped concurrency check:
 * two passes over the same board would race on positions and each would
 * reorder around the other's half-applied ranking.
 */
export function getActiveRefinementSession(
  projectId: string,
): { id: string; status: string | null } | undefined {
  return db
    .select({ id: agentSessions.id, status: agentSessions.status })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, REFINEMENT_AGENT_TYPE),
        inArray(agentSessions.status, ["queued", "running"]),
      ),
    )
    .get();
}

export interface DispatchRefinementInput {
  projectId: string;
  namedAgentId?: string | null;
}

/**
 * Create and schedule one board refinement session, or return the skip when
 * there is nothing in the planning columns to refine.
 */
export async function dispatchRefinementSession(
  input: DispatchRefinementInput,
): Promise<DispatchRefinementResult> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) {
    throw new RefinementDispatchError(
      "Project not found",
      404,
      "PROJECT_NOT_FOUND",
    );
  }

  const active = getActiveRefinementSession(input.projectId);
  if (active) {
    throw new RefinementDispatchError(
      "A board refinement pass is already running for this project.",
      409,
      "REFINEMENT_ALREADY_RUNNING",
      active.id,
    );
  }

  const snapshot = loadRefinementSnapshot(input.projectId);
  const ticketCount = snapshotSize(snapshot);
  if (ticketCount === 0) {
    return { skipped: true, reason: REFINEMENT_EMPTY_BOARD_REASON };
  }

  const systemPrompt = await resolveAgentPrompt(
    REFINEMENT_AGENT_TYPE,
    input.projectId,
  );
  const prompt = buildRefinementPrompt(project, snapshot, systemPrompt);
  // No dispatch context: that argument exists for review-provider
  // segregation, and a planning pass has no builder to be segregated from.
  const resolvedAgent = await resolveAgentForDispatch(
    REFINEMENT_AGENT_TYPE,
    input.projectId,
    input.namedAgentId ?? null,
  );

  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");
  const cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
    ? crypto.randomUUID()
    : undefined;
  const cwd = project.gitRepoPath || process.cwd();

  createQueuedSession({
    id: sessionId,
    projectId: input.projectId,
    // No epicId: the pass is board-scoped. This is also what forces every
    // MCP call to name its ticket rather than defaulting to one.
    epicId: null,
    userStoryId: null,
    // Code mode so the pass can call the mutating refinement tools — its
    // entire deliverable — which plan mode refuses. The prompt forbids
    // touching the repository.
    mode: "code",
    provider: resolvedAgent.provider,
    prompt,
    logsPath,
    worktreePath: cwd,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    namedAgentName: resolvedAgent.name ?? null,
    model: resolvedAgent.model ?? null,
    agentType: REFINEMENT_AGENT_TYPE,
    createdAt: now,
  });

  let settle!: (result: RefinementSessionResult) => void;
  const settled = new Promise<RefinementSessionResult>((resolve) => {
    settle = resolve;
  });

  agentScheduler.submit(input.projectId, sessionId, async () => {
    let terminal: RefinementSessionResult = {
      sessionId,
      success: false,
      outcome: null,
      error: "Refinement session did not run",
      report: null,
      summary: null,
    };

    try {
      markSessionRunning(sessionId);
      processManager.start(
        sessionId,
        {
          mode: "code",
          prompt,
          cwd,
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
      const success = Boolean(result?.success);
      const error = success
        ? null
        : (result?.error ??
          "The refinement session failed without reporting an error.");

      try {
        markSessionTerminal(
          sessionId,
          { success, error, outcome, usage: extractSessionUsage(result) },
          completedAt,
        );
      } catch (lifecycleError) {
        if (!isSessionLifecycleConflictError(lifecycleError)) {
          console.error("[refinement] Failed to finalize session", lifecycleError);
        }
      }

      // The report is published for failed runs too: whatever the pass
      // managed to change is already on the board, and unexplained movement
      // is worse than a partial report.
      const published = publishRefinementReport({
        projectId: input.projectId,
        sessionId,
        succeeded: success,
      });

      terminal = {
        sessionId,
        success,
        outcome,
        error,
        report: published.report,
        summary: published.summary,
      };
    } catch (error) {
      // A throw here (launch failure, or waitForProcessCompletion rejecting
      // mid-run) can still leave board writes behind, and the same argument
      // as the success path applies: unexplained movement is worse than a
      // partial report. Publishing here also drains the change registry,
      // which is what bounds it — a session whose entries are never taken
      // stays resident for the life of the process.
      let published: ReturnType<typeof publishRefinementReport> | null = null;
      try {
        published = publishRefinementReport({
          projectId: input.projectId,
          sessionId,
          succeeded: false,
        });
      } catch (reportError) {
        console.error(
          "[refinement] Failed to publish report after launch failure",
          reportError,
        );
        // Drain regardless, so the registry cannot leak this session's key.
        takeRefinementChanges(sessionId);
      }

      terminal = {
        sessionId,
        success: false,
        outcome: "error",
        error:
          error instanceof Error ? error.message : "Refinement launch failed",
        report: published?.report ?? null,
        summary: published?.summary ?? null,
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
    ticketCount,
    settled,
  };
}
