import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { releases, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createOctokit, parseOwnerRepo } from "@/lib/github/client";
import { getRelease, publishRelease } from "@/lib/github/releases";
import { logSyncOperation } from "@/lib/github/sync-log";

export async function POST(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; releaseId: string }> }
) {
  const { projectId, releaseId } = await params;

  // Load release from DB
  const release = db
    .select()
    .from(releases)
    .where(eq(releases.id, releaseId))
    .get();

  if (!release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  if (release.projectId !== projectId) {
    return NextResponse.json(
      { error: "Release does not belong to this project" },
      { status: 400 }
    );
  }

  // Must have a GitHub release ID to publish
  if (!release.githubReleaseId) {
    return NextResponse.json(
      { error: "Release not published to GitHub yet. Create a release with pushToGitHub enabled first." },
      { status: 400 }
    );
  }

  // Load project for owner/repo
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project || !project.githubOwnerRepo) {
    return NextResponse.json(
      { error: "Project GitHub configuration missing" },
      { status: 400 }
    );
  }

  const { owner, repo } = parseOwnerRepo(project.githubOwnerRepo);

  try {
    const octokit = createOctokit();

    // Check if already published
    const ghRelease = await getRelease(
      octokit,
      owner,
      repo,
      release.githubReleaseId
    );

    if (!ghRelease.draft) {
      return NextResponse.json(
        { error: "Release is already published on GitHub" },
        { status: 409 }
      );
    }

    // Publish the draft
    const published = await publishRelease(
      octokit,
      owner,
      repo,
      release.githubReleaseId
    );

    // Update local record
    const now = new Date().toISOString();
    db.update(releases)
      .set({
        pushedAt: now,
        githubReleaseUrl: published.htmlUrl,
      })
      .where(eq(releases.id, releaseId))
      .run();

    logSyncOperation(projectId, "release_publish", null, "success", {
      releaseId: published.id,
      url: published.htmlUrl,
    });

    const updated = db
      .select()
      .from(releases)
      .where(eq(releases.id, releaseId))
      .get();

    return NextResponse.json({ data: updated });
  } catch (e) {
    const errMsg =
      e instanceof Error ? e.message : "Failed to publish release";

    logSyncOperation(projectId, "release_publish", null, "failure", {
      releaseId: release.githubReleaseId,
      error: errMsg,
    });

    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
