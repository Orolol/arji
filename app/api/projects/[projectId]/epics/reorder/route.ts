/**
 * POST /api/projects/:projectId/epics/reorder — the board's ordering
 * endpoint, used by drag-and-drop and by whole-column actions such as
 * "Sort by priority".
 *
 * The position write and the status transitions run through the shared
 * transactional core in lib/workflow/reorder.ts, which the agent-facing
 * reorder MCP tool uses as well — one implementation, so board `position`
 * stays the single ordering source no matter who writes it.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { tryExportArjiJson } from "@/lib/sync/export";
import { reorderTickets } from "@/lib/workflow/reorder";

const reorderSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      position: z.number(),
    })
  ),
  /**
   * "I am only reordering; never move anything." See `reorderOnly` in
   * lib/workflow/reorder.ts for why a whole-column sort needs it and
   * drag-and-drop does not.
   */
  reorderOnly: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(reorderSchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  let result;
  try {
    result = reorderTickets(projectId, body.items, {
      actor: "user",
      source: "drag",
      reason: "Kanban drag-and-drop",
      reorderOnly: body.reorderOnly,
    });
  } catch (error) {
    return errorResponse(error, "Failed to reorder epics");
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.statusCode });
  }

  tryExportArjiJson(projectId);
  return NextResponse.json({
    data: { updated: result.updated, skipped: result.skipped },
  });
}
