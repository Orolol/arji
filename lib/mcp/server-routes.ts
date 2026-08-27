/**
 * Shared request handling for the MCP-server CRUD routes.
 *
 * The global scope (`/api/settings/mcp-servers`) and the project scope
 * (`/api/projects/:projectId/mcp-servers`) are the SAME operations against a
 * different `projectId` (null vs. a value), so the handlers live here once and
 * the route files stay thin. Keeping one implementation is what makes the two
 * scopes behave identically — the reserved `arij` name, the per-scope name
 * uniqueness, the caps, and the write-only secret contract are enforced in one
 * place rather than twice.
 *
 * Error mapping (the route envelope contract in lib/api/route-helpers.ts):
 *   McpServerValidationError → 400
 *   McpServerNotFoundError   → 404
 *   McpServerConflictError   → 409
 * A validation error carries the same shape whether it came from Zod or from
 * the shape/cap rules, so the UI has one alert path.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  McpServerConflictError,
  McpServerNotFoundError,
  McpServerValidationError,
  createMcpServer,
  createMcpServerSchema,
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  updateMcpServerSchema,
} from "./servers";

/** Maps a service error to the route envelope; rethrows anything unexpected. */
export function mcpServerErrorResponse(error: unknown): NextResponse {
  if (error instanceof McpServerValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof McpServerNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof McpServerConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return NextResponse.json(
    {
      error:
        error instanceof Error ? error.message : "MCP server request failed",
    },
    { status: 500 },
  );
}

async function parseBody(request: NextRequest): Promise<unknown | NextResponse> {
  try {
    return await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

/**
 * The first Zod message, flattened to the same single-string shape the
 * service's own validation errors use — an over-long `env` value and an
 * unknown transport must not reach the UI down two different paths.
 */
function firstZodMessage(error: { issues: Array<{ message: string; path: PropertyKey[] }> }): string {
  const issue = error.issues[0];
  if (!issue) return "Validation failed";
  const field = issue.path.filter((p) => typeof p === "string").join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

export async function handleListMcpServers(
  projectId: string | null,
): Promise<NextResponse> {
  try {
    return NextResponse.json({ data: listMcpServers(undefined, projectId) });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}

export async function handleCreateMcpServer(
  request: NextRequest,
  projectId: string | null,
): Promise<NextResponse> {
  const body = await parseBody(request);
  if (body instanceof NextResponse) return body;

  const parsed = createMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstZodMessage(parsed.error) },
      { status: 400 },
    );
  }
  try {
    const data = createMcpServer(parsed.data, undefined, projectId);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}

export async function handleUpdateMcpServer(
  request: NextRequest,
  projectId: string | null,
  serverId: string,
): Promise<NextResponse> {
  const body = await parseBody(request);
  if (body instanceof NextResponse) return body;

  const parsed = updateMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstZodMessage(parsed.error) },
      { status: 400 },
    );
  }
  try {
    const data = updateMcpServer(serverId, parsed.data, undefined, projectId);
    return NextResponse.json({ data });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}

export async function handleDeleteMcpServer(
  projectId: string | null,
  serverId: string,
): Promise<NextResponse> {
  try {
    deleteMcpServer(serverId, undefined, projectId);
    return NextResponse.json({ data: { id: serverId, deleted: true } });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}
