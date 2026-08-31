/**
 * Board tools for the direct-API (OpenAI-compatible) chat mode.
 *
 * The fast-mode chat loop advertises these as OpenAI function tools and
 * executes them server-side. Every mutation goes through Arij's own HTTP
 * routes rather than raw DB writes, so the canonical side-effects all fire
 * (workflow guards via applyTransition, SSE board events, activity log,
 * readable ids, arji.json export). get_ticket and update_ticket_status
 * reuse the existing /api/mcp/* agent routes with a per-turn bearer token
 * minted by the chat route (lib/mcp/token-store.ts), so status changes are
 * attributed to `agent` exactly like CLI sessions; comments go through the
 * epic comments route with author "agent" (the MCP comment route links the
 * session id, which has no agent_sessions row for a chat turn).
 *
 * Everything here must run inside the Next.js server process: the MCP token
 * store and the SSE event bus are in-memory singletons.
 */
import { and, eq, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import type { OpenAiToolCall, OpenAiToolDefinition } from "@/lib/openai/client";

export interface ChatBoardToolContext {
  projectId: string;
  /** Origin of this running app (derived from the incoming request). */
  baseUrl: string;
  /** Bearer token for the /api/mcp/* routes, minted per chat turn. */
  mcpToken: string;
  signal?: AbortSignal;
}

/** Board columns an assistant may write; `released` is system-only. */
export const WRITABLE_STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export const ALL_STATUSES = [...WRITABLE_STATUSES, "released"] as const;

/** Tool results larger than this are truncated to keep the loop bounded. */
const RESULT_CHAR_LIMIT = 12000;

/**
 * Serialized-size budget for the list_tickets rows: keeps the result well
 * under RESULT_CHAR_LIMIT on big boards regardless of title lengths
 * (active columns are listed first; the tail is counted in
 * `tickets_omitted` and reachable via the status filter).
 */
const LIST_TICKETS_CHAR_BUDGET = 9500;

export const CHAT_BOARD_TOOL_DEFINITIONS: OpenAiToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_tickets",
      description:
        "List the tickets (epics) on this project's kanban board: id, readable id, title, status column, type, priority and user-story progress. Use it to read the board before answering questions about it.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...ALL_STATUSES],
            description: "Only return tickets in this board column.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ticket",
      description:
        "Read one ticket in full: description, user stories with acceptance criteria, comment thread and review findings.",
      parameters: {
        type: "object",
        properties: {
          ticket_id: {
            type: "string",
            description: 'Ticket id or readable id (e.g. "E-arij-042").',
          },
        },
        required: ["ticket_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_ticket",
      description:
        "Create a new ticket (epic) on the board, optionally with user stories. Returns the new ticket's ids.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short ticket title (max 200 chars)." },
          description: { type: "string", description: "Markdown description." },
          type: { type: "string", enum: ["feature", "bug"] },
          priority: {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description: "0=Low, 1=Medium, 2=High, 3=Critical.",
          },
          status: {
            type: "string",
            enum: [...WRITABLE_STATUSES],
            description: "Starting column, defaults to backlog.",
          },
          user_stories: {
            type: "array",
            description: "Optional user stories to create with the ticket.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptance_criteria: { type: "string" },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_ticket",
      description: "Edit a ticket's title, description or priority (not its status).",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket id or readable id." },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "integer", minimum: 0, maximum: 3 },
        },
        required: ["ticket_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_ticket_status",
      description:
        "Move a ticket to another board column. Transitions are validated by the workflow engine (e.g. review→done needs an approved review), so an invalid move returns an explanatory error.",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket id or readable id." },
          status: { type: "string", enum: [...WRITABLE_STATUSES] },
          reason: { type: "string", description: "Optional short reason, shown in the activity log." },
        },
        required: ["ticket_id", "status"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "post_comment",
      description: "Post a comment on a ticket's thread (attributed to the agent).",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket id or readable id." },
          body: { type: "string", description: "Markdown comment body (max 8000 chars)." },
        },
        required: ["ticket_id", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_status",
      description:
        "List the agent activity on this project right now: running/queued build, review and merge sessions, plus live chat/spec/release activities.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "start_build",
      description:
        "Launch a coding agent on a ticket (creates a git worktree and a build session). Only for buildable columns (backlog/todo/in_progress/review); fails with 409 if an agent is already working on the ticket. Unless the project's pipeline setting opts out, the build then runs the full pipeline: code review and fix cycles until the review is clean. Ask the user before using this unless they clearly requested a build.",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket id or readable id." },
          comment: {
            type: "string",
            description:
              "Optional instruction, posted on the ticket thread as an agent comment before the build starts.",
          },
        },
        required: ["ticket_id"],
        additionalProperties: false,
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* System prompt section                                               */
/* ------------------------------------------------------------------ */

/**
 * Board context appended to the fast-mode system prompt: tells the model
 * what project it is in and how to use the tools — the CLI paths get the
 * equivalent through buildChatPrompt, which fast mode does not use.
 */
export function buildBoardToolsSystemSection(project: {
  name: string | null;
  description: string | null;
}): string {
  const lines = [
    `You are the project assistant of "${project.name ?? "this project"}" inside Arij, a kanban-based AI project orchestrator.`,
  ];
  if (project.description?.trim()) {
    lines.push(`Project description: ${project.description.trim()}`);
  }
  lines.push(
    "You have tools to read and act on the project's board: list or read tickets, create and edit them, move them between columns (backlog, todo, in_progress, review, done), comment, check what agents are doing, and launch a build agent on a ticket.",
    "Use the tools instead of guessing whenever the user asks about tickets, the board, or agents. Tickets are referenced by readable ids like E-arij-042 or B-arij-007.",
    "Destructive or heavyweight actions (launching a build) need a clear user request first.",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

function toolJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= RESULT_CHAR_LIMIT) return json;
  return JSON.stringify({
    truncated: true,
    note: `Result exceeded ${RESULT_CHAR_LIMIT} characters; a prefix follows.`,
    preview: json.slice(0, RESULT_CHAR_LIMIT),
  });
}

function toolError(message: string, detail?: unknown): string {
  return toolJson(detail === undefined ? { error: message } : { error: message, detail });
}

interface ApiResult {
  ok: boolean;
  status: number;
  json: unknown;
}

async function apiFetch(
  ctx: ChatBoardToolContext,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  useMcpAuth = false,
): Promise<ApiResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useMcpAuth) headers.Authorization = `Bearer ${ctx.mcpToken}`;
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctx.signal,
  });
  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, json };
}

