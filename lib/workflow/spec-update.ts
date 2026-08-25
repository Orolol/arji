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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, epics, namedAgents, projects, releases, userStories } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { buildProjectStateSection, buildSpecUpdatePrompt } from "@/lib/claude/prompt-builder";
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

/**
 * Thrown when the picked named agent no longer exists (a stale dropdown
 * selection). resolveAgentByNamedId would silently fall back to the default
 * chain and run the update with a different agent than the user chose, so
 * dispatch rejects first; the route maps this to a 400 the dialog displays.
 */
export class SpecUpdateAgentNotFoundError extends Error {
  readonly namedAgentId: string;

  constructor(namedAgentId: string) {
    super(
      "The selected agent no longer exists. Pick another agent and try again."
    );
    this.name = "SpecUpdateAgentNotFoundError";
    this.namedAgentId = namedAgentId;
  }
}

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

/** Returns the active (queued or running) spec update session for the project, if any. */
export function getPendingSpecUpdateSession(
  projectId: string
): { id: string; status: string | null } | null {
  const row = db
    .select({ id: agentSessions.id, status: agentSessions.status })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, SPEC_UPDATE_AGENT_TYPE),
        inArray(agentSessions.status, ["queued", "running"])
      )
    )
    .get();
  return row ?? null;
}

/** True when a spec update session is queued/running for the project. */
export function hasPendingSpecUpdate(projectId: string): boolean {
  return Boolean(getPendingSpecUpdateSession(projectId));
}

/**
 * Strips an accidental full-document code fence from the agent's output
 * (the prompt forbids fences, but a cheap unwrap beats a corrupted doc).
 */
export function sanitizeUpdatedSpec(output: string): string {
  const trimmed = output.trim();
  const fenceMatch = trimmed.match(
    /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/
  );
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
  if (!project.gitRepoPath) {
    throw new Error("Project has no git repository path configured");
  }

  const systemPrompt = await resolveAgentPrompt(
    SPEC_UPDATE_AGENT_TYPE,
    input.projectId
  );
  // Fail loudly on an unknown named agent instead of letting
  // resolveAgentByNamedId fall through to the default chain.
  if (input.namedAgentId) {
    const picked = db
      .select({ id: namedAgents.id })
      .from(namedAgents)
      .where(eq(namedAgents.id, input.namedAgentId))
      .get();
    if (!picked) {
      throw new SpecUpdateAgentNotFoundError(input.namedAgentId);
    }
  }

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
    systemPrompt,
    buildProjectStateSection(
      db
        .select({ id: epics.id, title: epics.title, status: epics.status })
        .from(epics)
        .where(eq(epics.projectId, input.projectId))
        .orderBy(asc(epics.position))
        .all(),
      db
        .select({
          epicId: userStories.epicId,
          title: userStories.title,
          status: userStories.status,
        })
        .from(userStories)
        .innerJoin(epics, eq(userStories.epicId, epics.id))
        .where(eq(epics.projectId, input.projectId))
        .orderBy(asc(userStories.position))
        .all(),
      db
        .select({
          version: releases.version,
          title: releases.title,
          changelog: releases.changelog,
        })
        .from(releases)
        .where(eq(releases.projectId, input.projectId))
        .orderBy(desc(releases.createdAt))
        .all()
    )
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
        cwd: project.gitRepoPath ?? undefined,
        model: resolvedAgent.model || undefined,
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

    // Only a delivered answer replaces the spec — silent runs, asked
    // questions, and failures leave it untouched.
    const output =
      result?.success && outcome === "answered"
        ? sanitizeUpdatedSpec(resolveSessionOutput(result, sessionId, ""))
        : "";

    try {
      markSessionTerminal(
        sessionId,
        {
          // A run that produced no usable spec is a failure for this
          // workflow even when the CLI exited cleanly: the session row must
          // not claim success over an unchanged document.
          success: Boolean(result?.success && outcome === "answered" && output),
          error: output
            ? null
            : result?.error ??
              (result?.success
                ? outcome === "asked_question"
                  ? "The agent asked a question — the saved spec was left unchanged."
                  : "The agent finished without returning an updated spec — the saved spec was left unchanged."
                : "The spec update session failed without reporting an error."),
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
