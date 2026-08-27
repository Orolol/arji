import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockPromptBuilder = vi.hoisted(() => ({
  buildChatPrompt: vi.fn(() => "CHAT_PROMPT"),
  buildEpicRefinementPrompt: vi.fn(() => "EPIC_PROMPT"),
  buildEpicFinalizationPrompt: vi.fn(() => "EPIC_FINALIZATION_PROMPT"),
  buildTitleGenerationPrompt: vi.fn(() => "TITLE_PROMPT"),
}));

const mockSpawnHelpers = vi.hoisted(() => ({
  spawnClaudeStream: vi.fn(),
  spawnClaude: vi.fn(),
}));

const mockResolveAgentPrompt = vi.hoisted(() => vi.fn());
const mockDynamicProviderSpawn = vi.hoisted(() => vi.fn());
const mockGetProvider = vi.hoisted(() => vi.fn());
const mockResolveAgentByNamedId = vi.hoisted(() => vi.fn());
const mockPersistentTurn = vi.hoisted(() => vi.fn());

// Real drizzle-orm + real @/lib/db/schema: both are side-effect-free pure
// builders, and the chain mock ignores their output. No fake column maps.
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
  spawnClaudeStream: mockSpawnHelpers.spawnClaudeStream,
  spawnClaude: mockSpawnHelpers.spawnClaude,
}));

