/**
 * POST /api/mcp/submit-grading — the mcp__arij__submit_grading tool.
 *
 * A report always targets the epic from the submitting session's bearer
 * token. Every story reference is checked against that epic before the one
 * atomic report row is written; a mixed valid/invalid payload therefore
 * cannot leave partial grading data behind.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { gradingReports, userStories } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken, resolveTicketForToken } from "@/lib/mcp/http-auth";

const gradingSchema = z
  .object({
    storyId: z.string().min(1),
    criterion: z.string().min(1).max(4000),
    status: z.enum(["met", "partial", "missed"]),
    evidence: z.string().min(1).max(4000),
  })
  .strict();

const bodySchema = z
  .object({
    gradings: z.array(gradingSchema).min(1).max(100),
    summary: z.string().min(1).max(4000),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request, "submit_grading");
  if (isErrorResponse(auth)) return auth;

  // Chat turns have project-scoped tokens but no grader session or launch
  // ticket. This mirrors submit_findings' agent-only boundary.
  if (auth.agentType === "chat") {
    return NextResponse.json(
      {
        error: "submit_grading is only available to agent sessions.",
        code: "FORBIDDEN",
      },
      { status: 403 }
    );
  }

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const found = resolveTicketForToken(auth);
  if (isErrorResponse(found)) return found;
  const { epic } = found;

  const requestedStoryIds = [...new Set(body.gradings.map((item) => item.storyId))];
  const scopedStories = db
    .select({ id: userStories.id })
    .from(userStories)
    .where(
      and(
        eq(userStories.epicId, epic.id),
        inArray(userStories.id, requestedStoryIds)
      )
    )
    .all();
  const scopedStoryIds = new Set(scopedStories.map((story) => story.id));
  const invalidStoryId = requestedStoryIds.find(
    (storyId) => !scopedStoryIds.has(storyId)
  );

  if (invalidStoryId) {
    return NextResponse.json(
      {
        error: `Story "${invalidStoryId}" does not belong to ticket "${epic.id}". Use a storyId returned by get_ticket for this ticket.`,
        code: "STORY_NOT_IN_EPIC",
      },
      { status: 400 }
    );
  }

  const reportId = createId();
  db.insert(gradingReports)
    .values({
      id: reportId,
      epicId: epic.id,
      agentSessionId: auth.sessionId,
      gradings: JSON.stringify(body.gradings),
      summary: body.summary,
      createdAt: new Date().toISOString(),
    })
    .run();

  return NextResponse.json({ data: { reportId } });
}
