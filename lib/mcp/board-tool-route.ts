/**
 * Shared POST handler factory for the /api/mcp/* board-tool routes
 * (list-tickets, create-ticket, update-ticket, get-agent-status,
 * start-build) that give CLI chat sessions parity with the fast-mode board
 * tools.
 *
 * Each route authenticates with the standard MCP bearer token and then runs
 * the SAME executor the fast-mode chat loop uses
 * (CHAT_BOARD_TOOL_EXECUTORS in lib/chat/board-tools.ts) — mutations flow
 * through Arij's canonical HTTP routes, so workflow guards, SSE board
 * events, activity log and arji.json export all fire identically on both
 * surfaces. The token (never the body) decides the project scope, exactly
 * like the ticket-scoped MCP routes.
 *
 * Executor results are LLM-facing JSON strings ({...} on success, {error,
 * detail?} on failure); this wrapper maps them onto the MCP envelope the
 * shim expects: `{ data }` with 2xx, `{ error, code? }` with the upstream
 * status (default 400) otherwise.
 *
 * Toolset segregation is enforced HERE, not in the shim: see
 * BOARD_TOOL_ALLOWED_AGENT_TYPES below.
 */

import { NextRequest, NextResponse } from "next/server";
import type { ZodSchema } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import type { McpTokenRecord } from "@/lib/mcp/token-store";
import {
  CHAT_BOARD_TOOL_EXECUTORS,
  type ChatBoardToolContext,
} from "@/lib/chat/board-tools";

interface BoardToolFailure {
  error: string;
  detail?: { code?: unknown; status?: unknown };
}

function isBoardToolFailure(value: unknown): value is BoardToolFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

/**
 * The token agent types allowed on the chat board-tool routes.
 *
 * An ALLOWLIST, and the asymmetry is the point. Which toolset a session sees
 * is decided in the shim (bin/arij-mcp.mjs reads ARIJ_MCP_TOOLSET), which
 * runs inside the agent's own process with a token the agent can read out of
 * its own environment — so the shim's choice is a UI over the tool channel,
 * never a boundary. `curl` with that bearer reaches every /api/mcp route
 * regardless of the toolset the spawn selected, which is why the server has
 * to make the same call itself. Missing a type here costs a chat surface an
 * error a maintainer will see immediately; missing one in a denylist hands a
 * build session start_build — the ability to spawn further agents, a
 * capability outside its declared toolset, on a ticket of its choosing.
 * A type added to AGENT_TYPES later is therefore denied until someone lists
 * it here on purpose.
 *
 * "chat" is the only agent type minted with the chat toolset: the fast-mode
 * per-turn token (app/api/projects/[projectId]/chat/stream/route.ts) and the
 * CLI channel used by both one-shot turns and the persistent runner
 * (lib/chat/cli-tool-channel.ts) all mint `agentType: "chat"`. Every other
 * mint site is a durable session row (lib/claude/process-manager.ts), whose
 * spawn config selects the agent toolset.
 *
 * This is the converse of the agent-only guard on create-bug,
 * attach-artifact, submit-findings, ask-question, submit-grading and
 * report-friction (`auth.agentType === "chat"` -> 403), and of the
 * refinement guard on update-ticket-status. Together the three make the
 * toolset split a server-side fact.
 */
export const BOARD_TOOL_ALLOWED_AGENT_TYPES: readonly string[] = ["chat"];

/**
 * 403 for a token outside the chat toolset (build, review, grading, merge,
 * refinement, a tokenless-typed row, anything unrecognised); null when the
 * call may proceed.
 */
export function requireChatToolsetToken(
  auth: McpTokenRecord,
  toolName: string,
): NextResponse | null {
  if (auth.agentType && BOARD_TOOL_ALLOWED_AGENT_TYPES.includes(auth.agentType)) {
    return null;
  }
  return NextResponse.json(
    {
      error: `${toolName} is only available to chat sessions.`,
      code: "FORBIDDEN",
    },
    { status: 403 },
  );
}

export function createBoardToolRouteHandler<T extends Record<string, unknown>>(
  toolName: string,
  bodySchema: ZodSchema<T>,
): (request: NextRequest) => Promise<NextResponse> {
  const executor = CHAT_BOARD_TOOL_EXECUTORS[toolName];
  if (!executor) {
    throw new Error(`Unknown board tool: ${toolName}`);
  }

  return async function POST(request: NextRequest): Promise<NextResponse> {
    const auth = requireMcpToken(request, toolName);
    if (isErrorResponse(auth)) return auth;

    // Ahead of validation and of the executor: a refused call must leave
    // nothing behind — no build launched, no ticket written, no comment.
    const forbidden = requireChatToolsetToken(auth, toolName);
    if (forbidden) return forbidden;

    const validated = await validateBody(bodySchema, request);
    if (isErrorResponse(validated)) return validated;

    const ctx: ChatBoardToolContext = {
      projectId: auth.projectId,
      // The shim reached us at this origin, so the executor's internal
      // fetches to the canonical routes are loopback calls to the same app.
      baseUrl: new URL(request.url).origin,
      mcpToken: auth.token,
      signal: request.signal,
    };

    const parsed: unknown = JSON.parse(await executor(validated.data, ctx));

    if (isBoardToolFailure(parsed)) {
      const status =
        typeof parsed.detail?.status === "number" ? parsed.detail.status : 400;
      const code = typeof parsed.detail?.code === "string" ? parsed.detail.code : undefined;
      return NextResponse.json(
        { error: parsed.error, ...(code ? { code } : {}) },
        { status },
      );
    }

    return NextResponse.json({ data: parsed });
  };
}
