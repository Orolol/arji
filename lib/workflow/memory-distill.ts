/**
 * Learned project memory — distillation workflow.
 *
 * A 'memory_distill' agent session reads the current memory document plus the
 * just-finished session's context and rewrites the memory (merge durable
 * conventions, drop per-ticket trivia, stay under the hard cap). Its result
 * replaces the memory document.
 *
 * Two triggers share `dispatchMemoryDistillSession`:
 *   - manual: POST /api/projects/[projectId]/memory/distill (button on a
 *     completed session's detail page);
 *   - auto: `maybeAutoDistillAfterSessionTerminal`, invoked from the
 *     boot-registered session terminal hook (instrumentation.ts →
 *     lib/agent-sessions/terminal-hooks.ts) when the 'memory_auto_distill'
 *     setting is on. Guards: build-type source sessions only, never a
 *     distill-of-a-distill, never on failures, and no duplicate while a
 *     distill is already pending for the project.
 *
 * Dispatch goes through the per-project agent scheduler with the normal
 * session lifecycle (queued → running → terminal), like every other
 * batch-style agent.
 *
 * Batch attribution: when the source session carries a `batch_run_id` (a DAG
 * batch or a night run), the distill session inherits it. Otherwise a night
 * run's auto-distills would spend real money outside its cost cap and go
 * missing from the morning summary — both of which read `batch_run_id` and
 * nothing else, so the tag alone wires them up.
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  settings,
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
import { extractLastNonEmptyTextFromFile } from "@/lib/agent-sessions/last-text";
import { buildMemoryDistillPrompt } from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import {
  getProjectMemoryContent,
  saveProjectMemory,
} from "@/lib/documents/memory";
import {
  MEMORY_AUTO_DISTILL_SETTING_KEY,
  parseMemoryAutoDistillSetting,
} from "@/lib/documents/memory-constants";
import { MEMORY_WRITER_AGENT_TYPES } from "./dreaming-constants";
import { logTransition } from "./log";

const POLL_INTERVAL_MS = 2000;

/** Cap on the source-session result summary embedded in the distill prompt. */
export const MEMORY_DISTILL_SUMMARY_MAX_CHARS = 2000;

/** Activity-log reason written when a distill run replaces the memory doc. */
export const MEMORY_UPDATED_REASON = "Project memory updated";

/**
 * Source agent types eligible for auto-distillation: the build flavors.
 * Reviews, QA, merges and (critically) the memory writers themselves
 * ('memory_distill', 'dreaming') never auto-trigger.
 */
export const AUTO_DISTILL_SOURCE_AGENT_TYPES: readonly string[] = [
  "build",
  "ticket_build",
  "team_build",
];

/** Reads the 'memory_auto_distill' setting (DEFAULT OFF when absent). */
export function isMemoryAutoDistillEnabled(): boolean {
  try {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, MEMORY_AUTO_DISTILL_SETTING_KEY))
      .get();
    return row ? parseMemoryAutoDistillSetting(row.value) : false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auto-trigger guards
// ---------------------------------------------------------------------------

export interface AutoDistillCandidateSession {
  id: string;
  projectId: string | null;
  agentType: string | null;
  status: string | null;
  outcome: string | null;
}

export interface AutoDistillDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Pure guard matrix for the auto-trigger — exported for exhaustive testing.
 *
 * Denials, in evaluation order:
 *   - setting off (default),
 *   - unknown session,
 *   - non-completed status (failures/cancellations never distill),
 *   - a memory WRITER source ('memory_distill' or 'dreaming' — never distill
 *     a distill, never distill a dream),
 *   - non-build agent types,
 *   - asked_question outcome (the build is still awaiting the user — its
 *     learnings are not settled yet),
 *   - a distill already queued/running for the project (dedup under waves).
 */
