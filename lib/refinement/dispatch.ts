/**
 * Board refinement dispatch.
 *
 * A refinement run is project-scoped, not ticket-scoped: the session row
 * carries no epicId, so every MCP call it makes names its target explicitly
 * and its token cannot default to "the ticket I was launched for". That is
 * also why it needs no worktree — it produces no code, so it runs directly in
 * the project's checkout. That checkout is the user's own, which is why the
 * no-edit rule here is enforced by the permission mode rather than left to a
 * prompt sentence (review and grading get code mode, but inside an epic
 * worktree where a stray edit lands on a feature branch).
 *
 * Chat mode: the pass's entire deliverable is mutating MCP calls (which plan
 * mode refuses), but it must not carry write access into the user's checkout
 * the way code mode's bypassPermissions would. See the mode comment on
 * createQueuedSession below.
 *
 * The dispatcher also refuses outright when the resolved provider cannot
 * carry the MCP channel: a refinement run without tools is a silent no-op
 * that would report "the board was already in shape".
 */
import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, projects, namedAgents } from "@/lib/db/schema";
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
import {
  isMcpToolsEnabled,
  providerSupportsMcp,
} from "@/lib/claude/mcp-injection";
import { refinementOptionsSchema, REFINEMENT_ACTION_IDS, type RefinementOptions } from "./options";
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

export interface DispatchRefinementInput extends RefinementOptions {
  projectId: string;
}

/**
 * Create and schedule one board refinement session, or return the skip when
 * there is nothing in the planning columns to refine.
 */
export async function dispatchRefinementSession(
  input: DispatchRefinementInput,
): Promise<DispatchRefinementResult> {
  const { projectId: _projectId, ...rawOptions } = input;
  const parsed = refinementOptionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw new RefinementDispatchError("Invalid refinement options", 400, "INVALID_REFINEMENT_OPTIONS");
  }
  const options = parsed.data;
  const actions = options.actions ?? [...REFINEMENT_ACTION_IDS];
  if (options.namedAgentId && !db.select({ id: namedAgents.id }).from(namedAgents)
    .where(eq(namedAgents.id, options.namedAgentId)).get()) {
    throw new RefinementDispatchError("Selected agent no longer exists", 404, "AGENT_NOT_FOUND");
  }

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
  const prompt = buildRefinementPrompt(project, snapshot, systemPrompt, options);
  // No dispatch context: that argument exists for review-provider
  // segregation, and a planning pass has no builder to be segregated from.
  const resolvedAgent = await resolveAgentForDispatch(
    REFINEMENT_AGENT_TYPE,
    input.projectId,
    options.namedAgentId ?? null,
  );

  // The pass's entire deliverable is mutating MCP calls, but the tool channel
  // is capability-gated to claude-code/codex and can be switched off globally.
  // Without it the session spawns, can call nothing, ends — and the report
  // would raise a *completed* notification reading "no changes — the board
  // was already in shape", which is affirmatively false: the board was never
  // judged. Refuse before the session row exists, the way the Full Auto
  // second opinion refuses rather than emit a verdict it did not reach.
  if (!isMcpToolsEnabled()) {
    throw new RefinementDispatchError(
      "Board refinement needs the Arij MCP tool channel, which is disabled (setting `mcp_tools_enabled`).",
      409,
      "MCP_TOOLS_DISABLED",
    );
  }
  if (!providerSupportsMcp(resolvedAgent.provider)) {
    throw new RefinementDispatchError(
      `Board refinement needs an MCP-capable provider; ${resolvedAgent.provider} cannot receive Arij's board tools. Assign a Claude Code or Codex agent to the refinement role.`,
      409,
      "PROVIDER_NOT_MCP_CAPABLE",
    );
  }

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
    // Chat mode. The three-way choice matters here because this session runs
    // in the user's PRIMARY checkout (no worktree, no branch):
    //   - plan refuses mutating MCP tools, which are the whole deliverable;
    //   - code means bypassPermissions, under which --allowedTools stops
    //     restricting anything — Edit/Write/Bash auto-approved in the user's
    //     working tree, with only a prompt sentence forbidding repo writes;
    //   - chat is permission-mode "default" with a read-only allowlist, so
    //     allowlisted MCP tools are auto-approved and everything else is
    //     denied headlessly (see lib/claude/spawn.ts). Codex maps it to
    //     `-s read-only` and still gets the MCP overrides.
    // Chat is the only one that gives the board tools without pointing write
    // access at the user's checkout.
    mode: "chat",
    provider: resolvedAgent.provider,
    prompt,
    logsPath,
    worktreePath: cwd,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    namedAgentName: resolvedAgent.name ?? null,
    model: resolvedAgent.model ?? null,
    agentType: REFINEMENT_AGENT_TYPE,
    refinementActions: JSON.stringify(actions),
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
          // Must match the persisted session mode — see createQueuedSession.
          mode: "chat",
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
