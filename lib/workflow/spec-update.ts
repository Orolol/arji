/**
 * Agent-run project specification updates.
 *
 * The "Mettre à jour la spec" action on the Spec view dispatches a plan-mode
 * session (same lifecycle as the memory distill: queued session row +
 * per-project scheduler closure). The agent's ENTIRE output is the
 * replacement spec markdown; it is persisted onto `projects.spec` only when
 * the session actually delivers an answer, so a failed run never touches the
 * stored spec.
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, projects } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { buildSpecUpdatePrompt } from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { agentScheduler } from "@/lib/agents/scheduler";
import { tryExportArjiJson } from "@/lib/sync/export";

const POLL_INTERVAL_MS = 2000;

/** Sessions of this type queued/running block a new dispatch (see route 409). */
const SPEC_UPDATE_AGENT_TYPE = "spec_generation";

export interface DispatchSpecUpdateInput {
  projectId: string;
  /** Optional user instruction steering the update; null/empty = general refresh. */
  instruction: string | null;
  /** Optional named agent override (the Spec view's agent dropdown). */
  namedAgentId: string | null;
}

export interface DispatchSpecUpdateResult {
  sessionId: string;
}

/** True when a spec update session is queued/running for the project. */
export function hasPendingSpecUpdate(projectId: string): boolean {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, SPEC_UPDATE_AGENT_TYPE),
        inArray(agentSessions.status, ["queued", "running"])
      )
    )
    .get();
  return !!row;
}

/**
 * Strips an accidental full-document code fence from the agent's output
 * (the prompt forbids fences, but a cheap unwrap beats a corrupted doc).
 */
export function sanitizeUpdatedSpec(output: string): string {
  const trimmed = output.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Creates a queued spec update session and submits its launch closure to the
 * per-project scheduler. Resolves with the session id immediately; the spec
 * lands in the database when the closure finishes.
 */
export async function dispatchSpecUpdateSession(
  input: DispatchSpecUpdateInput
): Promise<DispatchSpecUpdateResult> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) {
    throw new Error("Project not found");
  }

  const systemPrompt = await resolveAgentPrompt(
    SPEC_UPDATE_AGENT_TYPE,
    input.projectId
  );
  const resolvedAgent = resolveAgentByNamedId(
    SPEC_UPDATE_AGENT_TYPE,
    input.projectId,
    input.namedAgentId
  );
  const prompt = buildSpecUpdatePrompt(
    // Plain row: `id` lets the builder resolve the learned project memory
    // itself, the same way every other dispatch route feeds the builders.
    project,
    input.instruction,
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

  // Deliberately no epicId: like the memory distill, a spec update is a
  // project-level background run and must not occupy an epic's concurrency
  // slot or anchor to a ticket.
  createQueuedSession({
    id: sessionId,
    projectId: input.projectId,
    mode: "plan",
    provider: resolvedAgent.provider,
    prompt,
    logsPath,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType: SPEC_UPDATE_AGENT_TYPE,
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
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
        console.error("[spec-update] Failed to finalize session", error);
      }
    }

    // Only a delivered answer replaces the spec — silent runs, asked
    // questions, and failures leave it untouched.
    if (!result?.success || outcome !== "answered") {
      return;
    }

    const output = sanitizeUpdatedSpec(
      resolveSessionOutput(result, sessionId, "")
    );
    if (!output) {
      return;
    }

    try {
      db.update(projects)
        .set({ spec: output, updatedAt: completedAt })
        .where(eq(projects.id, input.projectId))
        .run();
    } catch (error) {
      console.error("[spec-update] Failed to save updated spec", error);
      return;
    }

    tryExportArjiJson(input.projectId);
  });

  return { sessionId };
}
