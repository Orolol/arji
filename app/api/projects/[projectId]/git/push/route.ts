import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentGitBranch, pushGitBranch } from "@/lib/git/remote";
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
      operation: "push",
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
  const setUpstream = typeof body?.setUpstream === "boolean" ? body.setUpstream : true;
  const requestedBranch = typeof body?.branch === "string" ? body.branch : "";
  const branch = requestedBranch.trim() || (await getCurrentGitBranch(project.gitRepoPath));

  try {
    const result = await pushGitBranch(
      project.gitRepoPath,
      branch,
      remote,
      setUpstream
    );
    const summary = {
      pushed: result.pushed.length,
      created: result.created.length,
      deleted: result.deleted.length,
      failures: result.failed ? 1 : 0,
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
    writeGitSyncLog({
      projectId,
      operation: "push",
      status: "failed",
      branch,
      detail: {
        remote,
        setUpstream,
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to push branch.",
        data: { action: "push", projectId, remote, branch, setUpstream },
      },
      { status: 500 }
    );
  }
}
