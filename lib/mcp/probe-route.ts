/**
 * Shared handler for the two connection-test routes (global and project
 * scope). See lib/mcp/probe.ts for the probe itself.
 *
 * The outcome is PERSISTED (`last_checked_at`, `last_check_ok`,
 * `last_check_error`) before it is returned, so the health badge survives a
 * reload — a recovery affordance that only exists in a response is one that
 * vanishes on remount.
 */

import { NextResponse } from "next/server";
import { probeMcpServer } from "./probe";
import { mcpServerSpecById, persistMcpServerCheck } from "./servers";
import { mcpServerErrorResponse } from "./server-routes";

export async function handleProbeMcpServer(
  projectId: string | null,
  serverId: string,
): Promise<NextResponse> {
  try {
    const spec = mcpServerSpecById(serverId, undefined, projectId);
    if (spec === undefined) {
      return NextResponse.json(
        { error: `MCP server "${serverId}" not found in this scope` },
        { status: 404 },
      );
    }
    if (spec === null) {
      const error =
        "This server is missing the fields its transport requires (a command for stdio, a URL for http).";
      persistMcpServerCheck(serverId, false, error, undefined, projectId);
      return NextResponse.json({
        data: { ok: false, toolCount: 0, toolNames: [], error },
      });
    }

    const result = await probeMcpServer(spec);
    persistMcpServerCheck(
      serverId,
      result.ok,
      result.error,
      undefined,
      projectId,
    );
    return NextResponse.json({ data: result });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}