/**
 * Route error bodies are `{ error, code?, details? }`; surface everything to
 * the model (zod details included) so it can self-correct a rejected call.
 */
function passthroughFailure(result: ApiResult): string {
  const body = result.json as
    | { error?: unknown; code?: unknown; details?: unknown }
    | null;
  const message =
    body && typeof body.error === "string" ? body.error : `Request failed (${result.status})`;
  const detail: Record<string, unknown> = { status: result.status };
  if (body?.code) detail.code = body.code;
  if (body?.details) detail.details = body.details;
  return toolError(message, detail);
}

type TicketRef = { id: string; readableId: string | null; title: string };

/** Accepts a nanoid or a readable id (case-insensitive), project-scoped. */
function resolveTicketRef(projectId: string, ref: unknown): TicketRef | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const needle = ref.trim();
  return (
    db
      .select({ id: epics.id, readableId: epics.readableId, title: epics.title })
      .from(epics)
      .where(
        and(
          eq(epics.projectId, projectId),
          or(eq(epics.id, needle), sql`lower(${epics.readableId}) = lower(${needle})`),
        ),
      )
      .get() ?? null
  );
}

function requireTicket(
  ctx: ChatBoardToolContext,
  args: Record<string, unknown>,
): TicketRef | { failed: string } {
  const ticket = resolveTicketRef(ctx.projectId, args.ticket_id);
  if (!ticket) {
    return {
      failed: toolError(
        `No ticket "${String(args.ticket_id ?? "")}" found in this project. Use list_tickets to see valid ids.`,
      ),
    };
  }
  return ticket;
}

