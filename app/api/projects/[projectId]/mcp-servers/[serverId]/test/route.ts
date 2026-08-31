/**
 * POST /api/projects/:projectId/mcp-servers/:serverId/test — handshake with a
 * project-scoped MCP server and report the tools it exposes.
 */

import { NextRequest } from "next/server";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { handleProbeMcpServer } from "@/lib/mcp/probe-route";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; serverId: string }> },
) {
  const { projectId, serverId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  return handleProbeMcpServer(projectId, serverId);
}
