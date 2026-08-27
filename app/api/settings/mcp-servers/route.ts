/**
 * GET  /api/settings/mcp-servers — the GLOBAL third-party MCP servers.
 * POST /api/settings/mcp-servers — declare one.
 *
 * Global servers are injected into every project's sessions (see
 * lib/mcp/servers.ts resolveExtraMcpServers). Per-project servers live under
 * /api/projects/:projectId/mcp-servers and share these handlers.
 *
 * `env` and `headers` values are write-only: they go in here and never come
 * back out — reads return "***" per key.
 */

import { NextRequest } from "next/server";
import {
  handleCreateMcpServer,
  handleListMcpServers,
} from "@/lib/mcp/server-routes";

export async function GET() {
  return handleListMcpServers(null);
}

export async function POST(request: NextRequest) {
  return handleCreateMcpServer(request, null);
}
