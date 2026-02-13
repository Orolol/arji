import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getTicketDependencies,
  getTicketDependents,
} from "@/lib/dependencies/validation";
import { setTicketDependencies } from "@/lib/dependencies/crud";
import { CycleError, CrossProjectError } from "@/lib/dependencies/validation";

type RouteParams = { params: Promise<{ projectId: string; epicId: string }> };

/**
 * GET /api/projects/[projectId]/epics/[epicId]/dependencies
 * Returns both predecessors (depends on) and successors (depended on by).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { projectId, epicId } = await params;

  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const predecessors = getTicketDependencies(epicId);
  const successors = getTicketDependents(epicId);

  return NextResponse.json({
    data: {
      predecessors,
      successors,
    },
  });
}

/**
 * PUT /api/projects/[projectId]/epics/[epicId]/dependencies
 * Replace all predecessors for this epic.
 * Body: { dependsOnIds: string[] }
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { projectId, epicId } = await params;
  const body = await request.json();

  const { dependsOnIds } = body as { dependsOnIds?: string[] };

  if (!Array.isArray(dependsOnIds)) {
    return NextResponse.json(
      { error: "dependsOnIds array is required" },
      { status: 400 }
    );
  }

  // Validate epic exists
  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  // Validate no self-references
  if (dependsOnIds.includes(epicId)) {
    return NextResponse.json(
      { error: "A ticket cannot depend on itself" },
      { status: 400 }
    );
  }

  try {
    const created = setTicketDependencies(projectId, epicId, dependsOnIds);
    return NextResponse.json({ data: created });
  } catch (error) {
    if (error instanceof CycleError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "CYCLE_DETECTED",
          cycle: error.cycle,
        },
        { status: 422 }
      );
    }
    if (error instanceof CrossProjectError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "CROSS_PROJECT_DEPENDENCY",
        },
        { status: 422 }
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update dependencies",
      },
      { status: 500 }
    );
  }
}
