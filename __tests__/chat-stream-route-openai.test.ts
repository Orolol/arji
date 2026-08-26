import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

/**
 * `buildChatPrompt` echoes the system prompt it was handed so tests can tell
 * "the project-context prompt was built" apart from "the raw configured
 * system prompt leaked through".
 */
const chatPromptFor = (systemPrompt?: string | null) =>
  `CHAT_PROMPT[${systemPrompt ?? ""}]`;

const mockPromptBuilder = vi.hoisted(() => ({
  buildChatPrompt: vi.fn(),
  buildEpicRefinementPrompt: vi.fn(() => "EPIC_PROMPT"),
  buildEpicFinalizationPrompt: vi.fn(() => "EPIC_FINALIZATION_PROMPT"),
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

/** SSE body: the given deltas, one `data:` line each, terminated by [DONE]. */
function sseResponse(deltas: string[]): Response {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
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

/**
 * Seeds the DB for a fast-mode conversation:
 * getQueue: [project, conversation, base_url, api_key, model, reasoning_effort]
 * allQueue: [recentMessages(desc order — the route reverses it)]
 */
function seedFastModeConversation(overrides: {
  conversation?: Record<string, unknown>;
  recentMessages?: Array<Record<string, unknown>>;
  /** Pass null to seed no OpenAI settings at all (endpoint not configured). */
  settings?: Partial<Record<string, string>> | null;
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
  ];

  dbMockState.allQueue = [
    overrides.recentMessages ?? [
      { role: "assistant", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" },
    ],
  ];
}

describe("POST /api/projects/[projectId]/chat/stream — OpenAI-compatible fast mode", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();

    mockPromptBuilder.buildChatPrompt.mockImplementation(
      (
        _project: unknown,
        _documents: unknown,
        _messages: unknown,
        systemPrompt?: string | null,
      ) => chatPromptFor(systemPrompt),
    );
    mockResolveAgentPrompt.mockResolvedValue("Chat system prompt");
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: null,
    });

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("streams SSE deltas to the client and persists the assistant message", async () => {
    seedFastModeConversation();
    fetchMock.mockResolvedValue(sseResponse(["Hel", "lo"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSseEvents(response);
    expect(events).toEqual([
      { delta: "Hel" },
      { delta: "lo" },
      { done: true, messageId: "id-123" },
    ]);

    // The user message was persisted before the upstream call.
    expect(dbMockState.insertCalls[0]).toMatchObject({
      role: "user",
      content: "Current question",
      conversationId: "conv1",
    });
    // The assistant reply is persisted from the accumulated deltas.
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: "Hello",
      conversationId: "conv1",
    });
    // Status transition: generating while streaming, active on success.
    expect(dbMockState.updateCalls).toContainEqual({ status: "generating" });
    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
  });

  it("posts the project-context system prompt plus recent history to /chat/completions with stream: true", async () => {
    seedFastModeConversation();
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("llama3.1");
    expect(body.stream).toBe(true);
    // System prompt first (project-context prompt + board-tools section),
    // then the history in chronological order (the just-saved user message
    // included).
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].role).toBe("system");
    expect(
      body.messages[0].content.startsWith(
        `${chatPromptFor("Chat system prompt")}\n\n`,
      ),
    ).toBe(true);
    expect(body.messages[0].content).toContain("project assistant");
    expect(body.messages.slice(1)).toEqual([
      { role: "assistant", content: "Previous message" },
      { role: "user", content: "Current question" },
    ]);
    // Parity with the CLI path: the system message is the project-context
    // prompt (spec, memory, documents), not the bare configured prompt.
    // History is left out of it — it travels as chat messages above.
    expect(mockPromptBuilder.buildChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj1", spec: "spec" }),
      [],
      [],
      "Chat system prompt",
    );
    // The board tools ride along on every fast-mode chat request.
    const tools = (JSON.parse(String(init.body)) as {
      tools?: Array<{ function: { name: string } }>;
    }).tools;
    expect(tools?.map((t) => t.function.name)).toContain("list_tickets");
  });

  it("sends the Bearer key only when one is configured", async () => {
    seedFastModeConversation({ settings: { openai_api_key: "" } });
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes reasoning_effort in the body only when it is not off", async () => {
    seedFastModeConversation({ settings: { openai_reasoning_effort: "medium" } });
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
  });

  it("still sends the project context and board-tools section when no chat system prompt is configured", async () => {
    // The built-in chat prompt is empty by default, so this is the shape a
    // fresh install runs with — the model must still learn what the project
    // is instead of answering as a generic assistant.
    mockResolveAgentPrompt.mockResolvedValue("   ");
    seedFastModeConversation();
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages.filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    // The project-context prompt still leads even with an empty configured
    // prompt, and the board section rides along after it.
    expect(
      system[0].content.startsWith(`${chatPromptFor("   ")}\n\n`),
    ).toBe(true);
    expect(system[0].content).toContain("project assistant");
  });

  it("supports epic_creation refinement and finalization prompts in OpenAI-compatible fast mode", async () => {
    // Refinement prompt when finalize is false
    seedFastModeConversation({
      conversation: {
        id: "conv-epic",
        type: "epic_creation",
        provider: "openai-compatible",
        label: "New Epic",
        status: "active",
        namedAgentId: null,
      },
      settings: {},
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const resRefine = await POST(
      mockJsonRequest({ content: "Refine epic idea", conversationId: "conv-epic", finalize: false }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(resRefine.status).toBe(200);
    // The epic prompt embeds the transcript, so it must stop at the previous
    // turn: the current message is sent once, as the `user` turn below.
    expect(mockPromptBuilder.buildEpicRefinementPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj1" }),
      [],
      [{ role: "assistant", content: "Previous message" }],
      expect.anything(),
      expect.anything(),
    );
    const refineReqBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(refineReqBody.messages).toEqual([
      { role: "system", content: "EPIC_PROMPT" },
      { role: "user", content: "Refine epic idea" },
    ]);
    // Drain before re-seeding: the stream's tail still issues DB reads, and
    // those would otherwise consume the rows seeded for the finalize call.
    await readSseEvents(resRefine);

    // Finalization prompt when finalize is true
    seedFastModeConversation({
      conversation: {
        id: "conv-epic",
        type: "epic_creation",
        provider: "openai-compatible",
        label: "New Epic",
        status: "active",
        namedAgentId: null,
      },
      settings: {},
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResponse(["```json\n{\"title\": \"Epic\"}\n```"]));

    const resFinalize = await POST(
      mockJsonRequest({ content: "Generate stories", conversationId: "conv-epic", finalize: true }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(resFinalize.status).toBe(200);
    expect(mockPromptBuilder.buildEpicFinalizationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj1" }),
      [],
      [{ role: "assistant", content: "Previous message" }],
      expect.anything(),
      expect.anything(),
    );
    const finalizeReqBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(finalizeReqBody.messages).toEqual([
      { role: "system", content: "EPIC_FINALIZATION_PROMPT" },
      { role: "user", content: "Generate stories" },
    ]);
  });

  it("supports brainstorm conversations with OpenAI-compatible fast mode", async () => {
    seedFastModeConversation({
      conversation: {
        id: "conv-brainstorm",
        type: "brainstorm",
        provider: "openai-compatible",
        label: "Brainstorm",
        status: "active",
        namedAgentId: null,
      },
      settings: {},
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Hello", conversationId: "conv-brainstorm" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("rejects image attachments with 400", async () => {
    seedFastModeConversation();
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({
        content: "Look at this",
        conversationId: "conv1",
        attachmentIds: ["att-1"],
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("attachments are not supported");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("rejects with 400 when the endpoint is not configured", async () => {
    seedFastModeConversation({ settings: null }); // no settings rows -> empty config
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Hello", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("emits a readable error delta and marks the conversation error on HTTP failure", async () => {
    seedFastModeConversation();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        statusText: "Unauthorized",
      }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    const failureMessage = "OpenAI-compatible API error: 401 Unauthorized: Invalid API key";
    expect(events).toEqual([
      { delta: failureMessage },
      { done: true, messageId: "id-123" },
    ]);

    // The user message remains in history; the failure is persisted as the
    // assistant entry so the next message starts from a consistent state.
    expect(dbMockState.insertCalls[0]).toMatchObject({ role: "user" });
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: failureMessage,
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "generating" });
    expect(dbMockState.updateCalls).toContainEqual({ status: "error" });
  });

  it("emits a readable error delta when the server is unreachable", async () => {
    seedFastModeConversation();
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    const failureMessage =
      "OpenAI-compatible API error: connection refused — is the server running.";
    expect(events).toEqual([
      { delta: failureMessage },
      { done: true, messageId: "id-123" },
    ]);
    expect(dbMockState.updateCalls).toContainEqual({ status: "error" });
  });
  it("enriches the system prompt with @document mentions in fast mode", async () => {
    seedFastModeConversation();
    const docRow = {
      id: "doc-1",
      projectId: "proj1",
      originalFilename: "architecture.md",
      storedFilename: "doc-1_architecture.md",
      mimeType: "text/markdown",
      fileSize: 1234,
      kind: "text" as const,
      summary: "System architecture doc",
      contentPreview: "# Architecture\nOur architecture details.",
      markdownContent: "# Architecture\nOur architecture details.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    // 1. validateMentionsExist -> listProjectDocuments
    // 2. recentMessages -> chatMessages
    // 3. enrichPromptWithDocumentMentions -> listProjectDocuments
    dbMockState.allQueue = [
      [docRow],
      [{ role: "assistant", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" }],
      [docRow],
    ];
    fetchMock.mockResolvedValue(sseResponse(["ok"]));

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Please read @architecture.md", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("Chat system prompt");
    expect(body.messages[0]?.content).toContain("architecture.md");
    expect(body.messages[0]?.content).toContain("Our architecture details");
  });

  it("preserves partial output when a stream fails mid-flight", async () => {
    seedFastModeConversation();
    let chunkCount = 0;
    const errorStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkCount === 0) {
          chunkCount++;
          const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial answer" } }] })}\n\n`;
          controller.enqueue(new TextEncoder().encode(line));
        } else {
          controller.error(new Error("Stream broke mid-way"));
        }
      },
    });
    fetchMock.mockResolvedValue(
      new Response(errorStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    const failureMessage = "OpenAI-compatible API error: Stream broke mid-way";
    expect(events).toEqual([
      { delta: "Partial answer" },
      { delta: `\n\n${failureMessage}` },
      { done: true, messageId: "id-123" },
    ]);

    // Assistant message contains the partial content plus the failure message
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: `Partial answer\n\n${failureMessage}`,
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "error" });
  });
  it("handles mid-stream SSE error events by preserving partial output and setting status to error", async () => {
    seedFastModeConversation();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Drafting answer " } }] })}\n\n` +
            `data: ${JSON.stringify({ error: { message: "Context length exceeded", code: 400 } })}\n\n`
          )
        );
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const events = await readSseEvents(response);
    const failureMessage = "OpenAI-compatible API error: Context length exceeded";
    expect(events).toEqual([
      { delta: "Drafting answer " },
      { delta: `\n\n${failureMessage}` },
      { done: true, messageId: "id-123" },
    ]);

    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: `Drafting answer \n\n${failureMessage}`,
    });
    expect(dbMockState.updateCalls).toContainEqual({ status: "error" });
  });

  it("persists partial output when killed from the monitor after some tokens have streamed", async () => {
    seedFastModeConversation();
    const delayedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial thoughts" } }] })}\n\n`;
        controller.enqueue(new TextEncoder().encode(line));
      },
    });
    fetchMock.mockResolvedValue(
      new Response(delayedStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const { activityRegistry } = await import("@/lib/activity-registry");

    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const activities = activityRegistry.listByProject("proj1");
    expect(activities).toHaveLength(1);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let firstChunk = "";
    if (reader) {
      const { value } = await reader.read();
      if (value) firstChunk = decoder.decode(value);
      reader.releaseLock();
    }
    expect(firstChunk).toContain("Partial thoughts");

    // Kill from monitor
    activityRegistry.cancel(activities[0]!.id);

    // Remainder of stream delivers the done marker
    const remainingEvents = await readSseEvents(response);
    expect(remainingEvents).toEqual([
      { done: true, messageId: "id-123" },
    ]);
    // Assistant message contains the partial output
    expect(dbMockState.insertCalls[1]).toMatchObject({
      role: "assistant",
      content: "Partial thoughts",
    });
  });

  it("resets status to active and saves nothing when the stream is cancelled by the client", async () => {
    seedFastModeConversation();
    const hungStream = new ReadableStream<Uint8Array>({
      start() {
        // Never produces data; waits for cancellation
      },
    });
    fetchMock.mockResolvedValue(
      new Response(hungStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(dbMockState.updateCalls).toContainEqual({ status: "generating" });

    // Cancel the SSE response stream
    await response.body?.cancel();

    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
    // Only the user message was inserted; no assistant message on client cancel
    expect(dbMockState.insertCalls).toHaveLength(1);
    expect(dbMockState.insertCalls[0]).toMatchObject({ role: "user" });
  });

  it("closes the SSE response stream when killed from the server / monitor", async () => {
    seedFastModeConversation();
    const hungStream = new ReadableStream<Uint8Array>({
      start() {
        // Never produces data
      },
    });
    fetchMock.mockResolvedValue(
      new Response(hungStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const { activityRegistry } = await import("@/lib/activity-registry");

    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const activities = activityRegistry.listByProject("proj1");
    const activity = activities[0]!;
    expect(activity.provider).toBe("openai-compatible");

    // Server-side kill from monitor
    activityRegistry.cancel(activity.id);

    // Stream must terminate so the client reader completes without hanging
    const events = await readSseEvents(response);
    expect(events).toEqual([]);
    expect(dbMockState.updateCalls).toContainEqual({ status: "active" });
    expect(dbMockState.insertCalls).toHaveLength(1);
  });

  it("keeps CLI providers on the CLI path (openai branch is provider-scoped)", async () => {
    seedFastModeConversation({
      conversation: {
        id: "conv1",
        type: "brainstorm",
        provider: "oh-my-pi",
        label: "Brainstorm",
        status: "active",
        namedAgentId: null,
      },
    });
    mockGetProvider.mockReturnValue({
      spawn: vi.fn(() => ({
        promise: Promise.resolve({ success: true, result: "CLI response" }),
        kill: vi.fn(),
      })),
    });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    await readSseEvents(response);
    expect(mockGetProvider).toHaveBeenCalledWith("oh-my-pi");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the default agent's model when the conversation picks another CLI provider", async () => {
    // The default chat agent is Claude Code with a Claude model; the
    // conversation asks for Codex. Passing that model through would spawn
    // `codex -m claude-opus-4-6`, which the CLI rejects.
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: "claude-opus-4-6",
      namedAgentId: null,
    });
    seedFastModeConversation({
      conversation: {
        id: "conv1",
        type: "brainstorm",
        provider: "codex",
        label: "Brainstorm",
        status: "active",
        namedAgentId: null,
      },
    });
    const spawn = vi.fn(() => ({
      promise: Promise.resolve({ success: true, result: "Codex response" }),
      kill: vi.fn(),
    }));
    mockGetProvider.mockReturnValue({ spawn });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    expect(mockGetProvider).toHaveBeenCalledWith("codex");
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
    );
  });

  it("keeps the resolved model when the conversation provider matches the agent's", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "oh-my-pi",
      model: "pi-large",
      namedAgentId: null,
    });
    seedFastModeConversation({
      conversation: {
        id: "conv1",
        type: "brainstorm",
        provider: "oh-my-pi",
        label: "Brainstorm",
        status: "active",
        namedAgentId: null,
      },
    });
    const spawn = vi.fn(() => ({
      promise: Promise.resolve({ success: true, result: "Omp response" }),
      kill: vi.fn(),
    }));
    mockGetProvider.mockReturnValue({ spawn });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Current question", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "pi-large" }),
    );
  });
});
