/**
 * Route-level tests for the fast-mode (OpenAI-compatible) TOOL LOOP in
 * POST /api/projects/[projectId]/chat/stream.
 *
 * Complements chat-stream-route-openai.test.ts (plain streaming, errors,
 * cancellation) — this file covers the multi-round tool-calling loop:
 * status events, internal app-route execution, follow-up completions
 * requests, round separators, MCP token lifecycle, the retry-without-tools
 * fallback and the MAX_TOOL_ROUNDS budget.
 *
 * The global fetch mock routes by URL: requests ending in /chat/completions
 * get scripted SSE bodies; everything else (the app's own HTTP routes that
 * board tools call) goes to a per-test app handler returning JSON.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";
import {
  resolveMcpToken,
  _resetMcpTokenStoreForTests,
  type McpTokenRecord,
} from "@/lib/mcp/token-store";

const mockPromptBuilder = vi.hoisted(() => ({
  buildChatPrompt: vi.fn(() => "CHAT_PROMPT"),
  buildEpicRefinementPrompt: vi.fn(() => "EPIC_PROMPT"),
  buildEpicFinalizationPrompt: vi.fn(() => "FINALIZE_PROMPT"),
  buildTitleGenerationPrompt: vi.fn(() => "TITLE_PROMPT"),
}));

const mockResolveAgentPrompt = vi.hoisted(() => vi.fn());
const mockResolveAgentByNamedId = vi.hoisted(() => vi.fn());
const mockGetProvider = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "id-123"),
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildChatPrompt: mockPromptBuilder.buildChatPrompt,
  buildEpicRefinementPrompt: mockPromptBuilder.buildEpicRefinementPrompt,
  buildEpicFinalizationPrompt: mockPromptBuilder.buildEpicFinalizationPrompt,
  buildTitleGenerationPrompt: mockPromptBuilder.buildTitleGenerationPrompt,
}));

vi.mock("@/lib/claude/spawn", () => ({
  spawnClaudeStream: vi.fn(),
  spawnClaude: vi.fn(),
}));

vi.mock("@/lib/providers", () => ({
  getProvider: mockGetProvider,
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: mockResolveAgentPrompt,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

/* ------------------------------------------------------------------ */
/* SSE helpers                                                         */
/* ------------------------------------------------------------------ */

async function readSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = response.body;
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore malformed data lines
      }
    }
  }

  return events;
}

function sseChunkLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** One-shot SSE Response from raw data lines, terminated by [DONE]. */
function sseBody(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("") + "data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Plain-text completion: one delta chunk per string. */
function sseTextResponse(deltas: string[]): Response {
  return sseBody(deltas.map((d) => sseChunkLine({ choices: [{ delta: { content: d } }] })));
}

interface ScriptedToolCall {
  id: string;
  name: string;
  /** Argument string split across streaming fragments (assembler input). */
  argChunks: string[];
}

/**
 * Tool-call completion: an optional leading text delta, then the calls as
 * streamed fragments (id+name in the first fragment, argument continuations
 * in follow-ups — exercising ToolCallAssembler through the route).
 */
function sseToolCallsResponse(calls: ScriptedToolCall[], textBefore?: string): Response {
  const lines: string[] = [];
  if (textBefore) {
    lines.push(sseChunkLine({ choices: [{ delta: { content: textBefore } }] }));
  }
  calls.forEach((call, index) => {
    lines.push(
      sseChunkLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.argChunks[0] ?? "" },
                },
              ],
            },
          },
        ],
      }),
    );
    for (const chunk of call.argChunks.slice(1)) {
      lines.push(
        sseChunkLine({
          choices: [{ delta: { tool_calls: [{ index, function: { arguments: chunk } }] } }],
        }),
      );
    }
  });
  return sseBody(lines);
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/* DB seeding                                                          */
/* ------------------------------------------------------------------ */

/**
 * Seeds the DB for a fast-mode conversation:
 * getQueue: [project, conversation, base_url, api_key, model,
 *            reasoning_effort, ...extraGets]
 * allQueue: [recentMessages(desc order — the route reverses it)]
 *
 * `extraGets` feeds `.get()` calls made DURING the tool loop (the
 * ticket-ref resolution in lib/chat/board-tools.ts resolveTicketRef).
 */