export function evaluateAutoDistillGuards(input: {
  enabled: boolean;
  session: AutoDistillCandidateSession | null;
  hasPendingDistill: boolean;
}): AutoDistillDecision {
  if (!input.enabled) {
    return { allowed: false, reason: "auto-distill setting is off" };
  }
  if (!input.session) {
    return { allowed: false, reason: "session not found" };
  }
  if (input.session.status !== "completed") {
    return {
      allowed: false,
      reason: `session status is '${input.session.status ?? "unknown"}', not 'completed'`,
    };
  }
  if (
    input.session.agentType &&
    MEMORY_WRITER_AGENT_TYPES.includes(input.session.agentType)
  ) {
    return { allowed: false, reason: "never distill a distill session" };
  }
  if (
    !input.session.agentType ||
    !AUTO_DISTILL_SOURCE_AGENT_TYPES.includes(input.session.agentType)
  ) {
    return {
      allowed: false,
      reason: `agent type '${input.session.agentType ?? "unknown"}' is not a build type`,
    };
  }
  if (input.session.outcome === "asked_question") {
    return { allowed: false, reason: "session ended by asking a question" };
  }
  if (!input.session.projectId) {
    return { allowed: false, reason: "session has no project" };
  }
  if (input.hasPendingDistill) {
    return {
      allowed: false,
      reason: "a memory distill session is already pending for this project",
    };
  }
  return { allowed: true, reason: "eligible" };
}

/** True when a 'memory_distill' session is queued/running for the project. */
export function hasPendingMemoryDistill(projectId: string): boolean {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, "memory_distill"),
        inArray(agentSessions.status, ["queued", "running"])
      )
    )
    .get();
  return !!row;
}

/**
 * Auto-trigger entry point, invoked (fire-and-forget) from the session
 * terminal hook for completed sessions. Best-effort by design: it must never
 * throw into the lifecycle transition, and every denial is silent except for
 * unexpected errors.
 */
