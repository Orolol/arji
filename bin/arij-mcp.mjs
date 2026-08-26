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
 * (lib/chat/board-tools.ts): no ask_question/report_friction/submit_findings/
 * submit_grading (nothing holds a chat turn and chat turns are not durable
 * agent sessions), ticket_id always explicit (a chat token has no launch
 * ticket).
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

/**
 * An UNRESOLVED `${VAR}` reference from a host's MCP config, as a literal
 * string. Hosts that interpolate their config files (omp's mcp.json, codex's
 * config.toml, a hand-run claude's project .mcp.json) leave a placeholder
 * whose variable is unset as-is rather than blanking it — measured on omp
 * 18.0.5, whose entry carries `"ARIJ_MCP_TOKEN": "${ARIJ_MCP_TOKEN}"`.
 *
 * That literal is non-empty, so treating it as a value is what made the shim
 * start, mount the whole toolset, and answer every call with
 * "UNAUTHORIZED: Invalid or expired MCP token" — the agent sees tools it can
 * never use. An unexpanded placeholder means "no value", exactly like an
 * unset variable, so the shim must refuse to start instead.
 */
const UNEXPANDED_PLACEHOLDER = /\$\{[^}]*\}/;

/** The variable's value, or "" when it is absent or an unexpanded placeholder. */
function readEnv(name) {
  const raw = process.env[name] ?? "";
  return UNEXPANDED_PLACEHOLDER.test(raw) ? "" : raw;
}

const baseUrl = readEnv("ARIJ_BASE_URL").replace(/\/+$/, "");
const token = readEnv("ARIJ_MCP_TOKEN");

if (!baseUrl || !token) {
  process.stderr.write(
    "arij-mcp: ARIJ_BASE_URL and ARIJ_MCP_TOKEN environment variables are required\n"
  );
  process.exit(1);
}