function seedFastModeConversation(overrides: {
  conversation?: Record<string, unknown>;
  recentMessages?: Array<Record<string, unknown>>;
  settings?: Partial<Record<string, string>> | null;
  extraGets?: unknown[];
} = {}) {
  const settings = overrides.settings === null
    ? null
    : {
        openai_base_url: "http://localhost:11434/v1",
        openai_api_key: "sk-test",
        openai_model: "llama3.1",
        openai_reasoning_effort: "off",
        ...overrides.settings,
      };
  const settingRows = settings
    ? [
        { key: "openai_base_url", value: JSON.stringify(settings.openai_base_url) },
        { key: "openai_api_key", value: JSON.stringify(settings.openai_api_key) },
        { key: "openai_model", value: JSON.stringify(settings.openai_model) },
        { key: "openai_reasoning_effort", value: JSON.stringify(settings.openai_reasoning_effort) },
      ]
    : [];

  dbMockState.getQueue = [
    { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
    overrides.conversation ?? {
      id: "conv1",
      type: "chat",
      provider: "openai-compatible",
      label: "Chat",
      status: "active",
      namedAgentId: null,
    },
    ...settingRows,
    // Consumed by the route's isMcpToolsEnabled() gate (an absent row also
    // means enabled, but the positional queue needs the slot filled so the
    // in-loop ticket-ref reads line up with extraGets).
    ...(settingRows.length > 0 ? [{ key: "mcp_tools_enabled", value: "true" }] : []),
    ...(overrides.extraGets ?? []),
  ];

  dbMockState.allQueue = [
    overrides.recentMessages ?? [
      { role: "assistant", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" },
    ],
  ];
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

const COMPLETIONS_URL = "http://localhost:11434/v1/chat/completions";
/** mockJsonRequest defaults to http://localhost:3000/... — the route derives
 *  the board-tools base URL from request.nextUrl.origin. */
const APP_ORIGIN = "http://localhost:3000";

interface CompletionsBody {
  model: string;
  stream: boolean;
  messages: Array<{
    role: string;
    content: string;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }>;
  tools?: Array<{ type: string; function: { name: string } }>;
}

describe("POST /api/projects/[projectId]/chat/stream — fast-mode tool loop", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Scripted /chat/completions responses, consumed in order. */
  let completionsQueue: Array<() => Response>;
  /** Used when the queue is empty (for "always answers with a tool call"). */
  let completionsFallback: (() => Response) | null;
  /** Handler for the app's own routes (board-tool execution). */
  let appHandler: (url: string, init: RequestInit) => Response;

  const completionsCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/chat/completions")) as Array<
      [string, RequestInit]
    >;
  const appCalls = () =>
    fetchMock.mock.calls.filter(([u]) => !String(u).endsWith("/chat/completions")) as Array<
      [string, RequestInit]
    >;
  const completionsBody = (index: number): CompletionsBody =>
    JSON.parse(String(completionsCalls()[index]![1].body)) as CompletionsBody;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    _resetMcpTokenStoreForTests();

    mockResolveAgentPrompt.mockResolvedValue("Chat system prompt");
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: null,
    });

    completionsQueue = [];
    completionsFallback = null;
    appHandler = (url) => {
      throw new Error(`Unexpected app fetch in test: ${url}`);
    };

    fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        const next = completionsQueue.shift() ?? completionsFallback;
        if (!next) throw new Error(`No scripted completions response left for ${url}`);
        return next();
      }
      return appHandler(url, init ?? {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("runs a two-round loop: status event, internal API call, follow-up request with tool messages", async () => {
    seedFastModeConversation();
    completionsQueue.push(
      // Round 1: the model calls list_tickets (arguments split over chunks).
      () => sseToolCallsResponse([{ id: "call_1", name: "list_tickets", argChunks: ["{", "}"] }]),
      // Round 2: plain text answer.
      () => sseTextResponse(["There are ", "2 tickets."]),
    );
    const epicRows = [
      {
        id: "e1",
        readableId: "E-arij-001",
        title: "First",
        status: "todo",
        type: "feature",
        priority: 2,
        usDone: 1,
        usCount: 3,
        prStatus: null,
        latestSessionOutcome: null,
      },
      {
        id: "e2",
        readableId: "B-arij-002",
        title: "Second",
        status: "done",
        type: "bug",
        priority: 1,
        usDone: 2,
        usCount: 2,
        prStatus: "merged",
        latestSessionOutcome: "success",
      },
    ];
    appHandler = (url, init) => {
      if (url === `${APP_ORIGIN}/api/projects/proj1/epics` && init.method === "GET") {
        return jsonOk({ data: epicRows });
      }
      throw new Error(`Unexpected app fetch: ${init.method} ${url}`);
    };

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "How many tickets?", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    expect(events).toEqual([
      { status: "Using list_tickets..." },
      { delta: "There are " },
      { delta: "2 tickets." },
      { done: true, messageId: "id-123" },
    ]);

    // The board read went through the app's own epics route, without MCP auth.
    expect(appCalls()).toHaveLength(1);
    const [epicsUrl, epicsInit] = appCalls()[0]!;
    expect(epicsUrl).toBe(`${APP_ORIGIN}/api/projects/proj1/epics`);
    expect(epicsInit.method).toBe("GET");
    const epicsHeaders = epicsInit.headers as Record<string, string>;
    expect(epicsHeaders.Authorization).toBeUndefined();

    // The second completions request replays the tool exchange.
    expect(completionsCalls()).toHaveLength(2);
    const secondBody = completionsBody(1);
    const assistantMsg = secondBody.messages.at(-2)!;
    expect(assistantMsg).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "list_tickets", arguments: "{}" },
        },
      ],
    });
    const toolMsg = secondBody.messages.at(-1)!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    const toolResult = JSON.parse(toolMsg.content) as {
      count: number;
      by_status: Record<string, number>;
      tickets: Array<Record<string, unknown>>;
    };
    expect(toolResult.count).toBe(2);
    expect(toolResult.by_status).toEqual({ todo: 1, done: 1 });
    expect(toolResult.tickets[0]).toMatchObject({
      readable_id: "E-arij-001",
      status: "todo",
      stories_done: 1,
      stories_total: 3,
    });

    // The turn persists normally: user first, assistant reply from round 2.
    expect(dbMockState.insertCalls[0]).toMatchObject({
      role: "user",
      content: "How many tickets?",
    });
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: "There are 2 tickets.",
      conversationId: "conv1",
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "generating" });
    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
  });

  it("still advertises the board tools on the follow-up completions request", async () => {
    seedFastModeConversation();
    completionsQueue.push(
      () => sseToolCallsResponse([{ id: "call_1", name: "list_tickets", argChunks: ["{}"] }]),
      () => sseTextResponse(["Done."]),
    );
    appHandler = () => jsonOk({ data: [] });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Check the board", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    expect(completionsCalls()).toHaveLength(2);
    for (const index of [0, 1]) {
      const body = completionsBody(index);
      expect(body.stream).toBe(true);
      expect(body.tools?.map((t) => t.function.name)).toContain("list_tickets");
    }
  });

  it("separates round texts with a \\n\\n delta", async () => {
    seedFastModeConversation();
    completionsQueue.push(
      () =>
        sseToolCallsResponse(
          [{ id: "call_1", name: "list_tickets", argChunks: ["{}"] }],
          "Checking the board.",
        ),
      () => sseTextResponse(["Two tickets found."]),
    );
    appHandler = () => jsonOk({ data: [] });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "What's on the board?", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    expect(events).toEqual([
      { delta: "Checking the board." },
      { status: "Using list_tickets..." },
      { delta: "\n\nTwo tickets found." },
      { done: true, messageId: "id-123" },
    ]);

    // The persisted assistant message contains both rounds, separated.
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: "Checking the board.\n\nTwo tickets found.",
    });
  });

  it("executes MCP-authed tools with a per-turn Bearer token and revokes it after the turn", async () => {
    seedFastModeConversation({
      // Ticket-ref resolution during the tool call reads the DB directly.
      extraGets: [{ id: "epic-9", readableId: "E-arij-042", title: "Ship it" }],
    });
    completionsQueue.push(
      () =>
        sseToolCallsResponse([
          {
            id: "call_9",
            name: "update_ticket_status",
            argChunks: [
              JSON.stringify({ ticket_id: "E-arij-042", status: "done", reason: "looks good" }),
            ],
          },
        ]),
      () => sseTextResponse(["Moved."]),
    );

    let seenAuth: string | null = null;
    let recordDuringCall: McpTokenRecord | null = null;
    let mcpBody: Record<string, unknown> | null = null;
    appHandler = (url, init) => {
      if (url === `${APP_ORIGIN}/api/mcp/update-ticket-status` && init.method === "POST") {
        const headers = init.headers as Record<string, string>;
        seenAuth = headers.Authorization ?? null;
        const token = seenAuth?.startsWith("Bearer ") ? seenAuth.slice("Bearer ".length) : "";
        // The token store is a real globalThis-backed singleton shared with
        // the route, so validity DURING the call is observable here. Snapshot
        // the record: the route revokes it (in place) after the turn.
        const record = resolveMcpToken(token);
        recordDuringCall = record ? { ...record } : null;
        mcpBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonOk({ data: { ticket_id: "epic-9", status: "done" } });
      }
      throw new Error(`Unexpected app fetch: ${init.method} ${url}`);
    };

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Move E-arij-042 to done", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    expect(events).toEqual([
      { status: "Using update_ticket_status..." },
      { delta: "Moved." },
      { done: true, messageId: "id-123" },
    ]);

    // The readable id was resolved to the real ticket id before the MCP post.
    expect(mcpBody).toEqual({ ticket_id: "epic-9", status: "done", reason: "looks good" });

    // MCP route was called with a live per-turn token, attributed to chat.
    expect(seenAuth).toMatch(/^Bearer arij-mcp-/);
    expect(recordDuringCall).not.toBeNull();
    expect(recordDuringCall).toMatchObject({
      projectId: "proj1",
      agentType: "chat",
      epicId: null,
      revokedAt: null,
    });

    // After the turn completes, the token is revoked (resolves to null).
    const token = seenAuth!.slice("Bearer ".length);
    expect(resolveMcpToken(token)).toBeNull();

    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: "Moved.",
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
  });

  it("retries without tools when the endpoint rejects the tools field", async () => {
    seedFastModeConversation();
    completionsQueue.push(
      () =>
        new Response(JSON.stringify({ error: { message: "unknown field tools" } }), {
          status: 400,
          statusText: "Bad Request",
        }),
      () => sseTextResponse(["Plain ", "answer"]),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Hello", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    expect(events).toEqual([
      { status: "Board tools unavailable on this endpoint — continuing without them." },
      { delta: "Plain " },
      { delta: "answer" },
      { done: true, messageId: "id-123" },
    ]);

    expect(completionsCalls()).toHaveLength(2);
    const firstBody = completionsBody(0);
    expect(firstBody.tools?.length).toBeGreaterThan(0);
    const retryBody = completionsBody(1);
    expect("tools" in retryBody).toBe(false);
    // The retry drops the board-tools system section (the model must not be
    // told it has tools it no longer gets) and keeps the project-context
    // prompt and the rest verbatim.
    expect(retryBody.messages[0]).toEqual({ role: "system", content: "CHAT_PROMPT" });
    expect(firstBody.messages[0].content).toMatch(/^CHAT_PROMPT\n\n/);
    expect(retryBody.messages.slice(1)).toEqual(firstBody.messages.slice(1));

    // The retry succeeded, so the turn is a normal successful one.
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: "Plain answer",
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
    expect(dbMockState.updateCalls).not.toContainEqual({ status: "error" });
  });

  it("stops after 8 rounds when the model keeps calling tools, with a budget note and a persisted turn", async () => {
    seedFastModeConversation();
    // Every completions request answers with another tool call.
    completionsFallback = () =>
      sseToolCallsResponse([{ id: "call_x", name: "list_tickets", argChunks: ["{}"] }]);
    appHandler = () => jsonOk({ data: [] });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Loop forever", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);

    // Exactly MAX_TOOL_ROUNDS (8) upstream requests; the 8th round's tool
    // calls are NOT executed (budget note instead), so 7 tool executions.
    expect(completionsCalls()).toHaveLength(8);
    expect(appCalls()).toHaveLength(7);

    const statusEvents = events.filter((e) => "status" in e);
    expect(statusEvents).toHaveLength(7);
    expect(statusEvents.every((e) => e.status === "Using list_tickets...")).toBe(true);

    const budgetNote = "[Stopped: tool budget of 8 rounds exhausted.]";
    expect(events.at(-2)).toEqual({ delta: budgetNote });
    expect(events.at(-1)).toEqual({ done: true, messageId: "id-123" });

    // The turn still persists an assistant message carrying the note.
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: budgetNote,
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
  });
});
