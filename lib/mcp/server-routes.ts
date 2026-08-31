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
 *
 * A GLOBAL write additionally waits for the user-global reconciliation before
 * it answers — see `settleUserGlobalSync` below.
 */

import { NextRequest, NextResponse } from "next/server";
import { whenUserGlobalMcpSyncSettles } from "./user-global-sync";
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

/**
 * Waits for the reconciliation a GLOBAL write just requested, before that
 * write is acknowledged.
 *
 * A global create/update/delete calls `syncUserGlobalMcpServers`, which pushes
 * the new server set into oh-my-pi's `mcp.json` and agy's register in the
 * BACKGROUND — those two CLIs have no per-spawn MCP surface, so a user-global
 * registry is the only place their sessions can read it from.
 *
 * Answering before that lands would be a silent correctness bug rather than
 * mere lag: both CLIs snapshot their server set when the process starts and
 * hold it for the entire run, so a session launched in the gap would run a
 * deleted server, miss a newly enabled one, or present a credential the user
 * has already rotated — while Arij's own database and the prompt text handed
 * to that session describe the new set. Awaiting here is what makes a 2xx mean
 * "already applied": every session started after it observes what it promised.
 *
 * Cheap in the ordinary case and never blocking: the reconciliation's child
 * processes are awaited rather than run synchronously, so the event loop stays
 * free for SSE, chunk persistence, the watchdog and pipelines while this one
 * request waits. Never rejects — a settings save must not fail because `agy`
 * is missing (see lib/mcp/user-global-sync.ts, rules 4 and 5).
 *
 * Project-scoped writes skip it: they request no sync, because a per-project
 * server cannot be expressed in a user-global registry at all.
 */
async function settleUserGlobalSync(projectId: string | null): Promise<void> {
  if (projectId !== null) return;
  await whenUserGlobalMcpSyncSettles();
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
    await settleUserGlobalSync(projectId);
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
    await settleUserGlobalSync(projectId);
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
    await settleUserGlobalSync(projectId);
    return NextResponse.json({ data: { id: serverId, deleted: true } });
  } catch (error) {
    return mcpServerErrorResponse(error);
  }
}
