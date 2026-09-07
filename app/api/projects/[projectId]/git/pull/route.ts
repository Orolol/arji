import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import {
  assertGitRepository,
  assertRemoteConfigured,
  getCurrentGitBranch,
  getConflictFileDiffs,
  GitRemoteNotConfiguredError,
  GitRepositoryUnavailableError,
  pullGitBranchWithConflictSupport,
} from "@/lib/git/remote";
import { writeGitSyncLog } from "@/lib/github/sync-log";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { createId } from "@/lib/utils/nanoid";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  classifySessionOutcome,
  extractSessionUsage,
} from "@/lib/claude/resolve-session-output";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import fs from "fs";
import path from "path";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) {
    if (found.status === 400) {
      writeGitSyncLog({
        projectId,
        operation: "pull",
        status: "failed",
        branch: null,
        detail: { reason: "missing_git_repo_path" },
      });
    }
    return found;
  }
  const { project } = found;

  const body = await request.json().catch(() => ({}));
  const remote = typeof body?.remote === "string" ? body.remote : "origin";
  const autoResolve =
    typeof body?.autoResolveConflicts === "boolean"
      ? body.autoResolveConflicts
      : true;
  const namedAgentId =
    typeof body?.namedAgentId === "string" ? body.namedAgentId : null;
  const resumeSessionId =
    typeof body?.resumeSessionId === "string" ? body.resumeSessionId : null;
  const requestedBranch = typeof body?.branch === "string" ? body.branch : "";
  // Resolved INSIDE the try below when the caller did not supply it. Reading
  // the current branch reaches git, and this pre-read used to sit above the
  // try: on a `gitRepoPath` that is not a repository it threw past the handler
  // and Next answered its default 500 page, with no `{ error }` envelope and
  // no audit row. Kept mutable so the catch blocks can still name the branch
  // when one was known.
  let branch = requestedBranch.trim();
  const resolved = resolveAgentByNamedId("merge", projectId, namedAgentId);
  const provider = resolved.provider;
  const model = resolved.model;

  try {
    // First of all: every git call below assumes the path is a repository.
    // An unusable one is a configuration state the user can fix, so it gets
    // the 400 and the shared code `github/detect` already answers, not a
    // transport-shaped fault.
    await assertGitRepository(project.gitRepoPath);
    if (!branch) branch = await getCurrentGitBranch(project.gitRepoPath);

    // Checked before the pull itself: without a remote there is nothing to
    // merge, and git's failure for that state is indistinguishable from a
    // transport error once it reaches the route.
    await assertRemoteConfigured(project.gitRepoPath, remote, "fetch");

    const result = await pullGitBranchWithConflictSupport(project.gitRepoPath, branch, remote);

    if (result.conflicted) {
      if (!autoResolve) {
        const conflictDiffs = await getConflictFileDiffs(
          project.gitRepoPath,
          result.conflictedFiles
        );
        writeGitSyncLog({
          projectId,
          operation: "pull",
          status: "failed",
          branch,
          detail: {
            remote,
            code: "merge_conflicts",
            conflictedFiles: result.conflictedFiles,
          },
        });
        return NextResponse.json(
          {
            error: "Pull resulted in merge conflicts.",
            code: "merge_conflicts",
            conflicted: true,
            conflictedFiles: result.conflictedFiles,
            conflictDiffs,
          },
          { status: 409 }
        );
      }

      try {
        const sessionId = createId();
        const now = new Date().toISOString();
        const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
        fs.mkdirSync(logsDir, { recursive: true });
        const logsPath = path.join(logsDir, "logs.json");

        let cliSessionId: string | undefined;
        let resumeSession = false;
        if (isResumableProvider(provider)) {
          if (resumeSessionId) {
            const previous = db
              .select({
                id: agentSessions.id,
                projectId: agentSessions.projectId,
                provider: agentSessions.provider,
                cliSessionId: agentSessions.cliSessionId,
                claudeSessionId: agentSessions.claudeSessionId,
              })
              .from(agentSessions)
              .where(eq(agentSessions.id, resumeSessionId))
              .get();
            // Legacy-row fallback handled inside resolveCliSessionId().
            const previousCliSessionId = previous ? resolveCliSessionId(previous) : null;
            if (
              previous &&
              previous.projectId === projectId &&
              previous.provider === provider &&
              previousCliSessionId
            ) {
              cliSessionId = previousCliSessionId;
              resumeSession = true;
            }
          }
          if (!cliSessionId && providerAcceptsAssignedSessionId(provider)) {
            cliSessionId = crypto.randomUUID();
          }
        }

        const prompt = [
          "Resolve git merge conflicts from a pull operation.",
          `Repository: ${project.gitRepoPath}`,
          `Branch: ${branch}`,
          `Remote: ${remote}`,
          "",
          "Conflicted files:",
          ...result.conflictedFiles.map((file) => `- ${file}`),
          "",
          "Instructions:",
          "1. Open each conflicted file and resolve conflict markers.",
          "2. Keep behavior safe and minimal; do not invent unrelated refactors.",
          "3. Stage all resolved files and commit with a descriptive message.",
          "4. Confirm no conflicts remain (`git status`).",
          "5. In your final response, summarize the resolution decisions.",
        ].join("\n");

        createQueuedSession({
          id: sessionId,
          projectId,
          mode: "code",
          provider,
          prompt,
          logsPath,
          branchName: branch,
          worktreePath: project.gitRepoPath,
          cliSessionId,
          namedAgentId: resolved.namedAgentId ?? null,
          compositeAgentId: resolved.compositeAgentId ?? null,
          agentType: "merge",
          namedAgentName: resolved.name || null,
          model: model || null,
          createdAt: now,
        });

        markSessionRunning(sessionId, now);
        processManager.start(
          sessionId,
          {
            mode: "code",
            prompt,
            cwd: project.gitRepoPath,
            model,
            allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
            cliSessionId,
            resumeSession,
          },
          provider
        );

        (async () => {
          const info = await waitForProcessCompletion(sessionId);
          const completedAt = new Date().toISOString();
          const agentResult = info?.result;
          try {
            fs.writeFileSync(logsPath, JSON.stringify(agentResult, null, 2));
          } catch {
            // best effort
          }
          try {
            markSessionTerminal(
              sessionId,
              {
                success: !!agentResult?.success,
                error: agentResult?.error || null,
                outcome: classifySessionOutcome(agentResult, sessionId),
                usage: extractSessionUsage(agentResult),
              },
              completedAt
            );
          } catch (error) {
            if (!isSessionLifecycleConflictError(error)) {
              console.error("[git/pull] Failed to finalize conflict session", error);
            }
          }
        })();

        writeGitSyncLog({
          projectId,
          operation: "pull",
          status: "failed",
          branch,
          detail: {
            remote,
            code: "merge_conflicts_auto_resolve_started",
            conflictedFiles: result.conflictedFiles,
            sessionId,
          },
        });

        return NextResponse.json(
          {
            data: {
              action: "pull",
              projectId,
              remote,
              branch,
              conflicted: true,
              autoResolve: true,
              sessionId,
              conflictedFiles: result.conflictedFiles,
            },
          },
          { status: 202 }
        );
      } catch (autoResolveError) {
        const conflictDiffs = await getConflictFileDiffs(
          project.gitRepoPath,
          result.conflictedFiles
        );
        return NextResponse.json(
          {
            error: `Auto-resolve failed: ${
              autoResolveError instanceof Error
                ? autoResolveError.message
                : "unknown error"
            }`,
            code: "merge_conflicts",
            conflicted: true,
            conflictedFiles: result.conflictedFiles,
            conflictDiffs,
          },
          { status: 409 }
        );
      }
    }

    writeGitSyncLog({
      projectId,
      operation: "pull",
      status: "success",
      branch,
      detail: {
        remote,
        ffOnly: false,
        summary: result.summary,
      },
    });

    return NextResponse.json({
      data: {
        action: "pull",
        projectId,
        remote,
        branch,
        ffOnly: false,
        summary: result.summary,
      },
    });
  } catch (error) {
    // A path that is not a usable repository is the same class of recoverable
    // state as the unconfigured remote below — audited the same way, refused
    // with the same 400 and code the two detect routes already publish.
    if (error instanceof GitRepositoryUnavailableError) {
      writeGitSyncLog({
        projectId,
        operation: "pull",
        status: "failed",
        branch: branch || null,
        detail: {
          remote,
          code: error.code,
          error: error.message,
        },
      });

      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }

    // An unconfigured remote is a precondition the user can fix, not a fault:
    // 409 with the code and the repository's real remotes so the client can
    // offer them, matching git/detect-remote's 4xx for the same state.
    if (error instanceof GitRemoteNotConfiguredError) {
      writeGitSyncLog({
        projectId,
        operation: "pull",
        status: "failed",
        branch: branch || null,
        detail: {
          remote,
          code: error.code,
          operation: error.operation,
          error: error.message,
        },
      });

      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          remote: error.remote,
          operation: error.operation,
          configuredRemotes: error.configuredRemotes,
        },
        { status: 409 }
      );
    }

    writeGitSyncLog({
      projectId,
      operation: "pull",
      status: "failed",
      branch: branch || null,
      detail: {
        remote,
        ffOnly: false,
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });

    return errorResponse(error, "Failed to pull branch.");
  }
}
