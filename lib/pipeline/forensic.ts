/**
 * Autonomous pipeline — forensic agent dispatch.
 *
 * Last step of a doomed pipeline run: when a stage has burned its whole
 * retry ladder, the runner asks for a post-mortem instead of silently
 * marking the run failed. A cheap 'forensic' agent reads the dead session's
 * leftovers (error, chunk tails, last text) and posts a short diagnostic as
 * an agent ticket comment. It NEVER changes a ticket status, never resolves
 * findings, and never touches the code.
 *
 * Shape mirrors `dispatchMemoryDistillSession` (lib/workflow/memory-distill.ts):
 * a queued session submitted to the per-project scheduler, running the
 * normal lifecycle (queued → running → terminal), deliberately WITHOUT an
 * epicId on the row so the epic/story concurrency guards keep treating the
 * ticket as free — a human must be able to re-dispatch it while forensics
 * are still running.
 *
 * Guard rails ("a forensic run is a dead end"):
 *   - it never runs on another forensic session (no forensic-of-a-forensic),
 *   - agentType 'forensic' is not in AUTO_DISTILL_SOURCE_AGENT_TYPES, so the
 *     memory auto-distill hook ignores it,
 *   - it is dispatched from this library only — never from a build route —
 *     so the `pipeline` request flag can never start a pipeline for it, and
 *     the runner treats the forensic stage as terminal (no retry ladder).
 *
 * Every failure is swallowed: `runForensic` never throws and its `settled`
 * promise never rejects. A missing diagnostic must not change how the
 * pipeline run ends.
 */

import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { agentScheduler } from "@/lib/agents/scheduler";
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
import {
  listSessionChunks,
  type AgentSessionStreamType,
} from "@/lib/agent-sessions/chunks";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import { getProjectMemoryContent } from "@/lib/documents/memory";
import { logTransition } from "@/lib/workflow/log";
import {
  FORENSIC_OUTPUT_TAIL_MAX_CHARS,
  FORENSIC_RAW_TAIL_MAX_CHARS,
  PIPELINE_REASONS,
} from "./constants";
import { buildForensicPrompt } from "./forensic-prompt";
import type { PipelineStageResult } from "./runner";

const POLL_INTERVAL_MS = 2000;

/**
 * Tails of the dead session's streams handed to the forensic agent. Defined
 * in the client-safe pipeline constants and re-exported here, where every
 * existing caller reads them: the retention pruner derives what it keeps from
 * these numbers, and importing this module for them would drag the scheduler
 * and the process manager with it.
 */
export {
  FORENSIC_OUTPUT_TAIL_MAX_CHARS,
  FORENSIC_RAW_TAIL_MAX_CHARS,
} from "./constants";

/** Heading the diagnostic comment is filed under. */
export const FORENSIC_COMMENT_HEADING = "**Forensic diagnostic**";

/**
 * Machine-readable link from a diagnostic back to the session it diagnoses.
 *
 * `ticket_comments.agent_session_id` already points at the FORENSIC session —
 * the one that wrote the comment — so nothing recorded which session died.
 * Readers were left inferring it from timestamps, which breaks whenever the
 * forensic agent is slow or queued: the comment lands long after the run it is
 * about, and a time-window match either misses it or hands it to the wrong
 * rerun. An HTML comment keeps the link durable and exact while staying
 * invisible in rendered markdown.
 *
 * Consumed by the Dreaming digest (lib/workflow/dreaming.ts).
 */
export function forensicDeadSessionMarker(deadSessionId: string): string {
  return `<!-- arij:dead-session=${deadSessionId} -->`;
}

/** Extracts the diagnosed session id from a comment body, or null. */
export function parseForensicDeadSessionId(content: string): string | null {
  const match = content.match(/<!--\s*arij:dead-session=([^\s>]+?)\s*-->/);
  return match ? match[1] : null;
}

/**
 * Activity-log reason written once a diagnostic lands — the shared trace
 * string (lib/pipeline/constants.ts), so the feed renders it like every
 * other pipeline entry.
 */
export const FORENSIC_POSTED_REASON = PIPELINE_REASONS.forensic;

/**
 * The pipeline's pinned per-stage result shape (I2). Aliased from the runner
 * (type-only import, no runtime dependency) so the two can never drift; the
 * old name is kept for this module's existing tests and callers.
 */
export type ForensicStageResult = PipelineStageResult;

