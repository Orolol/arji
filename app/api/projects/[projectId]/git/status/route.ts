import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import simpleGit from "simple-git";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const { searchParams } = new URL(request.url);
  const branch = searchParams.get("branch");

  if (!branch) {
    return NextResponse.json(
      { error: "branch query parameter is required" },
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

    // Fetch from remote to get up-to-date tracking info
    try {
      await git.fetch();
    } catch {
      // Fetch may fail if no remote is configured — continue with local data
    }

    // Use rev-list to count ahead/behind vs remote tracking branch
    const raw = await git.raw([
      "rev-list",
      "--count",
      "--left-right",
      `${branch}...origin/${branch}`,
    ]);

    // Output format: "ahead\tbehind\n"
    const parts = raw.trim().split(/\s+/);
    const ahead = parseInt(parts[0] || "0", 10);
    const behind = parseInt(parts[1] || "0", 10);

    return NextResponse.json({
      data: { ahead, behind },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to get git status";

    // If the remote tracking branch doesn't exist, return 0/0
    if (message.includes("unknown revision") || message.includes("bad revision")) {
      return NextResponse.json({
        data: { ahead: 0, behind: 0, noRemote: true },
      });
    }

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
