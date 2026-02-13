import { NextRequest, NextResponse } from "next/server";
import {
  createDependencies,
  getProjectDependencies,
} from "@/lib/dependencies/crud";
import {
  CycleError,
  CrossProjectError,
} from "@/lib/dependencies/validation";

/**
 * GET /api/projects/[projectId]/dependencies
 * List all dependency edges for a project.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const deps = getProjectDependencies(projectId);
  return NextResponse.json({ data: deps });
}

/**
 * POST /api/projects/[projectId]/dependencies
 * Create one or more dependency edges.
 * Body: { edges: [{ ticketId, dependsOnTicketId }] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();

  const { edges } = body as {
    edges?: Array<{ ticketId: string; dependsOnTicketId: string }>;
  };

  if (!edges || !Array.isArray(edges) || edges.length === 0) {
    return NextResponse.json(
      { error: "edges array is required and must not be empty" },
      { status: 400 }
    );
  }

  // Validate edge structure
  for (const edge of edges) {
    if (!edge.ticketId || !edge.dependsOnTicketId) {
      return NextResponse.json(
        { error: "Each edge must have ticketId and dependsOnTicketId" },
        { status: 400 }
      );
    }
    if (edge.ticketId === edge.dependsOnTicketId) {
      return NextResponse.json(
        { error: "A ticket cannot depend on itself" },
        { status: 400 }
      );
    }
  }

  try {
    const created = createDependencies(projectId, edges);
    return NextResponse.json({ data: created }, { status: 201 });
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
          error instanceof Error ? error.message : "Failed to create dependencies",
      },
      { status: 500 }
    );
  }
}