const TOOLSET = readEnv("ARIJ_MCP_TOOLSET") === "chat" ? "chat" : "agent";

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
      "Move the ticket on the Arij board (backlog, todo, in_progress, review, done). Targets whatever this session was launched for: a story-scoped session moves ITS OWN story, and the parent epic follows to review by itself once every sibling story is in review or done — do not try to move the epic yourself. Transitions are validated by Arij's workflow engine; done needs human approval and will be rejected — finish, report, and let the user approve. Call this instead of announcing a status change in prose.",
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
    name: "report_friction",
    description:
      "Record a tooling, documentation, test, or convention friction for this project. This writes only to Arij's friction register and never changes the board.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "broken_tooling",
            "misleading_docs",
            "flaky_test",
            "unclear_convention",
            "other",
          ],
          description: "Closed category describing the kind of friction.",
        },
        description: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Concise, actionable description of what was difficult.",
        },
        filePath: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Optional repository-relative path related to the friction.",
        },
      },
      required: ["category", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "attach_artifact",
    description:
      "Attach a PNG, JPEG, or WebP screenshot as durable visual proof for this session. The path may be absolute or relative to the session worktree; the file must be inside that worktree, no larger than 5 MiB, and one of at most 10 artifacts for the session.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to the screenshot inside this session's worktree (absolute or worktree-relative).",
        },
        caption: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Short explanation of what the screenshot demonstrates.",
        },
      },
      required: ["path", "caption"],
      additionalProperties: false,
    },
  },
  {
    name: "create_bug",
    description:
      "Create a standalone, non-blocking bug ticket in this session's current Arij project when you discover an adjacent problem. The bug is attributed to this session, duplicate open titles are refused, and each session may create at most 5 bugs.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Short, specific bug title.",
        },
        description: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description:
            "Markdown with context, observed reproduction steps, and the actual error or behavior.",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Optional suggested severity.",
        },
        source_ticket_id: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description:
            "Optional id or readable id of a source ticket in this project. Defaults to the ticket this session was launched for.",
        },
      },
      required: ["title", "description"],
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
  {
    name: "submit_grading",
    description:
      "(Grading sessions) Submit one evidence-backed met, partial, or missed result for each acceptance criterion. Every storyId must belong to this session's ticket.",
    inputSchema: {
      type: "object",
      properties: {
        gradings: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "Acceptance-criterion results for this ticket.",
          items: {
            type: "object",
            properties: {
              storyId: {
                type: "string",
                minLength: 1,
                description: "User story id returned by get_ticket.",
              },
              criterion: {
                type: "string",
                minLength: 1,
                maxLength: 4000,
                description: "The acceptance criterion being evaluated.",
              },
              status: {
                type: "string",
                enum: ["met", "partial", "missed"],
              },
              evidence: {
                type: "string",
                minLength: 1,
                maxLength: 4000,
                description: "Concrete evidence for the grading decision.",
              },
            },
            required: ["storyId", "criterion", "status", "evidence"],
            additionalProperties: false,
          },
        },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Overall acceptance-criteria grading summary.",
        },
      },
      required: ["gradings", "summary"],
      additionalProperties: false,
    },
  },
  // --- Board refinement -------------------------------------------------
  // These five reshape the planning half of the board. Every one requires a
  // `reason`: Arij records it in the ticket's activity log, so a ticket the
  // agent moved always explains itself. They are refused outside the
  // Backlog and To do columns.
  {
    name: "set_priority",
    description:
      "Set a Backlog/To do ticket's priority (0 low, 1 medium, 2 high, 3 critical). Refused for tickets in in_progress, review, done or released.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: {
          type: "string",
          minLength: 1,
          description: "Id of the ticket to re-prioritise, in this project.",
        },
        priority: {
          type: "integer",
          enum: [0, 1, 2, 3],
          // Must stay in sync with PRIORITY_LABELS (lib/types/kanban.ts) —
          // this shim is plain .mjs and cannot import it. This string is the
          // agent's only semantic anchor for the scale, so an off-by-one here
          // silently inflates every priority the agent sets.
          description: "0 low, 1 medium, 2 high, 3 critical.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Required justification, recorded in the ticket activity log.",
        },
      },
      required: ["ticket_id", "priority", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "reorder_tickets",
    description:
      "Re-rank Backlog/To do tickets by writing their board positions (0 = top of the column). Position is the board's single ordering source, the same one drag-and-drop writes. Send every ticket of the column you are ordering, each id once; this never changes a ticket's column.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          description: "The tickets to place, with their target positions.",
          items: {
            type: "object",
            properties: {
              ticket_id: { type: "string", minLength: 1 },
              position: {
                type: "integer",
                minimum: 0,
                description: "0-based rank inside the ticket's column.",
              },
            },
            required: ["ticket_id", "position"],
            additionalProperties: false,
          },
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Required justification for the new order, recorded on every ticket it moves.",
        },
      },
      required: ["items", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "add_dependency",
    description:
      "Record that one Backlog/To do ticket depends on another (it cannot start until the other is done). Cycles are refused.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: {
          type: "string",
          minLength: 1,
          description: "The dependent ticket — the one that must wait.",
        },
        depends_on_ticket_id: {
          type: "string",
          minLength: 1,
          description: "The ticket it waits for.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Required justification for the edge, recorded in the activity log.",
        },
      },
      required: ["ticket_id", "depends_on_ticket_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_dependency",
    description:
      "Drop a dependency edge between two Backlog/To do tickets. Removing an edge that does not exist reports removed:false rather than failing.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: {
          type: "string",
          minLength: 1,
          description: "The dependent ticket the edge starts from.",
        },
        depends_on_ticket_id: {
          type: "string",
          minLength: 1,
          description: "The ticket it currently waits for.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Required justification, recorded in the activity log.",
        },
      },
      required: ["ticket_id", "depends_on_ticket_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "promote_ticket",
    description:
      "Move a ticket between Backlog and To do: promote it to 'todo' when it is ready to be picked up, or send it back to 'backlog' when it is not. Sending one back REQUIRES `question` — the missing answer — which is posted on the ticket. No other column is reachable through this tool.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", minLength: 1 },
        status: {
          type: "string",
          enum: ["backlog", "todo"],
          description: "Target column.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Required justification, recorded in the ticket activity log.",
        },
        question: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description:
            "Required when status is 'backlog': the open question that has to be answered before the ticket is ready.",
        },
      },
      required: ["ticket_id", "status", "reason"],
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
