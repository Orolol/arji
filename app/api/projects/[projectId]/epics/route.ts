import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics, userStories } from "@/lib/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const result = db
    .select({
      id: epics.id,
      projectId: epics.projectId,
      title: epics.title,
      description: epics.description,
      priority: epics.priority,
      status: epics.status,
      position: epics.position,
      branchName: epics.branchName,
      prNumber: epics.prNumber,
      prUrl: epics.prUrl,
      prStatus: epics.prStatus,
      confidence: epics.confidence,
      evidence: epics.evidence,
      createdAt: epics.createdAt,
      updatedAt: epics.updatedAt,
      usCount: sql<number>`(SELECT COUNT(*) FROM user_stories WHERE user_stories.epic_id = "epics"."id")`,
      usDone: sql<number>`(SELECT COUNT(*) FROM user_stories WHERE user_stories.epic_id = "epics"."id" AND user_stories.status = 'done')`,
    })
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .orderBy(epics.position)
    .all();

  return NextResponse.json({ data: result });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const now = new Date().toISOString();

  const normalizedUserStories = Array.isArray(body.userStories)
    ? body.userStories
        .filter(
          (story: { title?: string }) =>
            typeof story?.title === "string" && story.title.trim().length > 0
        )
        .map(
          (story: {
            title: string;
            description?: string | null;
            acceptanceCriteria?: string | null;
          }) => ({
            title: story.title.trim(),
            description:
              typeof story.description === "string" && story.description.trim().length > 0
                ? story.description.trim()
                : null,
            acceptanceCriteria:
              typeof story.acceptanceCriteria === "string" &&
              story.acceptanceCriteria.trim().length > 0
                ? story.acceptanceCriteria.trim()
                : null,
          })
        )
    : [];

  if (!body.title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const maxPos = db
    .select({ max: sql<number>`COALESCE(MAX(position), -1)` })
    .from(epics)
    .where(and(eq(epics.projectId, projectId), eq(epics.status, body.status || "backlog")))
    .get();

  const id = createId();

  db.insert(epics)
    .values({
      id,
      projectId,
      title: body.title,
      description: body.description || null,
      priority: body.priority ?? 0,
      status: body.status || "backlog",
      position: (maxPos?.max ?? -1) + 1,
      branchName: body.branchName || null,
      confidence: body.confidence ?? null,
      evidence: body.evidence || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  if (normalizedUserStories.length > 0) {
    for (let index = 0; index < normalizedUserStories.length; index += 1) {
      const story = normalizedUserStories[index];
      db.insert(userStories)
        .values({
          id: createId(),
          epicId: id,
          title: story.title,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
          status: "todo",
          position: index,
          createdAt: now,
        })
        .run();
    }
  }

  const epic = db.select().from(epics).where(eq(epics.id, id)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json(
    {
      data: {
        ...epic,
        userStoriesCreated: normalizedUserStories.length,
      },
    },
    { status: 201 },
  );
}
