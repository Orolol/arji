/**
 * Automatic spec rewrite ("spec vivante") — release-triggered workflow.
 *
 * The project specification (`projects.spec`) is injected into every agent
 * prompt for the project, so a stale spec quietly degrades every session.
 * When the 'spec_auto_rewrite' setting is on, publishing a release
 * (POST /api/projects/:id/releases) fires this trigger: a plan-mode
 * 'spec_generation' session rewrites the spec to match the project's
 * current reality, grounded in the board state and the release changelog.
 * The stored spec is replaced only when the session actually delivers an
 * answer — a failed run never touches it.
 *
 * Same lifecycle as the memory distill (lib/workflow/memory-distill.ts):
 * setting gate → pure guard matrix → queued session row → per-project
 * scheduler closure.
 *
 * Coexistence with the manual "ask an agent to update the spec" flow: BOTH
 * writers dispatch sessions of agent type 'spec_generation', so the single
 * pending-guard below (hasPendingSpecGeneration) blocks an auto rewrite
 * while a manual update is queued/running — and the manual flow's identical
 * guard blocks a manual dispatch while the auto rewrite runs.
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  releases,
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
import {
  buildSpecAutoRewritePrompt,
  type SpecRewriteBoardState,
} from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  SPEC_AUTO_REWRITE_SETTING_KEY,
  parseSpecAutoRewriteSetting,
} from "./spec-rewrite-constants";

const POLL_INTERVAL_MS = 2000;

/**
 * Shared with the manual spec-update dispatch: one agent type means one
 * pending-guard covers both writers (see module docblock).
 */
export const SPEC_REWRITE_AGENT_TYPE = "spec_generation";

/** Reads the 'spec_auto_rewrite' setting (DEFAULT OFF when absent). */
export function isSpecAutoRewriteEnabled(): boolean {
  try {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SPEC_AUTO_REWRITE_SETTING_KEY))
      .get();
    return row ? parseSpecAutoRewriteSetting(row.value) : false;
  } catch {
    return false;
  }
}

/**
 * True when ANY spec_generation session (auto rewrite OR manual update) is
 * queued/running for the project — the mutual-exclusion guard.
 */
export function hasPendingSpecGeneration(projectId: string): boolean {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, SPEC_REWRITE_AGENT_TYPE),
        inArray(agentSessions.status, ["queued", "running"])
      )
    )
    .get();
  return !!row;
}

// ---------------------------------------------------------------------------
// Auto-trigger guards
// ---------------------------------------------------------------------------

export interface SpecAutoRewriteDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Pure guard matrix for the release trigger — exported for exhaustive
 * testing. Denials are silent by design: a release must never fail because
 * the spec refresh declined to run.
 */
export function evaluateSpecAutoRewriteGuards(input: {
  enabled: boolean;
  hasRelease: boolean;
  hasPendingSpecSession: boolean;
}): SpecAutoRewriteDecision {
  if (!input.enabled) {
    return { allowed: false, reason: "spec auto-rewrite setting is off" };
  }
  if (!input.hasRelease) {
    return { allowed: false, reason: "release row not found" };
  }
  if (input.hasPendingSpecSession) {
    return {
      allowed: false,
      reason: "a spec update is already queued/running for this project",
    };
  }
  return { allowed: true, reason: "ok" };
}

/**
 * Auto-trigger entry point, invoked (fire-and-forget) from the release
 * creation route after the release transaction commits. Best-effort by
 * design: it must never throw into the request, and every denial is
 * silent except for unexpected errors (logged).
 */
