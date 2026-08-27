import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, agentSessions } from "@/lib/db/schema";
import { count, eq, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createProjectSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { validatePath } from "@/lib/validation/path";
import { deriveCloneProvenance } from "@/lib/projects/clone-provenance";

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
      epicsInProgress:
        sql<number>`SUM(CASE WHEN ${epics.status} = 'in_progress' THEN 1 ELSE 0 END)`.as(
          "epics_in_progress"
        ),
      epicsReview:
        sql<number>`SUM(CASE WHEN ${epics.status} = 'review' THEN 1 ELSE 0 END)`.as(
          "epics_review"
        ),
      epicsReleased:
        sql<number>`SUM(CASE WHEN ${epics.status} = 'released' THEN 1 ELSE 0 END)`.as(
          "epics_released"
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

  // `agent_sessions.created_at` defaults to sqlite CURRENT_TIMESTAMP
  // ("YYYY-MM-DD HH:MM:SS", UTC) while rows written by the app carry a full
  // ISO string. Normalise to ISO-UTC *before* MAX() so the comparison and the
  // value handed to the client are both unambiguous.
  const lastSessionTimes = db
    .select({
      projectId: agentSessions.projectId,
      lastSessionAt: sql<string | null>`MAX(
        CASE
          WHEN ${agentSessions.createdAt} LIKE '%T%' THEN ${agentSessions.createdAt}
          ELSE replace(${agentSessions.createdAt}, ' ', 'T') || 'Z'
        END
      )`.as("last_session_at"),
    })
    .from(agentSessions)
    .groupBy(agentSessions.projectId)
    .as("last_session_times");

  const result = db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      gitRepoPath: projects.gitRepoPath,
      githubOwnerRepo: projects.githubOwnerRepo,
      cloneSource: projects.cloneSource,
      gitRemoteUrl: projects.gitRemoteUrl,
      imported: projects.imported,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      epicCount: sql<number>`COALESCE(${epicCounts.epicCount}, 0)`,
      epicsDone: sql<number>`COALESCE(${epicCounts.epicsDone}, 0)`,
      epicsInProgress: sql<number>`COALESCE(${epicCounts.epicsInProgress}, 0)`,
      epicsReview: sql<number>`COALESCE(${epicCounts.epicsReview}, 0)`,
      epicsReleased: sql<number>`COALESCE(${epicCounts.epicsReleased}, 0)`,
      activeAgents: sql<number>`COALESCE(${activeAgentCounts.activeAgents}, 0)`,
      lastSessionAt: sql<string | null>`${lastSessionTimes.lastSessionAt}`,
    })
    .from(projects)
    .leftJoin(epicCounts, eq(projects.id, epicCounts.projectId))
    .leftJoin(activeAgentCounts, eq(projects.id, activeAgentCounts.projectId))
    .leftJoin(lastSessionTimes, eq(projects.id, lastSessionTimes.projectId))
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

  const {
    name,
    description,
    gitRepoPath,
    githubOwnerRepo,
    gitRemoteUrl,
    defaultBranch,
  } = validated.data;

  const cleanDefaultBranch = defaultBranch?.trim();
  if (cleanDefaultBranch && cleanDefaultBranch.startsWith("-")) {
    return NextResponse.json(
      { error: `Invalid default branch: ${cleanDefaultBranch}` },
      { status: 400 }
    );
  }

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

  // Provenance is read off the disk, not off the request: `clone_source` is what
  // later authorises deleting this directory, so it may only be granted by a
  // marker the clone service wrote into a repository it created itself.
  const provenance = deriveCloneProvenance(gitRepoPath);

  const id = createId();
  const now = new Date().toISOString();

  db.insert(projects)
    .values({
      id,
      name,
      description: description || null,
      gitRepoPath: gitRepoPath || null,
      githubOwnerRepo:
        githubOwnerRepo || provenance.githubOwnerRepo || null,
      cloneSource: provenance.cloneSource,
      gitRemoteUrl: provenance.gitRemoteUrl || gitRemoteUrl || null,
      defaultBranch: cleanDefaultBranch || null,
      status: "ideation",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const project = db.select().from(projects).where(eq(projects.id, id)).get();

  return NextResponse.json({ data: project }, { status: 201 });
}
