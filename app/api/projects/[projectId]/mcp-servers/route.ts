/**
 * GET  /api/projects/:projectId/mcp-servers — this project's MCP servers,
 *      the globals it inherits, and the providers that ignore project scope.
 * POST /api/projects/:projectId/mcp-servers — declare one for this project.
 *
 * A project entry SHADOWS a global of the same name (the project wins), which
 * is also how a global gets disabled for one project: a same-named local entry
 * with `enabled: false`. See POST .../mcp-servers/shadow for the one-click
 * form of that.
 *
 * Not every provider honors this scope: oh-my-pi and agy read a user-global
 * registry Arij cannot vary per spawn, so they only ever see global servers.
 * `unsupportedProviders` carries that list to the UI rather than leaving the
 * user to infer it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { describeProjectMcpServers } from "@/lib/mcp/servers";
import {
  handleCreateMcpServer,
  mcpServerErrorResponse,
} from "@/lib/mcp/server-routes";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  try {
    return NextResponse.json({ data: describeProjectMcpServers(projectId) });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  return handleCreateMcpServer(request, projectId);
}
