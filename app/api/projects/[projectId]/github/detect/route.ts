import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { detectGitHubRemote } from "@/lib/git/remote";
import { writeGitSyncLog } from "@/lib/github/sync-log";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { projectId } = await params;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.gitRepoPath) {
    writeGitSyncLog({
      projectId,
      operation: "detect",
      status: "failed",
      detail: { reason: "missing_git_repo_path" },
    });

    return NextResponse.json(
      { error: "Project has no git repository path configured." },
      { status: 400 }
    );
  }

  try {
    const detected = await detectGitHubRemote(project.gitRepoPath);
    if (!detected) {
      writeGitSyncLog({
        projectId,
        operation: "detect",
        status: "success",
        detail: { detected: false },
      });

      return NextResponse.json({ data: { detected: false } });
    }

    writeGitSyncLog({
      projectId,
      operation: "detect",
      status: "success",
      detail: {
        detected: true,
        ownerRepo: detected.ownerRepo,
        remoteName: detected.remoteName,
        remoteUrl: detected.remoteUrl,
      },
    });

    return NextResponse.json({
      data: {
        detected: true,
        owner: detected.owner,
        repo: detected.repo,
        ownerRepo: detected.ownerRepo,
        remoteName: detected.remoteName,
        remoteUrl: detected.remoteUrl,
      },
    });
  } catch (error) {
    writeGitSyncLog({
      projectId,
      operation: "detect",
      status: "failed",
      detail: {
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to inspect git remotes for this project.",
      },
      { status: 500 }
    );
  }
}
