/**
 * POST /api/projects/:projectId/mcp-servers/shadow — turn an inherited global
 * server off for THIS project.
 *
 * Implemented as a shadow row rather than a per-project disable flag: the
 * resolver already gives a project entry precedence over a global of the same
 * name, so a disabled local copy is the existing mechanism rather than a
 * second one. It also leaves the user somewhere to go next — the copy is a
 * normal project entry they can re-enable or edit into a real override.
 *
 * 409 when the project already has an entry of that name: there is nothing to
 * create, and silently editing the row they already have would be a surprise.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { disableGlobalForProject } from "@/lib/mcp/servers";
import { mcpServerErrorResponse } from "@/lib/mcp/server-routes";

const bodySchema = z.object({ globalServerId: z.string().min(1) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "globalServerId is required" },
      { status: 400 },
    );
  }

  try {
    const data = disableGlobalForProject(
      projectId,
      parsed.data.globalServerId,
    );
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}
