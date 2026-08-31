/**
 * PATCH  /api/settings/mcp-servers/:serverId — edit a global MCP server.
 * DELETE /api/settings/mcp-servers/:serverId — remove one.
 *
 * PATCH is partial. A secret map sent with "***" or "" for a key KEEPS the
 * stored value (the password-field contract: the form never receives the
 * secret, so leaving the input blank must not blank the stored one); a key
 * omitted from the map is dropped.
 */

import { NextRequest } from "next/server";
import {
  handleDeleteMcpServer,
  handleUpdateMcpServer,
} from "@/lib/mcp/server-routes";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params;
  return handleUpdateMcpServer(request, null, serverId);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params;
  return handleDeleteMcpServer(null, serverId);
}
