import { NextRequest, NextResponse } from "next/server";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import {
  assertGitRepository,
  assertRemoteConfigured,
  getCurrentGitBranch,
  GitRemoteNotConfiguredError,
  GitRepositoryUnavailableError,
  pushGitBranch,
  PushValidationError,
  validatePushPreconditions,
} from "@/lib/git/remote";
import { writeGitSyncLog } from "@/lib/github/sync-log";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) {
    if (found.status === 400) {
      writeGitSyncLog({
        projectId,
        operation: "push",
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
  const setUpstream = typeof body?.setUpstream === "boolean" ? body.setUpstream : true;
  const requestedBranch = typeof body?.branch === "string" ? body.branch : "";
  // Resolved INSIDE the try below when the caller did not supply it. Reading
  // the current branch reaches git, and this pre-read used to sit above the
  // try: on a `gitRepoPath` that is not a repository it threw past the handler
  // and Next answered its default 500 page, with no `{ error }` envelope and
  // no audit row. Kept mutable so the catch blocks can still name the branch
  // when one was known.
  let branch = requestedBranch.trim();

  try {
    // First of all: every git call below assumes the path is a repository.
    // An unusable one is a configuration state the user can fix, so it gets
    // the 400 and the shared code `github/detect` already answers, not a
    // transport-shaped fault.
    await assertGitRepository(project.gitRepoPath);
    if (!branch) branch = await getCurrentGitBranch(project.gitRepoPath);

    // Checked before the working-tree/behind validation: a project with no
    // remote cannot be "behind" one, and git's own failure for this state is a
    // transport-shaped error that reads as a server fault.
    await assertRemoteConfigured(project.gitRepoPath, remote, "push");
    await validatePushPreconditions(project.gitRepoPath, branch, remote);
    const result = await pushGitBranch(
      project.gitRepoPath,
      branch,
      remote,
      setUpstream
    );
    const summary = {
      pushed: result.pushed.length,
      update: result.update ? 1 : 0,
    };

    writeGitSyncLog({
      projectId,
      operation: "push",
      status: "success",
      branch,
      detail: { remote, setUpstream, ...summary },
    });

    return NextResponse.json({
      data: {
        action: "push",
        projectId,
        remote,
        branch,
        setUpstream,
        summary,
      },
    });
  } catch (error) {
    // A path that is not a usable repository is the same class of recoverable
    // state as the unconfigured remote below — audited the same way, refused
    // with the same 400 and code the two detect routes already publish.
    if (error instanceof GitRepositoryUnavailableError) {
      writeGitSyncLog({
        projectId,
        operation: "push",
        status: "failed",
        branch: branch || null,
        detail: {
          remote,
          setUpstream,
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
        operation: "push",
        status: "failed",
        branch: branch || null,
        detail: {
          remote,
          setUpstream,
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

    if (error instanceof PushValidationError) {
      writeGitSyncLog({
        projectId,
        operation: "push",
        status: "failed",
        branch: branch || null,
        detail: {
          remote,
          setUpstream,
          code: error.code,
          error: error.message,
        },
      });

      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 }
      );
    }

    writeGitSyncLog({
      projectId,
      operation: "push",
      status: "failed",
      branch: branch || null,
      detail: {
        remote,
        setUpstream,
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });

    return errorResponse(error, "Failed to push branch.");
  }
}
