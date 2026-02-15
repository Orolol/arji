import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics, ticketComments, userStories } from "@/lib/db/schema";
import { count, eq, sql, and } from "drizzle-orm";
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
  const queryStartedAt = Date.now();

  const storyCounts = db
    .select({
      epicId: userStories.epicId,
      usCount: count(userStories.id).as("us_count"),
      usDone:
        sql<number>`SUM(CASE WHEN ${userStories.status} = 'done' THEN 1 ELSE 0 END)`.as(
          "us_done"
        ),
    })
    .from(userStories)
    .groupBy(userStories.epicId)
    .as("story_counts");

  const rankedEpicComments = db
    .select({
      epicId: ticketComments.epicId,
      latestCommentId: ticketComments.id,
      latestCommentAuthor: ticketComments.author,
      latestCommentCreatedAt: ticketComments.createdAt,
      rowNum: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${ticketComments.epicId}
        ORDER BY ${ticketComments.createdAt} DESC, ${ticketComments.id} DESC
      )`.as("row_num"),
    })
    .from(ticketComments)
    .where(sql`${ticketComments.epicId} IS NOT NULL`)
    .as("ranked_epic_comments");

  const latestEpicComments = db
    .select({
      epicId: rankedEpicComments.epicId,
      latestCommentId: rankedEpicComments.latestCommentId,
      latestCommentAuthor: rankedEpicComments.latestCommentAuthor,
      latestCommentCreatedAt: rankedEpicComments.latestCommentCreatedAt,
    })
    .from(rankedEpicComments)
    .where(eq(rankedEpicComments.rowNum, 1))
    .as("latest_epic_comments");

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
      usCount: sql<number>`COALESCE(${storyCounts.usCount}, 0)`,
      usDone: sql<number>`COALESCE(${storyCounts.usDone}, 0)`,
      latestCommentId: latestEpicComments.latestCommentId,
      latestCommentAuthor: latestEpicComments.latestCommentAuthor,
      latestCommentCreatedAt: latestEpicComments.latestCommentCreatedAt,
    })
    .from(epics)
    .leftJoin(storyCounts, eq(epics.id, storyCounts.epicId))
    .leftJoin(latestEpicComments, eq(epics.id, latestEpicComments.epicId))
    .where(eq(epics.projectId, projectId))
    .orderBy(epics.position)
    .all();

  console.debug("[epics/GET] query profile", {
    projectId,
    rowCount: result.length,
    queryMs: Date.now() - queryStartedAt,
  });

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
  const storiesToInsert = normalizedUserStories.map((story, index) => ({
    id: createId(),
    epicId: id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    status: "todo",
    position: index,
    createdAt: now,
  }));

  try {
    db.transaction((tx) => {
      tx.insert(epics)
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
      if (storiesToInsert.length > 0) {
        tx.insert(userStories).values(storiesToInsert).run();
      }
    });
  } catch (error) {
    console.error("[epics/POST] Failed to create epic transaction:", error);
    return NextResponse.json({ error: "Failed to create epic" }, { status: 500 });
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
        userStoriesCreated: storiesToInsert.length,
        dependenciesCreated,
      },
    },
    { status: 201 },
  );
}
