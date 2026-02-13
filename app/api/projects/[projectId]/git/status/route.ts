import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getBranchSyncStatus, getCurrentGitBranch } from "@/lib/git/remote";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project has no git repository path configured." },
      { status: 400 }
    );
  }

  const remote = request.nextUrl.searchParams.get("remote") || "origin";
  const requestedBranch = request.nextUrl.searchParams.get("branch")?.trim() || "";
  const branch = requestedBranch || (await getCurrentGitBranch(project.gitRepoPath));

  try {
    const status = await getBranchSyncStatus(project.gitRepoPath, branch, remote);
    return NextResponse.json({
      data: {
        action: "status",
        projectId,
        remote: status.remote,
        branch: status.branch,
        remoteBranch: status.remoteBranch,
        ahead: status.ahead,
        behind: status.behind,
        hasRemoteBranch: status.hasRemoteBranch,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to read branch status.",
        data: { action: "status", projectId, remote, branch },
      },
      { status: 500 }
    );
  }
}
