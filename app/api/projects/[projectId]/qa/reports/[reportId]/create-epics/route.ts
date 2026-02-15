import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, projects, qaReports, userStories } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { resolveAgentByNamedId } from "@/lib/agent-config/providers";
import { spawnClaude } from "@/lib/claude/spawn";
import { extractJsonFromOutput } from "@/lib/claude/json-parser";
import { getProvider } from "@/lib/providers";

type Params = { params: Promise<{ projectId: string; reportId: string }> };

interface GeneratedStory {
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
}

interface GeneratedEpic {
  title: string;
  description: string;
  priority: number;
  type: "feature";
  userStories: GeneratedStory[];
}

const RAW_SNIPPET_LIMIT = 1200;

function toSnippet(value: string, limit = RAW_SNIPPET_LIMIT): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}... [truncated]`;
}

function toGeneratedStories(value: unknown): GeneratedStory[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as {
        title?: unknown;
        description?: unknown;
        acceptanceCriteria?: unknown;
        acceptance_criteria?: unknown;
      };
      const title =
        typeof row.title === "string" ? row.title.trim() : "";
      if (!title) return null;

      const description =
        typeof row.description === "string" && row.description.trim()
          ? row.description.trim()
          : null;

      const acceptanceRaw =
        typeof row.acceptanceCriteria === "string"
          ? row.acceptanceCriteria
          : typeof row.acceptance_criteria === "string"
            ? row.acceptance_criteria
            : null;

      return {
        title,
        description,
        acceptanceCriteria: acceptanceRaw?.trim() || null,
      } satisfies GeneratedStory;
    })
    .filter((story): story is GeneratedStory => story !== null);
}

function normalizePriority(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 1;
  const clamped = Math.max(0, Math.min(3, Math.round(parsed)));
  return clamped;
}

function toGeneratedEpics(value: unknown): GeneratedEpic[] {
  const rows =
    Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { epics?: unknown[] }).epics)
        ? (value as { epics: unknown[] }).epics
        : [];

  return rows
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as {
        title?: unknown;
        description?: unknown;
        priority?: unknown;
        userStories?: unknown;
        user_stories?: unknown;
      };

      const title = typeof row.title === "string" ? row.title.trim() : "";
      if (!title) return null;

      const stories = toGeneratedStories(row.userStories ?? row.user_stories);
      if (stories.length === 0) return null;

      return {
        title,
        description:
          typeof row.description === "string" && row.description.trim()
            ? row.description.trim()
            : "Epic generated from QA report findings.",
        priority: normalizePriority(row.priority),
        type: "feature" as const,
        userStories: stories,
      } satisfies GeneratedEpic;
    })
    .filter((epic): epic is GeneratedEpic => epic !== null);
}

export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId, reportId } = await params;

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const report = db
    .select()
    .from(qaReports)
    .where(and(eq(qaReports.id, reportId), eq(qaReports.projectId, projectId)))
    .get();
  if (!report || !report.reportContent?.trim()) {
    return NextResponse.json(
      { error: "Report not found or empty" },
      { status: 404 },
    );
  }

  const prompt = `# Tech Check Report

${report.reportContent}

# Task

Based on the tech check report above, generate a list of epics to address the findings. Group related findings into cohesive epics. Prioritize by severity.

Return ONLY a JSON array with the following structure:

\`\`\`json
[
  {
    "title": "Epic title",
    "description": "Detailed description including specific findings and recommended changes",
    "priority": 2,
    "userStories": [
      {
        "title": "As a developer, I want [specific fix] so that [benefit]",
        "description": "Details",
        "acceptanceCriteria": "- [ ] Criterion 1\\n- [ ] Criterion 2"
      }
    ]
  }
]
\`\`\`

Rules:
- Priority: 0=low, 1=medium, 2=high, 3=critical
- All items are epics (type "feature") — do NOT create bug tickets
- Group related findings (including bug fixes) into cohesive epics with user stories
- Each epic should have 1-5 user stories
- Be specific and reference file paths and concrete changes
`;

  const resolvedAgent = resolveAgentByNamedId(
    "tech_check",
    projectId,
    report.namedAgentId ?? null,
  );

  let result: { success: boolean; result?: string; error?: string };
  if (resolvedAgent.provider === "codex" || resolvedAgent.provider === "gemini-cli") {
    const dynamicProvider = getProvider(resolvedAgent.provider);
    const session = dynamicProvider.spawn({
      sessionId: `qa-epics-${createId()}`,
      prompt,
      cwd: project.gitRepoPath || process.cwd(),
      mode: "plan",
      model: resolvedAgent.model,
    });
    result = await session.promise;
  } else {
    const run = spawnClaude({
      mode: "plan",
      prompt,
      cwd: project.gitRepoPath || process.cwd(),
      model: resolvedAgent.model,
    });
    result = await run.promise;
  }

  if (!result.success || !result.result) {
    return NextResponse.json(
      { error: result.error || "Failed to generate epics" },
      { status: 500 },
    );
  }

  const extracted = extractJsonFromOutput<unknown>(result.result);
  if (extracted === null || typeof extracted !== "object") {
    const rawSnippet = toSnippet(result.result);
    console.error("[qa/create-epics] Parsed non-object JSON from agent response", {
      parsedType: extracted === null ? "null" : typeof extracted,
      rawOutput: result.result,
    });
    return NextResponse.json(
      {
        error: "Failed to parse epics JSON from agent response",
        rawSnippet,
      },
      { status: 500 },
    );
  }

  const generatedEpics = toGeneratedEpics(extracted);
  if (generatedEpics.length === 0) {
    const rawSnippet = toSnippet(result.result);
    console.error("[qa/create-epics] JSON payload could not be normalized into epics", {
      rawOutput: result.result,
      extracted,
    });
    return NextResponse.json(
      {
        error: "Failed to parse epics JSON from agent response",
        rawSnippet,
      },
      { status: 500 },
    );
  }

  const maxPositionResult = db
    .select({ max: sql<number>`COALESCE(MAX(${epics.position}), -1)` })
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .get();
  const maxPosition = maxPositionResult?.max ?? -1;

  const now = new Date().toISOString();
  const epicsToInsert = generatedEpics.map((generatedEpic, epicIndex) => ({
    id: createId(),
    projectId,
    title: generatedEpic.title,
    description: generatedEpic.description,
    priority: generatedEpic.priority,
    status: "backlog",
    position: maxPosition + 1 + epicIndex,
    type: generatedEpic.type,
    createdAt: now,
    updatedAt: now,
  }));
  const created = epicsToInsert.map((epicRow) => ({
    id: epicRow.id,
    title: epicRow.title,
  }));

  const storiesToInsert = generatedEpics.flatMap((generatedEpic, epicIndex) =>
    generatedEpic.userStories.map((story, storyIndex) => ({
      id: createId(),
      epicId: epicsToInsert[epicIndex].id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      status: "todo",
      position: storyIndex,
      createdAt: now,
    })),
  );

  try {
    db.transaction((tx) => {
      tx.insert(epics).values(epicsToInsert).run();
      if (storiesToInsert.length > 0) {
        tx.insert(userStories).values(storiesToInsert).run();
      }
    });
  } catch (error) {
    console.error("[qa/create-epics] Failed to persist epics transaction", error);
    return NextResponse.json(
      { error: "Failed to persist generated epics" },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { epics: created } });
}
