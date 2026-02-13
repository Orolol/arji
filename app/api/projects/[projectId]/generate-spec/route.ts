import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, chatMessages, epics, userStories } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { spawnClaude } from "@/lib/claude/spawn";
import { buildSpecGenerationPrompt } from "@/lib/claude/prompt-builder";
import { extractJsonFromOutput, parseClaudeOutput } from "@/lib/claude/json-parser";
import { tryExportArjiJson } from "@/lib/sync/export";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { getProvider } from "@/lib/providers";
import type { ProviderType } from "@/lib/providers";
import { activityRegistry } from "@/lib/activity-registry";
import { resolveAgent } from "@/lib/agent-config/providers";
import { listProjectTextDocuments } from "@/lib/documents/query";
import {
  enrichPromptWithDocumentMentions,
  MentionResolutionError,
} from "@/lib/documents/mentions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  let providerOverride: ProviderType | undefined;
  try {
    const body = await request.json();
    if (body.provider === "codex" || body.provider === "gemini-cli" || body.provider === "claude-code") {
      providerOverride = body.provider;
    }
  } catch {
    // No body or invalid JSON — use default
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const docs = listProjectTextDocuments(projectId);
  const chatHistory = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.projectId, projectId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(30)
    .all()
    .reverse();

  const specSystemPrompt = await resolveAgentPrompt(
    "spec_generation",
    projectId
  );

  const prompt = buildSpecGenerationPrompt(
    project,
    docs,
    chatHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    specSystemPrompt
  );
  let enrichedPrompt = prompt;
  try {
    enrichedPrompt = enrichPromptWithDocumentMentions({
      projectId,
      prompt,
      textSources: chatHistory.map((m) => m.content),
    }).prompt;
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const resolvedAgent = await resolveAgent(
    "spec_generation",
    projectId,
    providerOverride
  );

  const specActivityId = `spec-${createId()}`;
  activityRegistry.register({
    id: specActivityId,
    projectId,
    type: "spec_generation",
    label: "Generating Spec & Plan",
    provider: resolvedAgent.provider,
    startedAt: new Date().toISOString(),
  });

  try {
    let result;
    if (resolvedAgent.provider === "codex" || resolvedAgent.provider === "gemini-cli") {
      const dynamicProvider = getProvider(resolvedAgent.provider);
      const session = dynamicProvider.spawn({
        sessionId: `spec-${createId()}`,
        prompt: enrichedPrompt,
        cwd: project.gitRepoPath || process.cwd(),
        mode: "plan",
        model: resolvedAgent.model,
        logIdentifier: `spec-${projectId}`,
      });
      result = await session.promise;
    } else {
      const { promise } = spawnClaude({
        mode: "plan",
        prompt: enrichedPrompt,
        model: resolvedAgent.model,
        cwd: project.gitRepoPath || undefined,
      });
      result = await promise;
    }

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Claude Code failed" }, { status: 500 });
    }

    const rawOutput = result.result || "";

    // Try to extract structured JSON
    const specData = extractJsonFromOutput<{
      spec?: string;
      epics?: Array<{
        title: string;
        description?: string;
        priority?: number;
        status?: string;
        user_stories?: Array<{
          title: string;
          description?: string;
          acceptance_criteria?: string;
          status?: string;
        }>;
      }>;
    }>(rawOutput);

    if (!specData || !specData.epics) {
      // If not JSON, treat as spec text
      const parsed = parseClaudeOutput(rawOutput);
      console.log("[generate-spec] No JSON found, treating as spec text. Preview:", parsed.content.slice(0, 300));

      db.update(projects)
        .set({ spec: parsed.content, status: "specifying", updatedAt: new Date().toISOString() })
        .where(eq(projects.id, projectId))
        .run();

      tryExportArjiJson(projectId);
      return NextResponse.json({ data: { spec: parsed.content, epicsCreated: 0 } });
    }

    // Update project spec
    if (specData.spec) {
      db.update(projects)
        .set({ spec: specData.spec, status: "specifying", updatedAt: new Date().toISOString() })
        .where(eq(projects.id, projectId))
        .run();
    }

    // Insert epics and user stories
    let epicsCreated = 0;
    if (specData.epics) {
      for (let i = 0; i < specData.epics.length; i++) {
        const epicData = specData.epics[i];
        const epicId = createId();
        const now = new Date().toISOString();

        db.insert(epics)
          .values({
            id: epicId,
            projectId,
            title: epicData.title,
            description: epicData.description || null,
            priority: epicData.priority ?? 0,
            status: epicData.status || "backlog",
            position: i,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        if (epicData.user_stories) {
          for (let j = 0; j < epicData.user_stories.length; j++) {
            const usData = epicData.user_stories[j];
            db.insert(userStories)
              .values({
                id: createId(),
                epicId,
                title: usData.title,
                description: usData.description || null,
                acceptanceCriteria: usData.acceptance_criteria || null,
                status: usData.status || "todo",
                position: j,
                createdAt: now,
              })
              .run();
          }
        }

        epicsCreated++;
      }
    }

    tryExportArjiJson(projectId);
    return NextResponse.json({ data: { spec: specData.spec, epicsCreated } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  } finally {
    activityRegistry.unregister(specActivityId);
  }
}
