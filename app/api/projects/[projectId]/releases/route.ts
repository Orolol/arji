import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  releases,
  projects,
  epics,
  documents,
  settings,
} from "@/lib/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaude } from "@/lib/claude/spawn";
import { parseClaudeOutput } from "@/lib/claude/json-parser";
import simpleGit from "simple-git";
import { activityRegistry } from "@/lib/activity-registry";

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
  const { version, title, epicIds, generateChangelog = true } = body as {
    version: string;
    title?: string;
    epicIds: string[];
    generateChangelog?: boolean;
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

  let releaseActivityId: string | null = null;

  if (generateChangelog) {
    releaseActivityId = `release-${createId()}`;
    activityRegistry.register({
      id: releaseActivityId,
      projectId,
      type: "release",
      label: `Generating Changelog: v${version}`,
      provider: "claude-code",
      startedAt: new Date().toISOString(),
    });

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
    } finally {
      if (releaseActivityId) activityRegistry.unregister(releaseActivityId);
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
      createdAt: new Date().toISOString(),
    })
    .run();

  const release = db.select().from(releases).where(eq(releases.id, id)).get();
  return NextResponse.json({ data: release }, { status: 201 });
}
