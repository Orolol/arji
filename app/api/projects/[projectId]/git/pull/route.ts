import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  FastForwardOnlyPullError,
  getCurrentGitBranch,
  pullGitBranchFfOnly,
} from "@/lib/git/remote";
import { writeGitSyncLog } from "@/lib/github/sync-log";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!project.gitRepoPath) {
    writeGitSyncLog({
      projectId,
      operation: "pull",
      status: "failed",
      branch: null,
      detail: { reason: "missing_git_repo_path" },
    });

    return NextResponse.json(
      { error: "Project has no git repository path configured." },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const remote = typeof body?.remote === "string" ? body.remote : "origin";
  const requestedBranch = typeof body?.branch === "string" ? body.branch : "";
  const branch = requestedBranch.trim() || (await getCurrentGitBranch(project.gitRepoPath));

  try {
    const result = await pullGitBranchFfOnly(project.gitRepoPath, branch, remote);
    writeGitSyncLog({
      projectId,
      operation: "pull",
      status: "success",
      branch,
      detail: {
        remote,
        ffOnly: true,
        summary: result.summary,
      },
    });

    return NextResponse.json({
      data: {
        action: "pull",
        projectId,
        remote,
        branch,
        ffOnly: true,
        summary: result.summary,
      },
    });
  } catch (error) {
    if (error instanceof FastForwardOnlyPullError) {
      writeGitSyncLog({
        projectId,
        operation: "pull",
        status: "failed",
        branch,
        detail: {
          remote,
          ffOnly: true,
          code: "ff_only_conflict",
          error: error.message,
        },
      });

      return NextResponse.json(
        {
          error: error.message,
          data: {
            action: "pull",
            projectId,
            remote,
            branch,
            ffOnly: true,
          },
        },
        { status: 409 }
      );
    }

    writeGitSyncLog({
      projectId,
      operation: "pull",
      status: "failed",
      branch,
      detail: {
        remote,
        ffOnly: true,
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to pull branch.",
        data: { action: "pull", projectId, remote, branch, ffOnly: true },
      },
      { status: 500 }
    );
  }
}