vi.mock("@/lib/providers", () => ({
  getProvider: mockGetProvider.mockImplementation(() => ({
    spawn: mockDynamicProviderSpawn.mockImplementation(() => ({
      promise: Promise.resolve({ success: true, result: "Codex response" }),
      kill: vi.fn(),
    })),
  })),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: mockResolveAgentPrompt,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

// The per-turn CLI MCP tool channel reads settings from the db and mints
// real tokens; disabled here so the legacy streaming behavior stays
// byte-identical. Its wiring is covered by chat-stream-route-mcp.test.ts.
vi.mock("@/lib/chat/cli-tool-channel", () => ({
  createChatCliToolChannel: vi.fn(() => null),
}));

vi.mock("@/lib/chat/persistent-runner", () => ({
  DEFAULT_MAX_WARM_CHAT_CONVERSATIONS: 3,
  DEFAULT_PERSISTENT_CHAT_IDLE_TIMEOUT_MS: 900_000,
  runPersistentChatTurn: mockPersistentTurn,
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

describe("POST /api/projects/[projectId]/chat/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamicProviderSpawn.mockReset();
    mockDynamicProviderSpawn.mockReturnValue({
      promise: Promise.resolve({ success: true, result: "Codex response" }),
      kill: vi.fn(),
    });
    resetDbMockState();

    mockPromptBuilder.buildChatPrompt.mockReturnValue("CHAT_PROMPT");
    mockPromptBuilder.buildEpicRefinementPrompt.mockReturnValue("EPIC_PROMPT");
    mockPromptBuilder.buildEpicFinalizationPrompt.mockReturnValue("EPIC_FINALIZATION_PROMPT");
    mockPromptBuilder.buildTitleGenerationPrompt.mockReturnValue("TITLE_PROMPT");

    mockResolveAgentPrompt.mockResolvedValue("Chat system prompt");
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: null,
    });

    mockSpawnHelpers.spawnClaude.mockReturnValue({
      promise: Promise.resolve({ success: true, result: "Generated title" }),
    });

    mockSpawnHelpers.spawnClaudeStream.mockReturnValue({
      stream: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      kill: vi.fn(),
    });
    mockPersistentTurn.mockImplementation((options) => ({
      wasWarm: false,
      kill: vi.fn(),
      promise: Promise.resolve().then(() => {
        options.onCliSessionId("persistent-cli-session");
        options.onChunk({ type: "text", text: "Persistent response" });
      }),
    }));
  });

  it("enriches Claude prompt with mentioned text and image document context", async () => {
    const docsList = [
      {
        id: "doc-text",
        projectId: "proj1",
        originalFilename: "spec.md",
        kind: "text",
        markdownContent: "# Spec Body",
        imagePath: null,
      },
      {
        id: "doc-image",
        projectId: "proj1",
        originalFilename: "diagram.png",
        kind: "image",
        markdownContent: null,
        imagePath: "data/documents/proj1/diagram.png",
      },
    ];

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "brainstorm", provider: "claude-code", label: "Brainstorm" },
      { id: "conv1", type: "brainstorm", provider: "claude-code", label: "Brainstorm" },
    ];

    dbMockState.allQueue = [
      // 1. validateMentionsExist → listProjectDocuments
      docsList,
      // 2. recentMessages
      [{ role: "user", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" }],
      // 3. enrichPromptWithDocumentMentions → listProjectDocuments
      docsList,
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({
        content: "Please use @spec.md and @diagram.png",
        conversationId: "conv1",
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(mockSpawnHelpers.spawnClaudeStream).toHaveBeenCalledTimes(1);
    const options = mockSpawnHelpers.spawnClaudeStream.mock.calls[0]?.[0] as { prompt: string };
    expect(options.prompt).toContain("## Mentioned Project Documents");
    expect(options.prompt).toContain("### @spec.md");
    expect(options.prompt).toContain("# Spec Body");
    expect(options.prompt).toContain("@diagram.png references an image available at filesystem path:");
    expect(options.prompt).toContain("data/documents/proj1/diagram.png");
  });

  it("enriches Oh My Pi prompt with mentioned text and image document context", async () => {
    const docsList = [
      {
        id: "doc-text",
        projectId: "proj1",
        originalFilename: "spec.md",
        kind: "text",
        markdownContent: "## Implementation Notes",
        imagePath: null,
      },
      {
        id: "doc-image",
        projectId: "proj1",
        originalFilename: "diagram.png",
        kind: "image",
        markdownContent: null,
        imagePath: "data/documents/proj1/diagram.png",
      },
    ];

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv2", type: "brainstorm", provider: "oh-my-pi", label: "Brainstorm" },
      { id: "conv2", type: "brainstorm", provider: "oh-my-pi", label: "Brainstorm" },
    ];

    dbMockState.allQueue = [
      // 1. validateMentionsExist → listProjectDocuments
      docsList,
      // 2. recentMessages
      [{ role: "user", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" }],
      // 3. enrichPromptWithDocumentMentions → listProjectDocuments
      docsList,
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({
        content: "Please use @spec.md and @diagram.png",
        conversationId: "conv2",
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(mockDynamicProviderSpawn).toHaveBeenCalledTimes(1);
    const options = mockDynamicProviderSpawn.mock.calls[0]?.[0] as { prompt: string };
    expect(options.prompt).toContain("## Mentioned Project Documents");
    expect(options.prompt).toContain("### @spec.md");
    expect(options.prompt).toContain("## Implementation Notes");
    expect(options.prompt).toContain("@diagram.png references an image available at filesystem path:");
    expect(options.prompt).toContain("data/documents/proj1/diagram.png");
  });

  it("uses epic refinement prompt with existing epic titles for epic_creation conversations", async () => {
    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "epic_creation", provider: "claude-code", label: "New Epic" },
      { key: "global_prompt", value: JSON.stringify("Global prompt") },
    ];

    dbMockState.allQueue = [
      // 1. recentMessages
      [
        { role: "user", content: "Need auth flow", createdAt: "2026-01-01T10:00:00.000Z" },
      ],
      // 2. existingEpics
      [
        { title: "User Management", description: "Manage users" },
        { title: "Audit Logs", description: null },
      ],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Let's define the epic", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(mockPromptBuilder.buildEpicRefinementPrompt).toHaveBeenCalledTimes(1);
    expect(mockPromptBuilder.buildChatPrompt).not.toHaveBeenCalled();
    // The route now passes empty docs array [] for the second argument
    expect(mockPromptBuilder.buildEpicRefinementPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Arij" }),
      [],
      [
        { role: "user", content: "Need auth flow" },
        { role: "user", content: "Let's define the epic" },
      ],
      "Global prompt",
      [
        { title: "User Management", description: "Manage users" },
        { title: "Audit Logs", description: null },
      ],
    );
    expect(mockSpawnHelpers.spawnClaudeStream).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "EPIC_PROMPT" }),
    );
  });

  /**
   * A resumed session normally receives only the new user text. Finalization
   * must not: the strict JSON contract lives in the built prompt, and sending
   * "Generate the final epic…" alone made the CLI answer in prose, so the
   * client parser reported "I couldn't extract a full epic yet".
   */
  it("keeps the full finalization prompt when resuming an epic_creation session", async () => {
    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv1",
        type: "epic_creation",
        provider: "claude-code",
        label: "New Epic",
        cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
      },
      { key: "global_prompt", value: JSON.stringify("Global prompt") },
    ];

    dbMockState.allQueue = [
      [{ role: "user", content: "Need auth flow", createdAt: "2026-01-01T10:00:00.000Z" }],
      [],
    ];

    mockSpawnHelpers.spawnClaude.mockReturnValue({
      promise: Promise.resolve({
        success: true,
        result: '```json\n{"title":"Auth"}\n```',
      }),
      kill: vi.fn(),
    });

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({
        content: "Generate the final epic with user stories based on our discussion.",
        conversationId: "conv1",
        finalize: true,
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    await readSseEvents(response);

    expect(mockPromptBuilder.buildEpicFinalizationPrompt).toHaveBeenCalledTimes(1);
    expect(mockSpawnHelpers.spawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "EPIC_FINALIZATION_PROMPT",
        resumeSession: true,
      }),
    );
  });

  it("uses brainstorm chat prompt for non-epic conversations", async () => {
    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "brainstorm", provider: "claude-code", label: "Brainstorm" },
    ];

    dbMockState.allQueue = [
      // 1. recentMessages
      [{ role: "user", content: "How should architecture look?", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Any ideas?", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    expect(mockResolveAgentPrompt).toHaveBeenCalledWith("chat", "proj1");
    expect(mockPromptBuilder.buildChatPrompt).toHaveBeenCalledTimes(1);
    expect(mockPromptBuilder.buildChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Arij" }),
      [],
      [
        { role: "user", content: "How should architecture look?" },
        { role: "user", content: "Any ideas?" },
      ],
      "Chat system prompt",
    );
    expect(mockPromptBuilder.buildEpicRefinementPrompt).not.toHaveBeenCalled();
    expect(mockSpawnHelpers.spawnClaudeStream).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "CHAT_PROMPT" }),
    );
  });

  it("routes an opted-in Claude conversation through the persistent runner", async () => {
    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv-persistent",
        type: "chat",
        provider: "claude-code-persistent",
        label: "Warm chat",
        cliSessionId: null,
      },
    ];
    dbMockState.allQueue = [[]];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Hello", conversationId: "conv-persistent" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(mockPersistentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-persistent",
        provider: "claude-code-persistent",
        prompt: "CHAT_PROMPT",
        mode: "chat",
        idleTimeoutMs: 900_000,
        maxWarmConversations: 3,
      }),
    );
    expect(mockSpawnHelpers.spawnClaude).not.toHaveBeenCalled();
    expect(mockSpawnHelpers.spawnClaudeStream).not.toHaveBeenCalled();
    expect(events).toContainEqual({ delta: "Persistent response" });
    expect(events.at(-1)).toMatchObject({ done: true });
    expect(dbMockState.updateCalls).toContainEqual({
      cliSessionId: "persistent-cli-session",
    });
  });

  it("routes an opted-in Oh My Pi conversation through the RPC adapter", async () => {
    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv-omp-persistent",
        type: "chat",
        provider: "oh-my-pi-persistent",
        label: "Warm OMP chat",
        cliSessionId: "omp-session-existing",
      },
    ];
    dbMockState.allQueue = [[]];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Continue", conversationId: "conv-omp-persistent" }),
      mockRouteContext({ projectId: "proj1" }),
    );
    await readSseEvents(response);

    expect(mockPersistentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-omp-persistent",
        provider: "oh-my-pi-persistent",
        prompt: "Continue",
        cliSessionId: "omp-session-existing",
        resumeSession: true,
      }),
    );
    expect(mockDynamicProviderSpawn).not.toHaveBeenCalled();
    expect(mockSpawnHelpers.spawnClaude).not.toHaveBeenCalled();
    expect(mockSpawnHelpers.spawnClaudeStream).not.toHaveBeenCalled();
  });

  it("falls back to a fresh Oh My Pi run when the named agent's resume session is expired", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "oh-my-pi",
      model: "pi-large",
      namedAgentId: "agent-omp",
    });

    const firstSession = {
      promise: Promise.resolve({
        success: false,
        error: "session not found",
        cliSessionId: "expired-session",
      }),
      kill: vi.fn(),
    };
    const secondSession = {
      promise: Promise.resolve({
        success: true,
        result: "Fresh fallback response",
        cliSessionId: "new-session-123",
      }),
      kill: vi.fn(),
    };

    mockDynamicProviderSpawn
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession);

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv2",
        type: "brainstorm",
        provider: "oh-my-pi",
        namedAgentId: "agent-omp",
        cliSessionId: "expired-session",
        label: "Brainstorm",
      },
    ];
    dbMockState.allQueue = [
      // 1. recentMessages
      [{ role: "user", content: "Previous", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "New message", conversationId: "conv2" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response as unknown as Response);
    expect(events.some((event) => event.delta === "Fresh fallback response")).toBe(true);
    expect(mockDynamicProviderSpawn).toHaveBeenCalledTimes(2);
    expect(mockDynamicProviderSpawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        prompt: "New message",
        cliSessionId: "expired-session",
        resumeSession: true,
      }),
    );
    expect(mockDynamicProviderSpawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        prompt: "CHAT_PROMPT",
        resumeSession: false,
      }),
    );
  });

  it("normalizes JSON envelope from non-streaming provider before storing", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "codex",
      model: undefined,
      namedAgentId: null,
    });

    // Simulate Codex returning a JSON result envelope wrapping markdown
    const envelope = JSON.stringify({
      type: "result",
      result: "Here is the epic:\n\n```json\n{\"title\": \"Auth\"}\n```",
      session_id: "codex-123",
    });
    mockDynamicProviderSpawn.mockReturnValueOnce({
      promise: Promise.resolve({ success: true, result: envelope }),
      kill: vi.fn(),
    });

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "brainstorm", provider: "codex", label: "Chat" },
    ];
    dbMockState.allQueue = [
      [{ role: "user", content: "Hello", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Create epic", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response as unknown as Response);

    // The stored message should be the extracted text, not the raw envelope
    const deltaEvents = events.filter((e) => e.delta);
    const combined = deltaEvents.map((e) => e.delta).join("");
    expect(combined).not.toContain('"type":"result"');
    expect(combined).toContain("Here is the epic:");

    // Verify the DB-persisted assistant message is also normalized
    const assistantInsert = dbMockState.insertCalls.find(
      (v) => (v as Record<string, unknown>).role === "assistant",
    ) as Record<string, unknown>;
    expect(assistantInsert).toBeDefined();
    expect(assistantInsert.content).toContain("Here is the epic:");
    expect(assistantInsert.content).not.toContain('"type":"result"');
  });

  it("normalizes JSON envelope from Claude resume path before storing", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: null,
    });

    // Claude resume returns a result envelope
    const envelope = JSON.stringify({
      type: "result",
      result: "Resumed session output with epic details",
      session_id: "resume-456",
      subtype: "success",
    });
    mockSpawnHelpers.spawnClaude.mockReturnValue({
      promise: Promise.resolve({
        success: true,
        result: envelope,
        cliSessionId: "resume-456",
      }),
      kill: vi.fn(),
    });

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv1",
        type: "brainstorm",
        provider: "claude-code",
        namedAgentId: null,
        cliSessionId: "resume-456",
        label: "Chat",
      },
    ];
    dbMockState.allQueue = [
      [{ role: "user", content: "Hello", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Continue", conversationId: "conv1" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response as unknown as Response);

    const deltaEvents = events.filter((e) => e.delta);
    const combined = deltaEvents.map((e) => e.delta).join("");
    expect(combined).not.toContain('"type":"result"');
    expect(combined).toContain("Resumed session output with epic details");

    // Verify the DB-persisted assistant message is also normalized
    const assistantInsert = dbMockState.insertCalls.find(
      (v) => (v as Record<string, unknown>).role === "assistant",
    ) as Record<string, unknown>;
    expect(assistantInsert).toBeDefined();
    expect(assistantInsert.content).toContain("Resumed session output with epic details");
    expect(assistantInsert.content).not.toContain('"type":"result"');
  });

  it("falls back to a fresh run when a raw oh-my-pi conversation's resume session is expired", async () => {
    // No named agent: the conversation's stored provider overrides the
    // chat default (claude-code) on its own.
    const firstSession = {
      promise: Promise.resolve({
        success: false,
        error: "session not found",
        cliSessionId: "expired-omp",
      }),
      kill: vi.fn(),
    };
    const secondSession = {
      promise: Promise.resolve({
        success: true,
        result: "Fresh omp fallback",
        cliSessionId: "new-omp-session",
      }),
      kill: vi.fn(),
    };

    mockDynamicProviderSpawn
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession);

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv-omp",
        type: "brainstorm",
        provider: "oh-my-pi",
        namedAgentId: null,
        cliSessionId: "expired-omp",
        label: "Chat",
      },
    ];
    dbMockState.allQueue = [
      [{ role: "user", content: "Previous", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Continue", conversationId: "conv-omp" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response as unknown as Response);
    expect(events.some((e) => e.delta === "Fresh omp fallback")).toBe(true);
    expect(mockDynamicProviderSpawn).toHaveBeenCalledTimes(2);
    expect(mockDynamicProviderSpawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        prompt: "Continue",
        cliSessionId: "expired-omp",
        resumeSession: true,
      }),
    );
    expect(mockDynamicProviderSpawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        prompt: "CHAT_PROMPT",
        resumeSession: false,
      }),
    );
  });

  /**
   * This used to assert a codex resume followed by an expired-session
   * fallback. That resume could never succeed: codex only receives a
   * cliSessionId inside its `exec resume` branch and its parseSessionId()
   * returns undefined, so the stored id is always one Arij invented and
   * `codex exec resume <it>` is rejected. The old behaviour was a guaranteed
   * wasted CLI round-trip before the fallback; codex now goes straight to a
   * fresh run.
   */
  it("starts a fresh Codex run instead of a resume that cannot succeed", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "codex",
      model: undefined,
      namedAgentId: null,
    });

    mockDynamicProviderSpawn.mockReturnValueOnce({
      promise: Promise.resolve({
        success: true,
        result: "Fresh codex run",
        cliSessionId: "new-codex-session",
      }),
      kill: vi.fn(),
    });

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv-codex",
        type: "brainstorm",
        provider: "codex",
        namedAgentId: null,
        cliSessionId: "stale-codex",
        label: "Chat",
      },
    ];
    dbMockState.allQueue = [
      [{ role: "user", content: "Previous", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Continue", conversationId: "conv-codex" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response as unknown as Response);
    expect(events.some((e) => e.delta === "Fresh codex run")).toBe(true);
    expect(mockDynamicProviderSpawn).toHaveBeenCalledTimes(1);
    expect(mockDynamicProviderSpawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ resumeSession: false }),
    );
  });

  // -------------------------------------------------------------------
  // Oh My Pi: the conversation APIs accept it, so chat must honour the
  // stored provider instead of falling back to the chat default.
  // -------------------------------------------------------------------

  it("runs a stored oh-my-pi conversation on that provider, not the chat default", async () => {
    // The chat default stays claude-code; only the conversation says omp.
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: null,
    });

    mockDynamicProviderSpawn.mockReturnValueOnce({
      promise: Promise.resolve({
        success: true,
        result: "Omp answered",
        cliSessionId: "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50",
      }),
      kill: vi.fn(),
    });

    dbMockState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      {
        id: "conv-omp",
        type: "brainstorm",
        provider: "oh-my-pi",
        namedAgentId: null,
        cliSessionId: null,
        label: "Chat",
      },
    ];
    dbMockState.allQueue = [[]];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockJsonRequest({ content: "Hello", conversationId: "conv-omp" }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response as unknown as Response);
    expect(events.some((e) => e.delta === "Omp answered")).toBe(true);

    expect(mockGetProvider).toHaveBeenCalledWith("oh-my-pi");
    expect(mockSpawnHelpers.spawnClaudeStream).not.toHaveBeenCalled();
    // omp reports its own session id; minting one would store an id the CLI
    // never used and replay it into the resume flag next turn.
    expect(mockDynamicProviderSpawn.mock.calls[0]?.[0].cliSessionId).toBeUndefined();
  });
});