export interface RunForensicInput {
  projectId: string;
  epicId: string;
  userStoryId: string | null;
  /** Session that exhausted its retry ladder. */
  deadSessionId: string;
  stage: "build" | "grading" | "review" | "fix";
  /** Attempts burned on that stage. */
  attempts: number;
  /**
   * Batch/night run that owns the dooming pipeline; stamped on the forensic
   * session row (agent_sessions.batch_run_id). Null for standalone runs.
   */
  batchRunId?: string | null;
}

export interface RunForensicResult {
  /** Forensic session id, or null when dispatch was refused/threw. */
  sessionId: string | null;
  /** Never rejects; resolves when the forensic session reaches a terminal state. */
  settled: Promise<ForensicStageResult>;
}

function refused(error: string): RunForensicResult {
  return {
    sessionId: null,
    settled: Promise.resolve({
      sessionId: "",
      success: false,
      outcome: null,
      error,
    }),
  };
}

/**
 * Concatenates a session's chunk stream and keeps the LAST `maxChars`
 * characters — failures live at the end of a log, not at its start. Returns
 * null when the stream is empty (a session that died before emitting a
 * single chunk is a normal, and informative, case).
 */
export function readChunkTail(
  sessionId: string,
  streamType: AgentSessionStreamType,
  maxChars: number
): string | null {
  let joined: string;
  try {
    joined = listSessionChunks(sessionId, streamType)
      .map((chunk) => chunk.content)
      .join("");
  } catch {
    return null;
  }
  if (!joined.trim()) return null;
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

interface DeadSessionRow {
  id: string;
  projectId: string | null;
  agentType: string | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  lastNonEmptyText: string | null;
}

function loadDeadSession(
  projectId: string,
  deadSessionId: string
): DeadSessionRow | null {
  return (
    db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        agentType: agentSessions.agentType,
        provider: agentSessions.provider,
        model: agentSessions.model,
        error: agentSessions.error,
        lastNonEmptyText: agentSessions.lastNonEmptyText,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, deadSessionId),
          eq(agentSessions.projectId, projectId)
        )
      )
      .get() ?? null
  );
}

function loadTicketTitle(
  epicId: string,
  userStoryId: string | null
): string | null {
  if (userStoryId) {
    const story = db
      .select({ title: userStories.title })
      .from(userStories)
      .where(eq(userStories.id, userStoryId))
      .get();
    if (story?.title) return story.title;
  }
  return (
    db.select({ title: epics.title }).from(epics).where(eq(epics.id, epicId)).get()
      ?.title ?? null
  );
}

/**
 * Dispatches the forensic diagnostic for a dead stage session.
 *
 * Returns synchronously-resolvable refusal (`sessionId: null`) when the
 * dispatch cannot happen at all — unknown project/session, or a dead session
 * that is itself a forensic run. Otherwise the session is queued through the
 * scheduler and `settled` resolves once it reaches a terminal state.
 */
