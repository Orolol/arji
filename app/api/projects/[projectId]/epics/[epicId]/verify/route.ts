import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, verifyReports } from "@/lib/db/schema";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import {
  errorResponse,
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { emitTicketUpdated } from "@/lib/events/emit";
import { logTransition } from "@/lib/workflow/log";
import { resolveVerifyConfigForProject } from "@/lib/verify/config";
import {
  isVerificationAlreadyRunningError,
  withVerificationWorktreeLock,
} from "@/lib/verify/execution-lock";
import { runVerification } from "@/lib/verify/runner";
import { isManagedEpicWorktreePath } from "@/lib/verify/worktree";
import type {
  VerificationReport,
  VerifyCommandResult,
} from "@/lib/verify/verify-constants";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

const NO_WORKTREE_ERROR =
  "Verification requires an existing epic worktree. Build or review this ticket first.";

function parseCommandResults(value: string): VerifyCommandResult[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is VerifyCommandResult => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const command = entry as Record<string, unknown>;
      return (
        typeof command.name === "string" &&
        typeof command.command === "string" &&
        (typeof command.exitCode === "number" || command.exitCode === null) &&
        typeof command.durationMs === "number" &&
        typeof command.tail === "string"
      );
    });
  } catch {
    return [];
  }
}

function toResponseReport(
  row: typeof verifyReports.$inferSelect
): VerificationReport {
  return {
    id: row.id,
    projectId: row.projectId,
    epicId: row.epicId,
    agentSessionId: row.agentSessionId,
    status: row.status === "pass" ? "pass" : "fail",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    commands: parseCommandResults(row.commands),
  };
}

/**
 * Resolve an already-created Arij epic worktree from durable session state.
 * This deliberately never calls createWorktree and never falls back to the
 * project's main checkout. Stale and out-of-root paths are ignored.
 */
function findExistingWorktree(
  projectId: string,
  epicId: string,
  repoPath: string
): string | null {
  const candidates = db
    .select({ worktreePath: agentSessions.worktreePath })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.epicId, epicId),
        isNotNull(agentSessions.worktreePath)
      )
    )
    .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id))
    .all();

  for (const candidate of candidates) {
    if (!candidate.worktreePath) continue;
    if (!isManagedEpicWorktreePath(candidate.worktreePath, repoPath)) continue;
    try {
      if (fs.statSync(candidate.worktreePath).isDirectory()) {
        return candidate.worktreePath;
      }
    } catch {
      // A session may outlive a pruned or merged worktree. Try older rows.
    }
  }

  return null;
}

/** Latest persisted deterministic verification report for EpicDetail. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  const found = getEpicOr404(projectId, epicId);
  if (isErrorResponse(found)) return found;

  const latest = db
    .select()
    .from(verifyReports)
    .where(
      and(
        eq(verifyReports.projectId, projectId),
        eq(verifyReports.epicId, epicId)
      )
    )
    .orderBy(desc(verifyReports.finishedAt), desc(verifyReports.id))
    .get();

  return NextResponse.json({ data: latest ? toResponseReport(latest) : null });
}

/** Run human-configured commands synchronously in an existing epic worktree. */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;

  const foundProject = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(foundProject)) return foundProject;
  const foundEpic = getEpicOr404(projectId, epicId);
  if (isErrorResponse(foundEpic)) return foundEpic;

  const conflict = getRunningSessionForTarget({
    scope: "epic",
    projectId,
    epicId,
  });
  if (conflict) {
    return NextResponse.json(
      createAgentAlreadyRunningPayload(
        { scope: "epic", projectId, epicId },
        conflict,
        "Verification cannot run while an agent is active on this epic."
      ),
      { status: 409 }
    );
  }

  const worktreePath = findExistingWorktree(
    projectId,
    epicId,
    foundProject.project.gitRepoPath
  );
  if (!worktreePath) {
    return NextResponse.json(
      { error: NO_WORKTREE_ERROR },
      { status: 409 }
    );
  }

  const config = resolveVerifyConfigForProject(projectId);
  if (!config.enabled) {
    return NextResponse.json(
      {
        error:
          "Verification is not configured for this project. Add at least one verify command in Settings.",
      },
      { status: 409 }
    );
  }

  try {
    const report = await withVerificationWorktreeLock(
      worktreePath,
      () =>
        runVerification({
          projectId,
          epicId,
          agentSessionId: null,
          worktreePath,
          commands: config.commands,
          timeoutMs: config.timeoutMs,
        }),
      { wait: false }
    );

    const epicStatus = foundEpic.epic.status ?? "backlog";
    const failedCommand = report.commands.find(
      (command) => command.exitCode !== 0
    );
    logTransition({
      projectId,
      epicId,
      fromStatus: epicStatus,
      toStatus: epicStatus,
      actor: "system",
      reason:
        report.status === "pass"
          ? `Manual verification passed (${report.commands.length} command${report.commands.length === 1 ? "" : "s"})`
          : `Manual verification failed${failedCommand ? ` at ${failedCommand.name}` : ""}`,
    });

    // Reuse the board's canonical refresh event rather than introducing a
    // verify-only event that every SSE consumer would have to understand.
    emitTicketUpdated(projectId, epicId, {
      verifyReportId: report.id,
      verifyStatus: report.status,
    });

    return NextResponse.json({ data: report });
  } catch (error) {
    if (isVerificationAlreadyRunningError(error)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return errorResponse(error, "Failed to run verification");
  }
}
