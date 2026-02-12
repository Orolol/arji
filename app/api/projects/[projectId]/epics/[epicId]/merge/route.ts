import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, agentSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { mergeWorktree } from "@/lib/git/manager";
import { tryExportArjiJson } from "@/lib/sync/export";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; epicId: string }> }
) {
  const { projectId, epicId } = await params;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || !project.gitRepoPath) {
    return NextResponse.json({ error: "Project not found or no git repo" }, { status: 404 });
  }

  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  if (!epic.branchName) {
    return NextResponse.json({ error: "Epic has no branch to merge" }, { status: 400 });
  }

  // Find the worktree path from the most recent session for this epic
  const session = db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.epicId, epicId), eq(agentSessions.projectId, projectId)))
    .orderBy(agentSessions.createdAt)
    .all()
    .pop();

  const worktreePath = session?.worktreePath || undefined;

  const result = await mergeWorktree(project.gitRepoPath, epic.branchName, worktreePath);

  if (!result.merged) {
    return NextResponse.json(
      { error: result.error || "Merge failed" },
      { status: 500 }
    );
  }

  // Move epic to done
  const now = new Date().toISOString();
  db.update(epics)
    .set({ status: "done", branchName: null, updatedAt: now })
    .where(eq(epics.id, epicId))
    .run();

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: {
      merged: true,
      commitHash: result.commitHash,
    },
  });
}
