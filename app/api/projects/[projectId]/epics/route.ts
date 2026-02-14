import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics, userStories } from "@/lib/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";
import { createDependencies } from "@/lib/dependencies/crud";
import { CycleError, CrossProjectError } from "@/lib/dependencies/validation";
import { createEpicSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

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
      type: epics.type,
      linkedEpicId: epics.linkedEpicId,
      images: epics.images,
      usCount: sql<number>`(SELECT COUNT(*) FROM user_stories WHERE user_stories.epic_id = "epics"."id")`,
      usDone: sql<number>`(SELECT COUNT(*) FROM user_stories WHERE user_stories.epic_id = "epics"."id" AND user_stories.status = 'done')`,
      latestCommentId: sql<string | null>`(
        SELECT ticket_comments.id
        FROM ticket_comments
        WHERE ticket_comments.epic_id = "epics"."id"
        ORDER BY ticket_comments.created_at DESC, ticket_comments.id DESC
        LIMIT 1
      )`,
      latestCommentAuthor: sql<string | null>`(
        SELECT ticket_comments.author
        FROM ticket_comments
        WHERE ticket_comments.epic_id = "epics"."id"
        ORDER BY ticket_comments.created_at DESC, ticket_comments.id DESC
        LIMIT 1
      )`,
      latestCommentCreatedAt: sql<string | null>`(
        SELECT ticket_comments.created_at
        FROM ticket_comments
        WHERE ticket_comments.epic_id = "epics"."id"
        ORDER BY ticket_comments.created_at DESC, ticket_comments.id DESC
        LIMIT 1
      )`,
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

  const validated = await validateBody(createEpicSchema, request);
  if (isValidationError(validated)) return validated;

  const body = validated.data;
  const now = new Date().toISOString();

  const normalizedUserStories = Array.isArray(body.userStories)
    ? body.userStories
        .filter(
          (story) =>
            typeof story?.title === "string" && story.title.trim().length > 0
        )
        .map((story) => ({
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
        }))
    : [];

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
      type: body.type || "feature",
      linkedEpicId: body.linkedEpicId || null,
      images: body.images ? JSON.stringify(body.images) : null,
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

  // Persist dependency edges if provided by the generation agent
  let dependenciesCreated = 0;
  const dependencyEdges = Array.isArray(body.dependencies) ? body.dependencies : [];
  if (dependencyEdges.length > 0) {
    const edges = dependencyEdges
      .filter(
        (dep) =>
          typeof dep?.ticketId === "string" &&
          typeof dep?.dependsOnTicketId === "string"
      )
      .map((dep) => ({
        // Replace placeholder "self" references with the newly created epic ID
        ticketId: dep.ticketId === "$self" ? id : dep.ticketId,
        dependsOnTicketId:
          dep.dependsOnTicketId === "$self" ? id : dep.dependsOnTicketId,
      }));

    try {
      const created = createDependencies(projectId, edges);
      dependenciesCreated = created.length;
    } catch (error) {
      if (error instanceof CycleError) {
        return NextResponse.json(
          { error: error.message, code: "CYCLE_DETECTED", cycle: error.cycle },
          { status: 422 }
        );
      }
      if (error instanceof CrossProjectError) {
        return NextResponse.json(
          { error: error.message, code: "CROSS_PROJECT_DEPENDENCY" },
          { status: 422 }
        );
      }
      // Non-critical: log but don't fail the epic creation
      console.error("[epics/POST] Failed to create dependencies:", error);
    }
  }

  const epic = db.select().from(epics).where(eq(epics.id, id)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json(
    {
      data: {
        ...epic,
        userStoriesCreated: normalizedUserStories.length,
        dependenciesCreated,
      },
    },
    { status: 201 },
  );
}
