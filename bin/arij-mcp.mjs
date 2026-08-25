#!/usr/bin/env node
/**
 * Arij MCP shim — a stdio Model Context Protocol server that gives spawned
 * CLI agents (claude-code, codex) a structured channel back into Arij.
 *
 * Every tool call is a thin HTTP bridge: POST ${ARIJ_BASE_URL}/api/mcp/<tool>
 * with the session-scoped bearer token from ARIJ_MCP_TOKEN. All failures —
 * network, timeout, non-2xx — surface as tool-level `isError` results, never
 * as protocol crashes.
 *
 * Toolsets (ARIJ_MCP_TOOLSET): "agent" (default) is the ticket-scoped set for
 * build/review sessions launched on a ticket. "chat" is the board-scoped set
 * for CLI chat conversations — parity with the fast-mode board tools
 * (lib/chat/board-tools.ts): no ask_question/submit_findings (nothing holds a
 * chat turn), ticket_id always explicit (a chat token has no launch ticket).
 * Only the active toolset's tools are listed AND callable.
 *
 * Deliberate constraints:
 * - Low-level SDK API (Server + raw JSON Schema), NOT McpServer/registerTool:
 *   the SDK bundles zod@3 while the repo uses zod@4, and the low-level API
 *   needs no zod at all.
 * - Zero imports from lib/ — the shim must run standalone under any cwd
 *   (agent sessions run in per-ticket worktrees, not the app root).
 */

import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const baseUrl = (process.env.ARIJ_BASE_URL ?? "").replace(/\/+$/, "");
const token = process.env.ARIJ_MCP_TOKEN ?? "";

if (!baseUrl || !token) {
  process.stderr.write(
    "arij-mcp: ARIJ_BASE_URL and ARIJ_MCP_TOKEN environment variables are required\n"
  );
  process.exit(1);
}

const TOOLSET = process.env.ARIJ_MCP_TOOLSET === "chat" ? "chat" : "agent";

// get_ticket always resolves the epic this session was launched for.
const TICKET_ID_PROPERTY = {
  ticket_id: {
    type: "string",
    minLength: 1,
    description:
      "Optional: id of another epic in the same project. Defaults to the epic this session was launched for.",
  },
};

// update_ticket_status diverges for story builds: with no ticket_id it
// moves the session's own story, while an explicit ticket_id targets
// epics only (story ids are not accepted here yet).
const UPDATE_TICKET_ID_PROPERTY = {
  ticket_id: {
    type: "string",
    minLength: 1,
    description:
      "Optional: id of an epic in the same project — epics only; a story id is not accepted. Without it a story build moves its own story; otherwise it moves the epic this session was launched for.",
  },
};

const AGENT_TOOLS = [
  {
    name: "get_ticket",
    description:
      "Read the Arij ticket this session was launched for: status, description, user stories with acceptance criteria, comment thread, and open review findings. Optional ticket_id targets another ticket in the same project.",
    inputSchema: {
      type: "object",
      properties: { ...TICKET_ID_PROPERTY },
      additionalProperties: false,
    },
  },
  {
    name: "update_ticket_status",
    description:
      "Move the ticket on the Arij board (backlog, todo, in_progress, review, done). Transitions are validated by Arij's workflow engine; review→done needs human approval and will be rejected — finish, report, and let the user approve. Call this instead of announcing a status change in prose.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "review", "done"],
          description: "Target board column.",
        },
        reason: {
          type: "string",
          maxLength: 500,
          description: "Short reason recorded in the ticket activity log.",
        },
        ...UPDATE_TICKET_ID_PROPERTY,
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    name: "post_comment",
    description:
      "Post a progress/result comment to the ticket's activity feed (what changed, decisions, blockers). Not for questions — use ask_question.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          description: "Markdown comment body.",
        },
        ...TICKET_ID_PROPERTY,
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_question",
    description:
      "Ask the user a blocking question and stop working on the blocked part. This reliably marks the session as awaiting a reply and holds the ticket from advancing. Include full context and concrete options in one call, then end your turn.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "The blocking question, with full context and concrete options.",
        },
        ...TICKET_ID_PROPERTY,
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_findings",
    description:
      "(Review sessions) Submit your review: the verdict here is what Arij acts on — it decides whether the ticket goes back for changes. Each finding anchors to file_path+line and becomes an open review comment that blocks approval until resolved, so an 'approved' verdict alongside an open critical/major finding still blocks. Call this once, at the end, then still end your final message with the required '**Overall Verdict: …**' line (the fallback Arij reads only when no verdict was submitted).",
    inputSchema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["approved", "approved_with_minor_issues", "changes_requested"],
          description:
            "Overall review verdict. Persisted on this session and read as the authoritative signal for the ticket's next transition.",
        },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "Overall review summary; also the place for general findings without a file+line anchor.",
        },
        findings: {
          type: "array",
          maxItems: 50,
          description: "File+line anchored findings.",
          items: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                minLength: 1,
                description: "Repo-relative path of the file.",
              },
              line: {
                type: "integer",
                minimum: 1,
                description: "1-indexed line number the finding anchors to.",
              },
              body: {
                type: "string",
                minLength: 1,
                maxLength: 2000,
                description: "The finding itself.",
              },
              severity: {
                type: "string",
                enum: ["critical", "major", "minor", "info"],
              },
            },
            required: ["file_path", "line", "body", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict", "summary", "findings"],
      additionalProperties: false,
    },
  },
];