export async function maybeAutoRewriteSpecAfterRelease(
  projectId: string,
  releaseId: string
): Promise<SpecAutoRewriteDecision> {
  try {
    // Cheapest check first — the feature is off by default.
    const enabled = isSpecAutoRewriteEnabled();
    if (!enabled) {
      return { allowed: false, reason: "spec auto-rewrite setting is off" };
    }

    const release = db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.id, releaseId), eq(releases.projectId, projectId)))
      .get();

    const decision = evaluateSpecAutoRewriteGuards({
      enabled,
      hasRelease: !!release,
      hasPendingSpecSession: hasPendingSpecGeneration(projectId),
    });

    if (!decision.allowed) {
      return decision;
    }

    await dispatchSpecAutoRewriteSession({ projectId, releaseId });
    return decision;
  } catch (err) {
    console.warn(
      "[spec-auto-rewrite] Auto-rewrite trigger failed:",
      (err as Error).message
    );
    return { allowed: false, reason: "spec auto-rewrite trigger failed" };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchSpecAutoRewriteInput {
  projectId: string;
  /** The release whose changelog grounds the rewrite. */
  releaseId: string;
}

export interface DispatchSpecAutoRewriteResult {
  sessionId: string;
}

/**
 * Strips an accidental full-document code fence from the agent's output
 * (the prompt forbids fences, but a cheap unwrap beats a corrupted spec).
 */
export function sanitizeRewrittenSpec(output: string): string {
  const trimmed = output.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function loadBoardState(projectId: string): SpecRewriteBoardState {
  return {
    epics: db
      .select({
        id: epics.id,
        title: epics.title,
        status: epics.status,
      })
      .from(epics)
      .where(eq(epics.projectId, projectId))
      .all()
      .map((e) => ({ id: e.id, title: e.title, status: e.status ?? "backlog" })),
    userStories: db
      .select({
        epicId: userStories.epicId,
        title: userStories.title,
        status: userStories.status,
      })
      .from(userStories)
      .innerJoin(epics, eq(userStories.epicId, epics.id))
      .where(eq(epics.projectId, projectId))
      .all()
      .map((s) => ({
        epicId: s.epicId,
        title: s.title,
        status: s.status ?? "backlog",
      })),
    releases: db
      .select({
        version: releases.version,
        title: releases.title,
        changelog: releases.changelog,
      })
      .from(releases)
      .where(eq(releases.projectId, projectId))
      .all(),
  };
}

/**
 * Creates a queued 'spec_generation' session and submits its launch closure
 * to the per-project scheduler. Resolves with the session id immediately;
 * the spec lands in the database when the closure finishes.
 */
export async function dispatchSpecAutoRewriteSession(
  input: DispatchSpecAutoRewriteInput
): Promise<DispatchSpecAutoRewriteResult> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) {
    throw new Error("Project not found");
  }

  const release = db
    .select({
      version: releases.version,
      title: releases.title,
      changelog: releases.changelog,
    })
    .from(releases)
    .where(
      and(
        eq(releases.id, input.releaseId),
        eq(releases.projectId, input.projectId)
      )
    )
    .get();
  if (!release) {
    throw new Error("Release not found");
  }

  const systemPrompt = await resolveAgentPrompt(
    SPEC_REWRITE_AGENT_TYPE,
    input.projectId
  );
  // Auto trigger: no named-agent override — the default spec_generation
  // agent (or its project override) does the work.
  const resolvedAgent = resolveAgentByNamedId(
    SPEC_REWRITE_AGENT_TYPE,
    input.projectId,
    null
  );

  const prompt = buildSpecAutoRewritePrompt(
    project,
    project.spec,
    loadBoardState(input.projectId),
    release,
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

  // Deliberately no epicId: like the memory distill, a spec rewrite is a
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
    compositeAgentId: resolvedAgent.compositeAgentId ?? null,
    agentType: SPEC_REWRITE_AGENT_TYPE,
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
        console.error("[spec-auto-rewrite] Failed to finalize session", error);
      }
    }

    // Only a delivered answer replaces the spec — silent runs, asked
    // questions, and failures leave it untouched.
    if (!result?.success || outcome !== "answered") {
      return;
    }

    const output = sanitizeRewrittenSpec(
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
      console.error("[spec-auto-rewrite] Failed to save rewritten spec", error);
      return;
    }

    tryExportArjiJson(input.projectId);
  });

  return { sessionId };
}
