import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, epics, agentSessions } from "@/lib/db/schema";
import { eq, count, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";

export async function GET() {
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
      epicCount: sql<number>`(SELECT COUNT(*) FROM epics WHERE epics.project_id = ${projects.id})`,
      epicsDone: sql<number>`(SELECT COUNT(*) FROM epics WHERE epics.project_id = ${projects.id} AND epics.status = 'done')`,
      activeAgents: sql<number>`(SELECT COUNT(*) FROM agent_sessions WHERE agent_sessions.project_id = ${projects.id} AND agent_sessions.status = 'running')`,
    })
    .from(projects)
    .orderBy(projects.updatedAt)
    .all();

  return NextResponse.json({ data: result });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, description, gitRepoPath, githubOwnerRepo } = body;

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
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
