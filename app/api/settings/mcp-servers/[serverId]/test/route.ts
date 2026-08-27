/**
 * POST /api/settings/mcp-servers/:serverId/test — handshake with a global
 * MCP server and report the tools it exposes.
 *
 * A failing test never blocks anything: it records health, it does not gate
 * builds. See lib/mcp/probe.ts.
 */

import { NextRequest } from "next/server";
import { handleProbeMcpServer } from "@/lib/mcp/probe-route";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params;
  return handleProbeMcpServer(null, serverId);
}