/**
 * Board-scoped toolset for CLI chat conversations. Mirrors the fast-mode
 * board tools (lib/chat/board-tools.ts) name-for-name; each maps to the
 * /api/mcp/<kebab-case> route like every other tool. Descriptions carry the
 * usage guidance (referencing tickets by readable id, asking before builds)
 * because chat prompts do not get an "Arij tools" prompt section.
 */
const CHAT_TICKET_ID_PROPERTY = {
  ticket_id: {
    type: "string",
    minLength: 1,
    description: 'Ticket id or readable id (e.g. "E-arij-042").',
  },
};

const CHAT_TOOLS = [
  {
    name: "list_tickets",
    description:
      "List the tickets (epics) on this project's Arij kanban board: id, readable id, title, status column, type, priority and user-story progress. Use it to read the board before answering questions about it.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "review", "done", "released"],
          description: "Only return tickets in this board column.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_ticket",
    description:
      "Read one Arij ticket in full: description, user stories with acceptance criteria, comment thread and review findings.",
    inputSchema: {
      type: "object",
      properties: { ...CHAT_TICKET_ID_PROPERTY },
      required: ["ticket_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_ticket",
    description:
      "Create a new ticket (epic) on the Arij board, optionally with user stories. Returns the new ticket's ids.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Short ticket title.",
        },
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
          enum: ["backlog", "todo", "in_progress", "review", "done"],
          description: "Starting column, defaults to backlog.",
        },
        user_stories: {
          type: "array",
          description: "Optional user stories to create with the ticket.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1 },
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
  {
    name: "update_ticket",
    description:
      "Edit an Arij ticket's title, description or priority (not its status — use update_ticket_status for that).",
    inputSchema: {
      type: "object",
      properties: {
        ...CHAT_TICKET_ID_PROPERTY,
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        priority: { type: "integer", minimum: 0, maximum: 3 },
      },
      required: ["ticket_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_ticket_status",
    description:
      "Move an Arij ticket to another board column. Transitions are validated by the workflow engine (e.g. review→done needs an approved review), so an invalid move returns an explanatory error.",
    inputSchema: {
      type: "object",
      properties: {
        ...CHAT_TICKET_ID_PROPERTY,
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "review", "done"],
          description: "Target board column.",
        },
        reason: {
          type: "string",
          maxLength: 500,
          description: "Optional short reason, shown in the activity log.",
        },
      },
      required: ["ticket_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "post_comment",
    description:
      "Post a comment on an Arij ticket's thread (attributed to the agent).",
    inputSchema: {
      type: "object",
      properties: {
        ...CHAT_TICKET_ID_PROPERTY,
        body: {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          description: "Markdown comment body.",
        },
      },
      required: ["ticket_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "get_agent_status",
    description:
      "List the agent activity on this Arij project right now: running/queued build, review and merge sessions, plus live chat/spec/release activities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_build",
    description:
      "Launch a coding agent on an Arij ticket (creates a git worktree and a build session). Only for buildable columns (backlog/todo/in_progress/review); fails if an agent is already working on the ticket. Ask the user before using this unless they clearly requested a build.",
    inputSchema: {
      type: "object",
      properties: {
        ...CHAT_TICKET_ID_PROPERTY,
        comment: {
          type: "string",
          description:
            "Optional instruction passed to the build agent and posted as a comment.",
        },
      },
      required: ["ticket_id"],
      additionalProperties: false,
    },
  },
];

const TOOLS = TOOLSET === "chat" ? CHAT_TOOLS : AGENT_TOOLS;
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/** Wrap a message as a tool-level error result (never a protocol failure). */
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function callArijApi(name, args) {
  const endpoint = name.replace(/_/g, "-");
  let response;
  try {
    response = await fetch(`${baseUrl}/api/mcp/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Error (NETWORK): ${message}`);
  }

  let json = null;
  try {
    json = await response.json();
  } catch {
    // Non-JSON body — fall through to status-based reporting.
  }

  if (response.ok) {
    return { content: [{ type: "text", text: JSON.stringify(json?.data ?? null) }] };
  }

  return toolError(
    `Error (${json?.code ?? response.status}): ${json?.error ?? response.statusText}`
  );
}

const server = new Server(
  { name: "arij", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!TOOL_NAMES.has(name)) {
    return toolError(`Error (UNKNOWN_TOOL): "${name}" is not an Arij tool`);
  }
  return callArijApi(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