export async function runForensic(
  input: RunForensicInput
): Promise<RunForensicResult> {
  try {
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .get();
    if (!project) {
      return refused("Project not found");
    }

    const dead = loadDeadSession(input.projectId, input.deadSessionId);
    if (!dead) {
      return refused("Dead session not found");
    }
    // Hard stop on recursion: a forensic run that fails is simply reported,
    // never analysed by another forensic agent.
    if (dead.agentType === "forensic") {
      return refused("Never run a forensic on a forensic session");
    }

    const prompt = buildForensicPrompt({
      project: {
        name: project.name,
        description: project.description,
        memory: getProjectMemoryContent(input.projectId),
      },
      ticketTitle: loadTicketTitle(input.epicId, input.userStoryId),
      stage: input.stage,
      attempts: input.attempts,
      provider: dead.provider,
      model: dead.model,
      error: dead.error,
      rawTail: readChunkTail(
        input.deadSessionId,
        "raw",
        FORENSIC_RAW_TAIL_MAX_CHARS
      ),
      outputTail: readChunkTail(
        input.deadSessionId,
        "output",
        FORENSIC_OUTPUT_TAIL_MAX_CHARS
      ),
      lastText: dead.lastNonEmptyText,
      systemPrompt: await resolveAgentPrompt("forensic", input.projectId),
    });

    // Cheap-model selection is entirely the user's: bind agentType
    // 'forensic' to a cheap named agent in the Agent Config panel and the
    // standard resolution chain (project → global → builtin) picks it up.
    const resolvedAgent = resolveAgentByNamedId(
      "forensic",
      input.projectId,
      null
    );

    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");
    const cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
      ? crypto.randomUUID()
      : undefined;

    // No epicId/userStoryId on the row (same rationale as memory_distill):
    // the epic/story concurrency guards must not see a background diagnostic
    // as "an agent is already working on this ticket". The diagnostic comment
    // and the activity entry still anchor to the ticket.
    createQueuedSession({
      id: sessionId,
      projectId: input.projectId,
      mode: "plan",
      provider: resolvedAgent.provider,
      prompt,
      logsPath,
      cliSessionId,
      namedAgentId: resolvedAgent.namedAgentId ?? null,
      agentType: "forensic",
      namedAgentName: resolvedAgent.name || null,
      model: resolvedAgent.model || null,
      batchRunId: input.batchRunId ?? null,
      createdAt: now,
    });

    let settle: (result: ForensicStageResult) => void = () => {};
    const settled = new Promise<ForensicStageResult>((resolve) => {
      settle = resolve;
    });

    agentScheduler.submit(input.projectId, sessionId, async () => {
      let stageResult: ForensicStageResult = {
        sessionId,
        success: false,
        outcome: null,
        error: "Forensic session did not run",
      };

      try {
        markSessionRunning(sessionId);

        processManager.start(
          sessionId,
          {
            mode: "plan",
            prompt,
            cwd: project.gitRepoPath || process.cwd(),
            model: resolvedAgent.model,
            cliSessionId,
          },
          resolvedAgent.provider
        );

        const info = await waitForProcessCompletion(sessionId, POLL_INTERVAL_MS);
        const completedAt = new Date().toISOString();
        const result = info?.result;

        try {
          fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
        } catch {
          // Best-effort log write.
        }

        const outcome = classifySessionOutcome(result, sessionId);
        stageResult = {
          sessionId,
          success: !!result?.success,
          outcome,
          error: result?.error ?? null,
        };

        try {
          markSessionTerminal(
            sessionId,
            {
              success: !!result?.success,
              error: result?.error ?? null,
              outcome,
              usage: extractSessionUsage(result),
            },
            completedAt
          );
        } catch (error) {
          if (!isSessionLifecycleConflictError(error)) {
            console.error("[forensic] Failed to finalize session", error);
          }
        }

        if (!result?.success) {
          return;
        }

        const diagnostic = resolveSessionOutput(result, sessionId, "").trim();
        if (!diagnostic) {
          // A silent forensic agent has nothing to say — no empty comment.
          return;
        }

        postForensicDiagnostic({
          projectId: input.projectId,
          epicId: input.epicId,
          userStoryId: input.userStoryId,
          sessionId,
          deadSessionId: input.deadSessionId,
          diagnostic,
          createdAt: completedAt,
        });
      } catch (error) {
        stageResult = {
          sessionId,
          success: false,
          outcome: "error",
          error: (error as Error).message,
        };
        // Rethrown so the scheduler's safety net finalizes the session row;
        // `settle` in the finally block keeps the caller's promise resolved.
        throw error;
      } finally {
        settle(stageResult);
      }
    });

    return { sessionId, settled };
  } catch (error) {
    console.warn("[forensic] Dispatch failed:", (error as Error).message);
    return refused((error as Error).message);
  }
}

/**
 * Files the diagnostic as an agent ticket comment (+ an actor-'system'
 * activity entry pinned to the epic, from == to: the pipeline never moves a
 * ticket because of a forensic run). Best-effort — a failed write must not
 * break the caller.
 */
export function postForensicDiagnostic(input: {
  projectId: string;
  epicId: string;
  userStoryId: string | null;
  /** The forensic session that produced the diagnostic. */
  sessionId: string;
  /** The session the diagnostic is ABOUT (see forensicDeadSessionMarker). */
  deadSessionId?: string | null;
  diagnostic: string;
  createdAt?: string;
}): void {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const marker = input.deadSessionId
    ? `\n${forensicDeadSessionMarker(input.deadSessionId)}`
    : "";
  try {
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId: input.epicId,
        userStoryId: input.userStoryId,
        author: "agent",
        content: `${FORENSIC_COMMENT_HEADING}${marker}\n\n${input.diagnostic}`,
        agentSessionId: input.sessionId,
        createdAt,
      })
      .run();
  } catch (error) {
    console.error("[forensic] Failed to post diagnostic comment", error);
    return;
  }

  const epicStatus =
    db
      .select({ status: epics.status })
      .from(epics)
      .where(eq(epics.id, input.epicId))
      .get()?.status ?? "in_progress";

  logTransition({
    projectId: input.projectId,
    epicId: input.epicId,
    fromStatus: epicStatus,
    toStatus: epicStatus,
    actor: "system",
    reason: FORENSIC_POSTED_REASON,
    sessionId: input.sessionId,
  });
}
