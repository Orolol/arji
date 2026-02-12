import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  releases,
  projects,
  epics,
  settings,
} from "@/lib/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaude } from "@/lib/claude/spawn";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import simpleGit from "simple-git";
import { createOctokit, parseOwnerRepo, getGitHubToken } from "@/lib/github/client";
import { createDraftRelease } from "@/lib/github/releases";
import { logSyncOperation } from "@/lib/github/sync-log";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const result = db
    .select()
    .from(releases)
    .where(eq(releases.projectId, projectId))
    .orderBy(desc(releases.createdAt))
    .all();

  return NextResponse.json({ data: result });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const {
    version,
    title,
    epicIds,
    generateChangelog = true,
    pushToGitHub = false,
  } = body as {
    version: string;
    title?: string;
    epicIds: string[];
    generateChangelog?: boolean;
    pushToGitHub?: boolean;
  };

  if (!version) {
    return NextResponse.json(
      { error: "version is required" },
      { status: 400 }
    );
  }

  if (!epicIds || epicIds.length === 0) {
    return NextResponse.json(
      { error: "epicIds array is required" },
      { status: 400 }
    );
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Load selected epics
  const selectedEpics = db
    .select()
    .from(epics)
    .where(inArray(epics.id, epicIds))
    .all();

  let changelog = "";

  if (generateChangelog) {
    // Generate changelog via CC plan mode
    const settingsRow = db
      .select()
      .from(settings)
      .where(eq(settings.key, "global_prompt"))
      .get();
    const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

    const epicSummaries = selectedEpics
      .map((e) => `- **${e.title}**: ${e.description || "No description"}`)
      .join("\n");

    const prompt = `${globalPrompt ? `# Global Instructions\n${globalPrompt}\n\n` : ""}# Task: Generate Release Changelog

Generate a markdown changelog for version ${version} of project "${project.name}".

## Completed Epics
${epicSummaries}

## Instructions
- Write a concise, user-facing changelog in markdown
- Group changes by category (Features, Improvements, Bug Fixes) where applicable
- Use bullet points for each change
- Be specific about what was added/changed
- Keep it professional and concise
- Return ONLY the markdown changelog, no extra text`;

    try {
      const { promise } = spawnClaude({
        mode: "plan",
        prompt,
        cwd: project.gitRepoPath || undefined,
      });

      const result = await promise;
      if (result.success && result.result) {
        const parsed = parseClaudeOutput(result.result);
        changelog = parsed.content;
      }
    } catch {
      // Fall back to auto-generated changelog
    }
  }

  // Fallback: auto-generate simple changelog
  if (!changelog) {
    changelog = `# ${version}${title ? ` — ${title}` : ""}\n\n## Changes\n\n${selectedEpics.map((e) => `- ${e.title}`).join("\n")}\n`;
  }

  // Create git tag if repo is configured
  let gitTag: string | null = null;
  if (project.gitRepoPath) {
    try {
      const git = simpleGit(project.gitRepoPath);
      const tagName = `v${version}`;
      await git.addTag(tagName);
      gitTag = tagName;
    } catch {
      // Tag creation failed, continue without it
    }
  }

  // GitHub integration: push tag and create draft release
  let githubReleaseId: number | null = null;
  let githubReleaseUrl: string | null = null;
  let pushedAt: string | null = null;

  if (pushToGitHub && gitTag && project.gitRepoPath && project.githubOwnerRepo) {
    const token = getGitHubToken();
    if (!token) {
      return NextResponse.json(
        { error: "GitHub PAT not configured. Set it in Settings." },
        { status: 400 }
      );
    }

    const git = simpleGit(project.gitRepoPath);
    const { owner, repo } = parseOwnerRepo(project.githubOwnerRepo);

    // Push the tag to origin
    try {
      await git.push("origin", gitTag);
      logSyncOperation(projectId, "tag_push", null, "success", {
        tag: gitTag,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Tag push failed";
      logSyncOperation(projectId, "tag_push", null, "failure", {
        tag: gitTag,
        error: errMsg,
      });
      // Continue without GitHub release if tag push fails
    }

    // Create draft release on GitHub
    try {
      const octokit = createOctokit();
      const ghRelease = await createDraftRelease(
        octokit,
        owner,
        repo,
        gitTag,
        title || `Release ${version}`,
        changelog
      );
      githubReleaseId = ghRelease.id;
      githubReleaseUrl = ghRelease.htmlUrl;
      pushedAt = new Date().toISOString();

      logSyncOperation(projectId, "release_create", null, "success", {
        releaseId: ghRelease.id,
        url: ghRelease.htmlUrl,
        draft: true,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Draft release creation failed";
      logSyncOperation(projectId, "release_create", null, "failure", {
        error: errMsg,
      });
      // Continue — the local release is still saved
    }
  }

  // Save release
  const id = createId();
  db.insert(releases)
    .values({
      id,
      projectId,
      version,
      title: title || null,
      changelog,
      epicIds: JSON.stringify(epicIds),
      gitTag,
      githubReleaseId,
      githubReleaseUrl,
      pushedAt,
      createdAt: new Date().toISOString(),
    })
    .run();

  const release = db.select().from(releases).where(eq(releases.id, id)).get();
  return NextResponse.json({ data: release }, { status: 201 });
}
