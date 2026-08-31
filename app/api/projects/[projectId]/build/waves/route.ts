import { NextRequest, NextResponse } from "next/server";
import { dagBatchRegistry } from "@/lib/agents/dag-batch-registry";

/**
 * GET /api/projects/[projectId]/build/waves
 *
 * Live snapshots of the project's active DAG (wave) batch builds, read from
 * the in-process registry. Polled by `components/desk/WaveRunChips` for its compact
 * "Wave 2/4" indicator. Finished batches disappear from the list.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  return NextResponse.json({ data: dagBatchRegistry.listByProject(projectId) });
}
