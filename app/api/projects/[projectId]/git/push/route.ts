import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import simpleGit from "simple-git";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const { branch } = body;

  if (!branch || typeof branch !== "string") {
    return NextResponse.json(
      { error: "branch is required in request body" },
      { status: 400 }
    );
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project || !project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project not found or no git repo configured" },
      { status: 404 }
    );
  }

  try {
    const git = simpleGit(project.gitRepoPath);

    // Push the branch to origin
    const result = await git.push("origin", branch);

    console.log(
      `[git-push] Pushed branch "${branch}" for project "${projectId}":`,
      result.pushed
    );

    return NextResponse.json({
      data: {
        pushed: true,
        branch,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Push failed";
    console.error(`[git-push] Failed to push branch "${branch}":`, message);

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
