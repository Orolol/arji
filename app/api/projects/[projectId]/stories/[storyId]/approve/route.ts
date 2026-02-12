import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import simpleGit from "simple-git";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, storyId } = await params;

  // Validate story exists and is in review
  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  if (story.status !== "review") {
    return NextResponse.json(
      { error: "Story must be in review status to approve" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  // Move story to done
  db.update(userStories)
    .set({ status: "done" })
    .where(eq(userStories.id, storyId))
    .run();

  // Check if all stories in the epic are now done
  const epic = db
    .select()
    .from(epics)
    .where(eq(epics.id, story.epicId))
    .get();

  if (!epic) {
    return NextResponse.json({ data: { approved: true, epicComplete: false } });
  }

  const allStories = db
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epic.id))
    .all();

  const allDone = allStories.every((s) => s.id === storyId || s.status === "done");

  let merged = false;

  if (allDone) {
    // Update epic status to done
    db.update(epics)
      .set({ status: "done", updatedAt: now })
      .where(eq(epics.id, epic.id))
      .run();

    // Attempt to merge the epic branch
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();

    if (project?.gitRepoPath && epic.branchName) {
      try {
        const git = simpleGit(project.gitRepoPath);
        await git.merge([epic.branchName, "--no-ff"]);
        merged = true;
      } catch (e) {
        console.error("[approve] Merge failed:", e);
        // Don't fail the approve — the merge can be done manually
      }
    }
  }

  tryExportArjiJson(projectId);

  return NextResponse.json({
    data: {
      approved: true,
      epicComplete: allDone,
      merged,
    },
  });
}