export async function maybeAutoDistillAfterSessionTerminal(
  sessionId: string
): Promise<AutoDistillDecision> {
  try {
    // Cheapest check first — the feature is off by default.
    const enabled = isMemoryAutoDistillEnabled();
    if (!enabled) {
      return { allowed: false, reason: "auto-distill setting is off" };
    }

    const session =
      db
        .select({
          id: agentSessions.id,
          projectId: agentSessions.projectId,
          agentType: agentSessions.agentType,
          status: agentSessions.status,
          outcome: agentSessions.outcome,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get() ?? null;

    const decision = evaluateAutoDistillGuards({
      enabled,
      session,
      hasPendingDistill: session?.projectId
        ? hasPendingMemoryDistill(session.projectId)
        : false,
    });

    if (!decision.allowed) {
      return decision;
    }

    await dispatchMemoryDistillSession({
      projectId: session!.projectId!,
      sourceSessionId: sessionId,
    });
    return decision;
  } catch (err) {
    console.warn(
      "[memory-distill] Auto-distill trigger failed:",
      (err as Error).message
    );
    return { allowed: false, reason: "auto-distill trigger failed" };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchMemoryDistillInput {
  projectId: string;
  /** Session whose learnings should be distilled (context source). */
  sourceSessionId?: string | null;
  /** Optional explicit named agent (manual dispatch). */
  namedAgentId?: string | null;
}

export interface DispatchMemoryDistillResult {
  sessionId: string;
}

interface SourceSessionContext {
  epicId: string | null;
  ticketTitle: string | null;
  agentType: string | null;
  outcome: string | null;
  resultSummary: string | null;
  /**
   * Batch/night run that owns the source session. Inherited by the distill
   * session so its cost is counted by the night run's cost cap and by the
   * morning summary — both query purely on `agent_sessions.batch_run_id`, so
   * tagging the row is the ENTIRE integration.
   */
  batchRunId: string | null;
}

function loadSourceSessionContext(
  projectId: string,
  sourceSessionId: string
): SourceSessionContext | null {
  const session = db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      agentType: agentSessions.agentType,
      outcome: agentSessions.outcome,
      lastNonEmptyText: agentSessions.lastNonEmptyText,
      logsPath: agentSessions.logsPath,
      batchRunId: agentSessions.batchRunId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sourceSessionId),
        eq(agentSessions.projectId, projectId)
      )
    )
    .get();

  if (!session) return null;

  let ticketTitle: string | null = null;
  if (session.userStoryId) {
    ticketTitle =
      db
        .select({ title: userStories.title })
        .from(userStories)
        .where(eq(userStories.id, session.userStoryId))
        .get()?.title ?? null;
  }
  if (!ticketTitle && session.epicId) {
    ticketTitle =
      db
        .select({ title: epics.title })
        .from(epics)
        .where(eq(epics.id, session.epicId))
        .get()?.title ?? null;
  }

  // Last textual output — same machinery the rest of the app uses:
  // the streamed `lastNonEmptyText` column first, then the logs file.
  let resultSummary: string | null = session.lastNonEmptyText ?? null;
  if (!resultSummary) {
    try {
      resultSummary = extractLastNonEmptyTextFromFile(session.logsPath);
    } catch {
      resultSummary = null;
    }
  }
  if (resultSummary && resultSummary.length > MEMORY_DISTILL_SUMMARY_MAX_CHARS) {
    resultSummary = resultSummary.slice(0, MEMORY_DISTILL_SUMMARY_MAX_CHARS);
  }

  return {
    epicId: session.epicId ?? null,
    ticketTitle,
    agentType: session.agentType ?? null,
    outcome: session.outcome ?? null,
    resultSummary,
    batchRunId: session.batchRunId ?? null,
  };
}

/**
 * Strips an accidental full-document code fence from the agent's output
 * (the prompt forbids fences, but a cheap unwrap beats a corrupted doc).
 */
export function sanitizeDistilledMemory(output: string): string {
  const trimmed = output.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Creates a queued 'memory_distill' session and submits its launch closure to
 * the per-project scheduler. On success (outcome 'answered'), the session's
 * output replaces the project memory document (cap-enforced) and — when the
 * source session was ticket-scoped — an actor-'system' activity-log entry
 * records the update.
 *
 * Throws when the project does not exist; every failure after dispatch
 * surfaces on the session row instead.
 */
export async function dispatchMemoryDistillSession(
  input: DispatchMemoryDistillInput
): Promise<DispatchMemoryDistillResult> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) {
    throw new Error("Project not found");
  }

  const sourceContext = input.sourceSessionId
    ? loadSourceSessionContext(input.projectId, input.sourceSessionId)
    : null;

  const currentMemory = getProjectMemoryContent(input.projectId);
  const systemPrompt = await resolveAgentPrompt("memory_distill", input.projectId);
  const resolvedAgent = resolveAgentByNamedId(
    "memory_distill",
    input.projectId,
    input.namedAgentId ?? null
  );

  const prompt = buildMemoryDistillPrompt(
    // Explicit `memory` stops the builder-level injection from re-adding the
    // doc this prompt already frames as "Current Project Memory".
    { ...project, memory: null },
    currentMemory,
    {
      ticketTitle: sourceContext?.ticketTitle ?? null,
      agentType: sourceContext?.agentType ?? null,
      outcome: sourceContext?.outcome ?? null,
      resultSummary: sourceContext?.resultSummary ?? null,
    },
    systemPrompt
  );

  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");
  const cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
    ? crypto.randomUUID()
    : undefined;

  // Deliberately no epicId on the distill session row: epic-scoped
  // concurrency guards must not treat a background distill as "an agent is
  // already running for this epic". The activity log below still anchors to
  // the source ticket.
  //
  // batchRunId IS inherited though: a distill auto-triggered by a night-run
  // build is work that run caused, so its cost must land inside the run's
  // cost cap and morning summary instead of escaping both. (No epicId means
  // the summary counts it in the run total, not against a single epic.)
  createQueuedSession({
    id: sessionId,
    projectId: input.projectId,
    mode: "plan",
    provider: resolvedAgent.provider,
    prompt,
    logsPath,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType: "memory_distill",
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
    batchRunId: sourceContext?.batchRunId ?? null,
    createdAt: now,
  });

  agentScheduler.submit(input.projectId, sessionId, async () => {
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
        console.error("[memory-distill] Failed to finalize session", error);
      }
    }

    // Only a delivered answer replaces the memory doc — silent runs, asked
    // questions, and failures leave it untouched.
    if (!result?.success || outcome !== "answered") {
      return;
    }

    const output = sanitizeDistilledMemory(
      resolveSessionOutput(result, sessionId, "")
    );
    if (!output) {
      return;
    }

    try {
      saveProjectMemory(input.projectId, output);
    } catch (error) {
      console.error(
        "[memory-distill] Failed to save distilled memory",
        error
      );
      return;
    }

    if (sourceContext?.epicId) {
      const epicStatus =
        db
          .select({ status: epics.status })
          .from(epics)
          .where(eq(epics.id, sourceContext.epicId))
          .get()?.status ?? "done";
      // from == to: nothing moved, the entry records the memory update
      // (same auditing pattern as the asked_question hold).
      logTransition({
        projectId: input.projectId,
        epicId: sourceContext.epicId,
        fromStatus: epicStatus,
        toStatus: epicStatus,
        actor: "system",
        reason: MEMORY_UPDATED_REASON,
        sessionId,
      });
    }
  });

  return { sessionId };
}
