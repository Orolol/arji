import { NextRequest, NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { frictions } from "@/lib/db/schema";
import { OPEN_FRICTION_STATUSES } from "@/lib/frictions/constants";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";

/** Project-local friction inbox, ordered by the strongest recurring signal. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const foundProject = getProjectOr404(projectId);
  if (isErrorResponse(foundProject)) return foundProject;

  const rows = db
    .select()
    .from(frictions)
    .where(eq(frictions.projectId, projectId))
    .orderBy(desc(frictions.occurrences), desc(frictions.createdAt), asc(frictions.id))
    .all();

  const openCount = rows.filter((row) =>
    OPEN_FRICTION_STATUSES.includes(
      row.status as (typeof OPEN_FRICTION_STATUSES)[number],
    ),
  ).length;

  return NextResponse.json({ data: { frictions: rows, openCount } });
}