async function listTickets(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const result = await apiFetch(ctx, "GET", `/api/projects/${ctx.projectId}/epics`);
  if (!result.ok) return passthroughFailure(result);
  const rows = (result.json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return toolError("Unexpected board response shape.");

  const statusFilter = typeof args.status === "string" ? args.status : null;
  const filtered = rows
    .filter((row) => !statusFilter || (row as { status?: unknown }).status === statusFilter)
    .map((row) => {
      const epic = row as Record<string, unknown>;
      return {
        id: epic.id,
        readable_id: epic.readableId ?? null,
        title: epic.title,
        status: epic.status,
        type: epic.type,
        priority: epic.priority,
        stories_done: epic.usDone ?? 0,
        stories_total: epic.usCount ?? 0,
        pr_status: epic.prStatus ?? null,
        latest_session_outcome: epic.latestSessionOutcome ?? null,
      };
    });

  const byStatus: Record<string, number> = {};
  for (const ticket of filtered) {
    const status = String(ticket.status);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  // Big boards must not blow the tool-result budget with a mid-JSON
  // truncation: the most actionable columns come first (so a huge backlog
  // cannot crowd out in-flight work), the tail is dropped and counted.
  const LIST_PRIORITY = ["in_progress", "review", "todo", "backlog", "done", "released"];
  const statusRank = new Map(LIST_PRIORITY.map((status, i) => [status, i]));
  const tickets = [...filtered].sort(
    (a, b) =>
      (statusRank.get(String(a.status)) ?? 99) - (statusRank.get(String(b.status)) ?? 99),
  );
  const shown: typeof tickets = [];
  let spent = 0;
  for (const ticket of tickets) {
    spent += JSON.stringify(ticket).length + 1;
    if (spent > LIST_TICKETS_CHAR_BUDGET) break;
    shown.push(ticket);
  }
  return toolJson({
    count: filtered.length,
    by_status: byStatus,
    tickets: shown,
    tickets_omitted: tickets.length - shown.length,
  });
}

async function getTicket(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const ticket = requireTicket(ctx, args);
  if ("failed" in ticket) return ticket.failed;
  const result = await apiFetch(
    ctx,
    "POST",
    "/api/mcp/get-ticket",
    { ticket_id: ticket.id },
    true,
  );
  if (!result.ok) return passthroughFailure(result);
  return toolJson(result.json);
}

interface UserStoryArg {
  title?: unknown;
  description?: unknown;
  acceptance_criteria?: unknown;
}

async function createTicket(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const userStories = Array.isArray(args.user_stories)
    ? (args.user_stories as UserStoryArg[])
        .filter((story) => typeof story?.title === "string" && story.title)
        .map((story) => ({
          title: story.title,
          description: typeof story.description === "string" ? story.description : undefined,
          acceptanceCriteria:
            typeof story.acceptance_criteria === "string" ? story.acceptance_criteria : undefined,
        }))
    : undefined;

  const result = await apiFetch(ctx, "POST", `/api/projects/${ctx.projectId}/epics`, {
    title: args.title,
    description: typeof args.description === "string" ? args.description : undefined,
    type: args.type === "bug" ? "bug" : args.type === "feature" ? "feature" : undefined,
    priority: typeof args.priority === "number" ? args.priority : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    userStories,
  });
  if (!result.ok) return passthroughFailure(result);
  const created = (result.json as { data?: Record<string, unknown> })?.data ?? {};
  return toolJson({
    created: {
      id: created.id,
      readable_id: created.readableId ?? null,
      title: created.title,
      status: created.status,
    },
  });
}

async function updateTicket(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const ticket = requireTicket(ctx, args);
  if ("failed" in ticket) return ticket.failed;

  const patch: Record<string, unknown> = {};
  if (typeof args.title === "string") patch.title = args.title;
  if (typeof args.description === "string") patch.description = args.description;
  if (typeof args.priority === "number") patch.priority = args.priority;
  if (Object.keys(patch).length === 0) {
    return toolError("Nothing to update: pass title, description and/or priority.");
  }

  const result = await apiFetch(
    ctx,
    "PATCH",
    `/api/projects/${ctx.projectId}/epics/${ticket.id}`,
    patch,
  );
  if (!result.ok) return passthroughFailure(result);
  return toolJson({ updated: { id: ticket.id, readable_id: ticket.readableId, ...patch } });
}

async function updateTicketStatus(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const ticket = requireTicket(ctx, args);
  if ("failed" in ticket) return ticket.failed;
  const result = await apiFetch(
    ctx,
    "POST",
    "/api/mcp/update-ticket-status",
    {
      ticket_id: ticket.id,
      status: args.status,
      reason: typeof args.reason === "string" ? args.reason : undefined,
    },
    true,
  );
  if (!result.ok) return passthroughFailure(result);
  return toolJson(result.json);
}

/** Comment length cap, mirroring the mcp__arij__post_comment contract. */
const COMMENT_CHAR_LIMIT = 8000;

/**
 * Agent-authored comment insert. Uses the epic comments route rather than
 * /api/mcp/post-comment: the MCP route links the comment to its session id,
 * and the chat turn's minted session has no agent_sessions row to satisfy
 * the ticket_comments FK. Agent authorship skips mention validation there
 * exactly like the MCP route does.
 */
async function postAgentComment(
  ctx: ChatBoardToolContext,
  epicId: string,
  content: string,
): Promise<ApiResult> {
  return apiFetch(ctx, "POST", `/api/projects/${ctx.projectId}/epics/${epicId}/comments`, {
    author: "agent",
    content,
  });
}

async function postComment(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const ticket = requireTicket(ctx, args);
  if ("failed" in ticket) return ticket.failed;
  if (typeof args.body !== "string" || !args.body.trim()) {
    return toolError("body is required.");
  }
  if (args.body.length > COMMENT_CHAR_LIMIT) {
    return toolError(`body exceeds ${COMMENT_CHAR_LIMIT} characters.`);
  }
  const result = await postAgentComment(ctx, ticket.id, args.body);
  if (!result.ok) return passthroughFailure(result);
  return toolJson({ posted: true, ticket_id: ticket.readableId ?? ticket.id });
}

async function getAgentStatus(ctx: ChatBoardToolContext): Promise<string> {
  const result = await apiFetch(ctx, "GET", `/api/projects/${ctx.projectId}/sessions/active`);
  if (!result.ok) return passthroughFailure(result);
  const rows = (result.json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return toolError("Unexpected activity response shape.");
  const activities = rows.map((row) => {
    const activity = row as Record<string, unknown>;
    return {
      type: activity.type,
      label: activity.label,
      status: activity.status,
      provider: activity.provider,
      epic_id: activity.epicId ?? null,
      started_at: activity.startedAt,
      stale: activity.stale ?? false,
    };
  });
  return toolJson({ count: activities.length, activities });
}

async function startBuild(
  args: Record<string, unknown>,
  ctx: ChatBoardToolContext,
): Promise<string> {
  const ticket = requireTicket(ctx, args);
  if ("failed" in ticket) return ticket.failed;

  // The build route posts its `comment` as a USER comment and feeds it to
  // the build prompt — model text must not impersonate the user, so the
  // instruction lands as an agent comment on the thread instead.
  const instruction =
    typeof args.comment === "string" && args.comment.trim() ? args.comment.trim() : null;
  if (instruction) {
    await postAgentComment(ctx, ticket.id, instruction);
  }

  const result = await apiFetch(
    ctx,
    "POST",
    `/api/projects/${ctx.projectId}/epics/${ticket.id}/build`,
    {},
  );
  if (!result.ok) return passthroughFailure(result);
  const data = (result.json as { data?: Record<string, unknown> })?.data ?? {};
  return toolJson({
    started: {
      ticket: ticket.readableId ?? ticket.id,
      session_id: data.sessionId,
      branch: data.branchName,
      instruction_posted: instruction !== null,
    },
  });
}

/**
 * The tool executors by name. Shared by the fast-mode loop below and by the
 * /api/mcp/* board routes (lib/mcp/board-tool-route.ts) that give CLI chat
 * sessions the same tools — one implementation, so both surfaces stay in
 * parity by construction. Each returns the LLM-facing JSON string.
 */
export const CHAT_BOARD_TOOL_EXECUTORS: Record<
  string,
  (args: Record<string, unknown>, ctx: ChatBoardToolContext) => Promise<string>
> = {
  list_tickets: listTickets,
  get_ticket: getTicket,
  create_ticket: createTicket,
  update_ticket: updateTicket,
  update_ticket_status: updateTicketStatus,
  post_comment: postComment,
  get_agent_status: (_args, ctx) => getAgentStatus(ctx),
  start_build: startBuild,
};

/**
 * Executes one tool call and returns the JSON string to send back as the
 * `role:"tool"` message. Tool failures are returned as `{error}` payloads
 * (the model can react); only an abort unwinds as an exception.
 */
export async function executeChatBoardTool(
  call: OpenAiToolCall,
  ctx: ChatBoardToolContext,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return toolError(`Invalid JSON arguments for ${call.function.name}.`);
  }

  const executor = CHAT_BOARD_TOOL_EXECUTORS[call.function.name];
  if (!executor) return toolError(`Unknown tool: ${call.function.name}`);

  try {
    return await executor(args, ctx);
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return toolError(error instanceof Error ? error.message : "Tool execution failed.");
  }
}
