import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { qaReports } from "@/lib/db/schema";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { createId } from "@/lib/utils/nanoid";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import {
  buildTechCheckPrompt,
  buildE2eTestPrompt,
  buildFailureDigestPrompt,
} from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import type { AgentType } from "@/lib/agent-config/constants";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { agentScheduler } from "@/lib/agents/scheduler";
import { collectFailureDigestEvidence } from "@/lib/telescope/collect";
import {
  TELESCOPE_MAX_WINDOW_DAYS,
  TELESCOPE_WINDOW_DAYS,
} from "@/lib/telescope/constants";

type Params = { params: Promise<{ projectId: string }> };

type CheckType = "tech_check" | "e2e_test" | "failure_digest";

const CHECK_TYPE_TO_AGENT_TYPE: Record<CheckType, AgentType> = {
  tech_check: "tech_check",
  e2e_test: "e2e_test",
  failure_digest: "failure_digest",
};

const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  tech_check: "Tech check",
  e2e_test: "E2E test",
  failure_digest: "Failure digest",
};

const POLL_INTERVAL_MS = 2000;

function toNullableTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCheckType(value: unknown): CheckType {
  if (value === "e2e_test") return "e2e_test";
  if (value === "failure_digest") return "failure_digest";
  return "tech_check";
}

function parseWindowDays(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(
    TELESCOPE_MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(parsed))
  );
}

function emptyDigestReport(input: {
  sinceIso: string;
  untilIso: string;
  windowDays: number;
}): string {
  return `# Recurring Failure Digest

No eligible recurring failure evidence was found between ${input.sinceIso} and ${input.untilIso} (${input.windowDays}-day window). No analysis session was launched.`;
}

function extractSummary(content: string, checkType: CheckType): string {
  const normalized = content.trim();
  if (!normalized) {
    return `${CHECK_TYPE_LABELS[checkType]} completed without output.`;
  }

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith("#"));

  if (paragraphs.length > 0) {
    return paragraphs[0].slice(0, 500);
  }

  return normalized.slice(0, 500);
}

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const body = await request.json().catch(() => ({}));
  const namedAgentId = toNullableTrimmedString(body.namedAgentId);
  const customPrompt = toNullableTrimmedString(body.customPrompt);
  const customPromptId = toNullableTrimmedString(body.customPromptId);
  const checkType = parseCheckType(body.checkType);
  const agentType = CHECK_TYPE_TO_AGENT_TYPE[checkType];

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) return found;
  const { project } = found;

  const collection =
    checkType === "failure_digest"
      ? collectFailureDigestEvidence(projectId, {
          windowDays: parseWindowDays(body.windowDays),
        })
      : null;

  // A report row is the durable journal for this successful no-op. It makes
  // "nothing happened" visible in the same QA history as real digests while
  // avoiding a provider call, an agent session row, and scheduler work.
  if (collection && collection.evidenceCount === 0) {
    const reportId = createId();
    const now = new Date().toISOString();
    const reportContent = emptyDigestReport(collection);
    const summary = `No recurring failure evidence in the last ${collection.windowDays} days; no agent session launched.`;

    db.insert(qaReports)
      .values({
        id: reportId,
        projectId,
        status: "completed",
        agentSessionId: null,
        namedAgentId: null,
        promptUsed: null,
        customPromptId: null,
        reportContent,
        summary,
        checkType,
        createdAt: now,
        completedAt: now,
      })
      .run();

    console.info(
      `[failure-digest] skipped for project ${projectId}: empty ${collection.windowDays}-day window`,
    );
    return NextResponse.json({
      data: {
        reportId,
        sessionId: null,
        noOp: true,
        evidenceCount: 0,
        windowDays: collection.windowDays,
      },
    });
  }

  const systemPrompt = await resolveAgentPrompt(agentType, projectId);
  const resolvedAgent = resolveAgentByNamedId(agentType, projectId, namedAgentId);

  const prompt =
    checkType === "failure_digest"
      ? buildFailureDigestPrompt(project, collection!, customPrompt, systemPrompt)
      : checkType === "e2e_test"
      ? buildE2eTestPrompt(project, customPrompt, systemPrompt)
      : buildTechCheckPrompt(project, customPrompt, systemPrompt);
  const mode = checkType === "failure_digest" ? "plan" : "code";

  const sessionId = createId();
  const reportId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");
  const cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
    ? crypto.randomUUID()
    : undefined;

  createQueuedSession({
    id: sessionId,
    projectId,
    mode,
    provider: resolvedAgent.provider,
    prompt,
    logsPath,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType,
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
    createdAt: now,
  });

  db.insert(qaReports)
    .values({
      id: reportId,
      projectId,
      status: "running",
      agentSessionId: sessionId,
      namedAgentId,
      promptUsed: prompt,
      customPromptId,
      checkType,
      createdAt: now,
    })
    .run();

  // Scheduled QA launch via the per-project scheduler: the closure spawns
  // the agent, waits for completion, and finalizes the report.
  agentScheduler.submit(projectId, sessionId, async () => {
    markSessionRunning(sessionId);

    processManager.start(
      sessionId,
      {
        mode,
        prompt,
        cwd: project.gitRepoPath,
        model: resolvedAgent.model,
        cliSessionId,
      },
      resolvedAgent.provider,
    );

    const info = await waitForProcessCompletion(sessionId, POLL_INTERVAL_MS);

    const completedAt = new Date().toISOString();
    const result = info?.result;

    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // Ignore best-effort log writes.
    }

    try {
      markSessionTerminal(
        sessionId,
        {
          success: !!result?.success,
          error: result?.error ?? null,
          outcome: classifySessionOutcome(result, sessionId),
          usage: extractSessionUsage(result),
        },
        completedAt,
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error("[qa-check] Failed to finalize session", error);
      }
    }

    const fallbackLabel = CHECK_TYPE_LABELS[checkType];
    const output = resolveSessionOutput(result, sessionId, `${fallbackLabel} completed without output.`);

    const reportStatus =
      info?.status === "cancelled"
        ? "cancelled"
        : result?.success
          ? "completed"
          : "failed";

    db.update(qaReports)
      .set({
        status: reportStatus,
        reportContent: output,
        summary: extractSummary(output, checkType),
        completedAt,
      })
      .where(eq(qaReports.id, reportId))
      .run();
  });

  return NextResponse.json({
    data: {
      reportId,
      sessionId,
      noOp: false,
      evidenceCount: collection?.evidenceCount ?? null,
      windowDays: collection?.windowDays ?? TELESCOPE_WINDOW_DAYS,
    },
  });
}
