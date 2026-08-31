/**
 * PATCH  /api/projects/:projectId/mcp-servers/:serverId — edit a project MCP server.
 * DELETE /api/projects/:projectId/mcp-servers/:serverId — remove one.
 *
 * Scoped by construction: the service resolves `serverId` WITHIN the project,
 * so these routes cannot reach a global entry (or another project's) even if
 * asked to — that would be a 404 here and an edit on the global route there.
 */

import { NextRequest } from "next/server";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  handleDeleteMcpServer,
  handleUpdateMcpServer,
} from "@/lib/mcp/server-routes";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; serverId: string }> },
) {
  const { projectId, serverId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  return handleUpdateMcpServer(request, projectId, serverId);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; serverId: string }> },
) {
  const { projectId, serverId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  return handleDeleteMcpServer(projectId, serverId);
}
