import { NextRequest, NextResponse } from "next/server";
import { buildExecutionPlan } from "@/lib/dependencies/scheduler";

/**
 * POST /api/projects/:projectId/dependencies/plan
 * Body: { ticketIds: string[] }
 *
 * Returns the DAG execution plan: topological layers for the given tickets.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const { ticketIds } = body as { ticketIds: string[] };

  if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
    return NextResponse.json(
      { error: "ticketIds array is required" },
      { status: 400 }
    );
  }

  try {
    const plan = buildExecutionPlan(projectId, ticketIds);
    return NextResponse.json({
      data: {
        layers: plan.layers,
        ticketCount: ticketIds.length,
        layerCount: plan.layers.length,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to build execution plan" },
      { status: 500 }
    );
  }
}
