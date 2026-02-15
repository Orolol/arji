import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createProjectSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { validatePath } from "@/lib/validation/path";

export async function GET() {
  const queryStartedAt = Date.now();

  const epicCounts = db
    .select({
      projectId: epics.projectId,
      epicCount: count(epics.id).as("epic_count"),
      epicsDone:
        sql<number>`SUM(CASE WHEN ${epics.status} = 'done' THEN 1 ELSE 0 END)`.as(
          "epics_done"
        ),
    })
    .from(epics)
    .groupBy(epics.projectId)
    .as("epic_counts");

  const activeAgentCounts = db
    .select({
      projectId: agentSessions.projectId,
      activeAgents: count(agentSessions.id).as("active_agents"),
    })
    .from(agentSessions)
    .where(eq(agentSessions.status, "running"))
    .groupBy(agentSessions.projectId)
    .as("active_agent_counts");

  const result = db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      gitRepoPath: projects.gitRepoPath,
      githubOwnerRepo: projects.githubOwnerRepo,
      imported: projects.imported,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      epicCount: sql<number>`COALESCE(${epicCounts.epicCount}, 0)`,
      epicsDone: sql<number>`COALESCE(${epicCounts.epicsDone}, 0)`,
      activeAgents: sql<number>`COALESCE(${activeAgentCounts.activeAgents}, 0)`,
    })
    .from(projects)
    .leftJoin(epicCounts, eq(projects.id, epicCounts.projectId))
    .leftJoin(activeAgentCounts, eq(projects.id, activeAgentCounts.projectId))
    .orderBy(projects.updatedAt)
    .all();

  console.debug("[projects/GET] query profile", {
    rowCount: result.length,
    queryMs: Date.now() - queryStartedAt,
  });

  return NextResponse.json({ data: result });
}

export async function POST(request: NextRequest) {
  const validated = await validateBody(createProjectSchema, request);
  if (isValidationError(validated)) return validated;

  const { name, description, gitRepoPath, githubOwnerRepo } = validated.data;

  // Validate gitRepoPath if provided
  if (gitRepoPath) {
    const pathResult = await validatePath(gitRepoPath);
    if (!pathResult.valid) {
      return NextResponse.json(
        { error: pathResult.error },
        { status: 400 }
      );
    }
  }

  const id = createId();
  const now = new Date().toISOString();

  db.insert(projects)
    .values({
      id,
      name,
      description: description || null,
      gitRepoPath: gitRepoPath || null,
      githubOwnerRepo: githubOwnerRepo || null,
      status: "ideation",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const project = db.select().from(projects).where(eq(projects.id, id)).get();

  return NextResponse.json({ data: project }, { status: 201 });
}
