import { withAgentResolutionErrors } from "@/lib/api/agent-resolution-response";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  releases,
  epics,
  userStories,
  settings,
  agentSessions,
} from "@/lib/db/schema";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { createReleaseSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { resolveCliSessionId } from "@/lib/db/resolve-cli-session-id";
import { eq, desc, inArray, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import simpleGit from "simple-git";
import { createDraftRelease } from "@/lib/github/releases";
import { logSyncOperation } from "@/lib/github/sync-log";
import { activityRegistry } from "@/lib/activity-registry";
import { createReleaseBranchAndCommitChangelog, type ReleaseBranchResult } from "@/lib/git/release";
import {
  createQueuedSession,
  markSessionRunning,
  markSessionTerminal,
  isSessionLifecycleConflictError,
} from "@/lib/agent-sessions/lifecycle";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { applyTransition } from "@/lib/workflow/transition-service";
import { emitReleaseCreated } from "@/lib/events/emit";
import { sendProjectWebhook } from "@/lib/webhooks/send";
import { maybeAutoRewriteSpecAfterRelease } from "@/lib/workflow/spec-auto-rewrite";
import type { KanbanStatus } from "@/lib/types/kanban";
import fs from "fs";
import path from "path";

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

export const POST = withAgentResolutionErrors(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(createReleaseSchema, request);
  if (isValidationError(validated)) return validated;

  const {
    version,
    epicIds,
    generateChangelog = true,
    pushToGitHub = false,
  } = validated.data;
  const title = validated.data.title ?? undefined;
  const resumeSessionId = validated.data.resumeSessionId ?? undefined;
  const namedAgentId = validated.data.namedAgentId ?? undefined;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;
  const { project } = found;

  // Load selected epics
  const selectedEpics = db
    .select()
    .from(epics)
    .where(and(inArray(epics.id, epicIds), eq(epics.projectId, projectId)))
    .all();

  // Resolve which agent to use for changelog generation
  const resolvedAgent = resolveAgentByNamedId("release_notes", projectId, namedAgentId);
  const agentProvider = resolvedAgent.provider;

  let changelog = "";
  let releaseBranch: string | null = null;

  let releaseActivityId: string | null = null;

  if (generateChangelog) {
    releaseActivityId = `release-${createId()}`;
    activityRegistry.register({
      id: releaseActivityId,
      projectId,
      type: "release",
      label: `Generating Changelog: v${version}`,
      provider: agentProvider,
      startedAt: new Date().toISOString(),
    });

    // Generate changelog via CC plan mode
    const settingsRow = db
      .select()
      .from(settings)
      .where(eq(settings.key, "global_prompt"))
      .get();
    const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

    const filteredEpicIds = selectedEpics.map((e) => e.id);
    const storiesByEpic = db
      .select()
      .from(userStories)
      .where(inArray(userStories.epicId, filteredEpicIds.length > 0 ? filteredEpicIds : ["__none__"]))
      .all()
      .reduce<Record<string, Array<{ title: string; acceptanceCriteria: string | null }>>>(
        (acc, story) => {
          const list = acc[story.epicId] || [];
          list.push({
            title: story.title,
            acceptanceCriteria: story.acceptanceCriteria,
          });
          acc[story.epicId] = list;
          return acc;
        },
        {}
      );

    const ticketContext = selectedEpics
      .map((e) => {
        const ticketType = e.type === "bug" ? "Bug" : "Feature";
        const stories = storiesByEpic[e.id] || [];
        const storiesText =
          stories.length === 0
            ? "No user stories"
            : stories
                .map(
                  (s) =>
                    `  - ${s.title}${s.acceptanceCriteria ? ` (AC: ${s.acceptanceCriteria})` : ""}`
                )
                .join("\n");
        return [
          `- Ticket: ${e.title}`,
          `  Type: ${ticketType}`,
          `  Description: ${e.description || "No description"}`,
          `  Stories:`,
          storiesText,
        ].join("\n");
      })
      .join("\n");

    const prompt = `${globalPrompt ? `# Global Instructions\n${globalPrompt}\n\n` : ""}# Task: Generate Release Changelog

Generate a markdown changelog for version ${version} of project "${project.name}".

## Included Tickets
${ticketContext}

## Instructions
- Write a concise, user-facing changelog in markdown.
- Use exactly these sections in order:
  1) Features
  2) Bugfixes
  3) Breaking Changes
- Use bullet points in each section.
- If no entries exist for a section, include \"- None\".
- If there are breaking changes, include a short migration guide subsection.
- Be specific and avoid generic wording.
- Return ONLY the markdown changelog, no extra text`;

    try {
      const sessionId = createId();
      const now = new Date().toISOString();
      const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
      fs.mkdirSync(logsDir, { recursive: true });
      const logsPath = path.join(logsDir, "logs.json");

      let cliSessionId: string | undefined;
      let resumeSession = false;
      if (isResumableProvider(agentProvider)) {
        if (resumeSessionId) {
          const previous = db
            .select({
              id: agentSessions.id,
              projectId: agentSessions.projectId,
              provider: agentSessions.provider,
              cliSessionId: agentSessions.cliSessionId,
              claudeSessionId: agentSessions.claudeSessionId,
            })
            .from(agentSessions)
            .where(eq(agentSessions.id, resumeSessionId))
            .get();
          // Legacy-row fallback handled inside resolveCliSessionId().
          const previousCliSessionId = previous ? resolveCliSessionId(previous) : null;
          if (
            previous &&
            previous.projectId === projectId &&
            previous.provider === agentProvider &&
            previousCliSessionId
          ) {
            cliSessionId = previousCliSessionId;
            resumeSession = true;
          }
        }
        if (!cliSessionId && providerAcceptsAssignedSessionId(agentProvider)) {
          cliSessionId = crypto.randomUUID();
        }
      }

      createQueuedSession({
        id: sessionId,
        projectId,
        mode: "plan",
        provider: agentProvider,
        prompt,
        logsPath,
        worktreePath: project.gitRepoPath || null,
        cliSessionId,
        agentType: "release_notes",
        namedAgentName: resolvedAgent.name || null,
        namedAgentId: resolvedAgent.namedAgentId || null,
        compositeAgentId: resolvedAgent.compositeAgentId ?? null,
        model: resolvedAgent.model || null,
        createdAt: now,
      });

      markSessionRunning(sessionId, now);
      processManager.start(
        sessionId,
        {
          mode: "plan",
          prompt,
          cwd: project.gitRepoPath || undefined,
          cliSessionId,
          resumeSession,
        },
        agentProvider
      );

      const info = await waitForProcessCompletion(sessionId, 1200);
      const result = info?.result;

      try {
        fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
      } catch {
        // best effort
      }

      try {
        markSessionTerminal(
          sessionId,
          {
            success: !!result?.success,
            error: result?.error || null,
            outcome: classifySessionOutcome(result, sessionId),
            usage: extractSessionUsage(result),
          },
          new Date().toISOString()
        );
      } catch (error) {
        if (!isSessionLifecycleConflictError(error)) {
          console.error("[release] failed to finalize release-notes session", error);
        }
      }

      if (result?.success && result.result) {
        changelog = resolveSessionOutput(result, sessionId, "");
      }
    } catch {
      // Fall back to auto-generated changelog
    } finally {
      if (releaseActivityId) activityRegistry.unregister(releaseActivityId);
    }
  }

  // Fallback: auto-generate simple changelog
  if (!changelog) {
    const featureLines = selectedEpics
      .filter((e) => e.type !== "bug")
      .map((e) => `- ${e.title}`);
    const bugLines = selectedEpics
      .filter((e) => e.type === "bug")
      .map((e) => `- ${e.title}`);

    changelog = [
      `# ${version}${title ? ` — ${title}` : ""}`,
      "",
      "## Features",
      featureLines.length > 0 ? featureLines.join("\n") : "- None",
      "",
      "## Bugfixes",
      bugLines.length > 0 ? bugLines.join("\n") : "- None",
      "",
      "## Breaking Changes",
      "- None",
      "",
    ].join("\n");
  } else {
    const normalized = changelog.trim();
    const sections = ["## Features", "## Bugfixes", "## Breaking Changes"];
    const missing = sections.filter(
      (section) => !normalized.toLowerCase().includes(section.toLowerCase())
    );
    if (missing.length > 0) {
      changelog = [
        normalized,
        "",
        ...missing.flatMap((section) => [section, "- None", ""]),
      ].join("\n").trim();
    } else {
      changelog = normalized;
    }
  }

  let releaseBranchResult: ReleaseBranchResult | null = null;
  if (project.gitRepoPath) {
    releaseBranchResult = await createReleaseBranchAndCommitChangelog(
      project.gitRepoPath,
      version,
      changelog,
      { defaultBranch: project.defaultBranch }
    );
    releaseBranch = releaseBranchResult.releaseBranch;
  }

  // Create git tag targeting the release branch commit
  let gitTag: string | null = null;
  if (project.gitRepoPath) {
    try {
      const git = simpleGit(project.gitRepoPath);
      const tagName = `v${version}`;
      if (releaseBranchResult?.commitHash) {
        // Tag the specific release branch commit, not HEAD
        await git.tag([tagName, releaseBranchResult.commitHash]);
      } else {
        await git.addTag(tagName);
      }
      gitTag = tagName;
    } catch {
      // Tag creation failed, continue without it
    }
  }

  // GitHub integration: push tag and create draft release
  let githubReleaseId: number | null = null;
  let githubReleaseUrl: string | null = null;
  let pushedAt: string | null = null;
  const githubErrors: string[] = [];

  if (pushToGitHub && gitTag && project.githubOwnerRepo && project.gitRepoPath) {
    const [owner, repo] = project.githubOwnerRepo.split("/");

    // Push tag to remote
    try {
      const git = simpleGit(project.gitRepoPath);
      await git.push("origin", gitTag);
      logSyncOperation({
        projectId,
        operation: "tag_push",
        status: "success",
        detail: { tag: gitTag },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      githubErrors.push(`Tag push failed: ${errorMsg}`);
      logSyncOperation({
        projectId,
        operation: "tag_push",
        status: "failure",
        detail: { tag: gitTag, error: errorMsg },
      });
    }

    // Create draft GitHub release
    try {
      const releaseTitle = title
        ? `v${version} — ${title}`
        : `v${version}`;
      const ghRelease = await createDraftRelease({
        owner,
        repo,
        tag: gitTag,
        title: releaseTitle,
        body: changelog,
      });
      githubReleaseId = ghRelease.id;
      githubReleaseUrl = ghRelease.url;
      pushedAt = new Date().toISOString();
      logSyncOperation({
        projectId,
        operation: "release",
        status: "success",
        detail: { releaseId: ghRelease.id, tag: gitTag, draft: true },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      githubErrors.push(`GitHub release creation failed: ${errorMsg}`);
      logSyncOperation({
        projectId,
        operation: "release",
        status: "failure",
        detail: { tag: gitTag, error: errorMsg },
      });
    }
  }

  // Save release and transition epics atomically
  const id = createId();

  // Pre-validate all epic transitions before committing anything
  for (const epic of selectedEpics) {
    const fromStatus = (epic.status ?? "backlog") as KanbanStatus;
    if (fromStatus !== "done") {
      return NextResponse.json(
        { error: `Epic "${epic.title}" has status "${fromStatus}" — only "done" epics can be released.` },
        { status: 400 }
      );
    }
  }

  db.transaction((tx) => {
    tx.insert(releases)
      .values({
        id,
        projectId,
        version,
        title: title || null,
        changelog,
        epicIds: JSON.stringify(epicIds),
        releaseBranch,
        gitTag,
        githubReleaseId,
        githubReleaseUrl,
        pushedAt,
        createdAt: new Date().toISOString(),
      })
      .run();

    // Transition included epics to "released" and stamp releaseId
    for (const epic of selectedEpics) {
      const fromStatus = (epic.status ?? "backlog") as KanbanStatus;
      const result = applyTransition({
        projectId,
        epicId: epic.id,
        fromStatus,
        toStatus: "released",
        actor: "system",
        source: "release",
        reason: `Released in v${version}`,
      });
      if (!result.valid) {
        throw new Error(`Failed to transition epic "${epic.title}": ${result.error}`);
      }
      tx.update(epics)
        .set({ releaseId: id })
        .where(eq(epics.id, epic.id))
        .run();
    }
  });

  // Emit release:created event for real-time board refresh
  emitReleaseCreated(projectId, id, version, epicIds);

  // Fire-and-forget outbound webhook (no-op unless the project configured one).
  void sendProjectWebhook(projectId, {
    event: "release.created",
    ticketTitle: title ? `v${version} — ${title}` : `v${version}`,
    path: `/projects/${projectId}/releases`,
  });

  // Fire-and-forget spec auto-rewrite ("spec vivante"): a no-op unless the
  // 'spec_auto_rewrite' setting is on. The trigger owns its guards (setting
  // gate, pending spec_generation session) and never rejects.
  void maybeAutoRewriteSpecAfterRelease(projectId, id);

  const release = db.select().from(releases).where(eq(releases.id, id)).get();

  const payload: Record<string, unknown> = { release };
  if (githubErrors.length > 0) {
    payload.githubErrors = githubErrors;
  }

  return NextResponse.json({ data: payload }, { status: 201 });
});
