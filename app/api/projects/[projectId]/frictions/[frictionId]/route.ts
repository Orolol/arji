import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { frictions } from "@/lib/db/schema";
import { OPEN_FRICTION_STATUSES } from "@/lib/frictions/constants";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { isValidationError, validateBody } from "@/lib/validation/validate";

const dismissFrictionSchema = z.object({ status: z.literal("dismissed") }).strict();

/** Dismiss an open friction without touching tickets, comments, or workflow. */
export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; frictionId: string }> },
) {
  const { projectId, frictionId } = await params;
  const foundProject = getProjectOr404(projectId);
  if (isErrorResponse(foundProject)) return foundProject;

  const validated = await validateBody(dismissFrictionSchema, request);
  if (isValidationError(validated)) return validated;

  const friction = db
    .select({ id: frictions.id, status: frictions.status })
    .from(frictions)
    .where(and(eq(frictions.id, frictionId), eq(frictions.projectId, projectId)))
    .get();

  if (!friction) {
    return NextResponse.json({ error: "Friction not found" }, { status: 404 });
  }

  const result = db
    .update(frictions)
    .set({ status: validated.data.status })
    .where(
      and(
        eq(frictions.id, frictionId),
        eq(frictions.projectId, projectId),
        inArray(frictions.status, [...OPEN_FRICTION_STATUSES]),
      ),
    )
    .run();

  if (result.changes !== 1) {
    return NextResponse.json(
      { error: "Only an open friction can be dismissed", code: "FRICTION_CLOSED" },
      { status: 409 },
    );
  }

  return NextResponse.json({
    data: db.select().from(frictions).where(eq(frictions.id, frictionId)).get(),
  });
}
