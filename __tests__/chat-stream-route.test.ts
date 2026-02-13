import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
  insertedValues: [] as unknown[],
  updatedValues: [] as unknown[],
}));

const mockPromptBuilder = vi.hoisted(() => ({
  buildChatPrompt: vi.fn(() => "CHAT_PROMPT"),
  buildEpicRefinementPrompt: vi.fn(() => "EPIC_PROMPT"),
  buildTitleGenerationPrompt: vi.fn(() => "TITLE_PROMPT"),
}));

const mockSpawnHelpers = vi.hoisted(() => ({
  spawnClaudeStream: vi.fn(),
  spawnClaude: vi.fn(),
}));

const mockResolveAgentPrompt = vi.hoisted(() => vi.fn());
const mockDynamicProviderSpawn = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  desc: vi.fn((value: unknown) => value),
  and: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain: {
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.insert.mockReturnValue({
    values: vi.fn((payload: unknown) => {
      mockDbState.insertedValues.push(payload);
      return { run: vi.fn() };
    }),
  });
  chain.update.mockReturnValue({
    set: vi.fn((payload: unknown) => {
      mockDbState.updatedValues.push(payload);
      return {
        where: vi.fn(() => ({ run: vi.fn() })),
      };
    }),
  });

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  chatMessages: {
    id: "id",
    projectId: "projectId",
    conversationId: "conversationId",
    createdAt: "createdAt",
  },
  chatAttachments: {
    id: "id",
    chatMessageId: "chatMessageId",
  },
  chatConversations: {
    id: "id",
    type: "type",
    provider: "provider",
    status: "status",
    label: "label",
  },
  projects: {
    id: "id",
  },
  documents: {
    projectId: "projectId",
  },
  settings: {
    key: "key",
  },
  epics: {
    projectId: "projectId",
    title: "title",
    description: "description",
    position: "position",
  },
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "id-123"),
}));

vi.mock("@/lib/claude/prompt-builder", () => ({
  buildChatPrompt: mockPromptBuilder.buildChatPrompt,
  buildEpicRefinementPrompt: mockPromptBuilder.buildEpicRefinementPrompt,
  buildTitleGenerationPrompt: mockPromptBuilder.buildTitleGenerationPrompt,
}));

vi.mock("@/lib/claude/spawn", () => ({
  spawnClaudeStream: mockSpawnHelpers.spawnClaudeStream,
  spawnClaude: mockSpawnHelpers.spawnClaude,
}));

vi.mock("@/lib/providers", () => ({
  getProvider: vi.fn(() => ({
    spawn: mockDynamicProviderSpawn.mockImplementation(() => ({
      promise: Promise.resolve({ success: true, result: "Codex response" }),
      kill: vi.fn(),
    })),
  })),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: mockResolveAgentPrompt,
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("POST /api/projects/[projectId]/chat/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamicProviderSpawn.mockReset();
    mockDynamicProviderSpawn.mockReturnValue({
      promise: Promise.resolve({ success: true, result: "Codex response" }),
      kill: vi.fn(),
    });
    mockDbState.getQueue = [];
    mockDbState.allQueue = [];
    mockDbState.insertedValues = [];
    mockDbState.updatedValues = [];

    mockPromptBuilder.buildChatPrompt.mockReturnValue("CHAT_PROMPT");
    mockPromptBuilder.buildEpicRefinementPrompt.mockReturnValue("EPIC_PROMPT");
    mockPromptBuilder.buildTitleGenerationPrompt.mockReturnValue("TITLE_PROMPT");

    mockResolveAgentPrompt.mockResolvedValue("Chat system prompt");

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
  });

  it("enriches Claude prompt with mentioned text and image document context", async () => {
    mockDbState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "brainstorm", provider: "claude-code", label: "Brainstorm" },
      { id: "conv1", type: "brainstorm", provider: "claude-code", label: "Brainstorm" },
    ];

    mockDbState.allQueue = [
      [
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
      ],
      [{ name: "README.md", contentMd: "Project docs" }],
      [{ role: "user", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" }],
      [
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
      ],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockRequest({
        content: "Please use @spec.md and @diagram.png",
        conversationId: "conv1",
      }),
      { params: Promise.resolve({ projectId: "proj1" }) },
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

  it("enriches Gemini prompt with mentioned text and image document context", async () => {
    mockDbState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv2", type: "brainstorm", provider: "gemini-cli", label: "Brainstorm" },
      { id: "conv2", type: "brainstorm", provider: "gemini-cli", label: "Brainstorm" },
    ];

    mockDbState.allQueue = [
      [
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
      ],
      [{ name: "README.md", contentMd: "Project docs" }],
      [{ role: "user", content: "Previous message", createdAt: "2026-01-01T10:00:00.000Z" }],
      [
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
      ],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockRequest({
        content: "Please use @spec.md and @diagram.png",
        conversationId: "conv2",
      }),
      { params: Promise.resolve({ projectId: "proj1" }) },
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
    mockDbState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "epic_creation", provider: "claude-code", label: "New Epic" },
      { key: "global_prompt", value: JSON.stringify("Global prompt") },
    ];

    mockDbState.allQueue = [
      [{ name: "README.md", contentMd: "Project docs" }],
      [
        { role: "user", content: "Need auth flow", createdAt: "2026-01-01T10:00:00.000Z" },
      ],
      [
        { title: "User Management", description: "Manage users" },
        { title: "Audit Logs", description: null },
      ],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockRequest({ content: "Let's define the epic", conversationId: "conv1" }),
      { params: Promise.resolve({ projectId: "proj1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockPromptBuilder.buildEpicRefinementPrompt).toHaveBeenCalledTimes(1);
    expect(mockPromptBuilder.buildChatPrompt).not.toHaveBeenCalled();
    expect(mockPromptBuilder.buildEpicRefinementPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Arij" }),
      [{ name: "README.md", contentMd: "Project docs" }],
      expect.any(Array),
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

  it("uses brainstorm chat prompt for non-epic conversations", async () => {
    mockDbState.getQueue = [
      { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
      { id: "conv1", type: "brainstorm", provider: "claude-code", label: "Brainstorm" },
    ];

    mockDbState.allQueue = [
      [{ name: "README.md", contentMd: "Project docs" }],
      [{ role: "user", content: "How should architecture look?", createdAt: "2026-01-01T10:00:00.000Z" }],
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
    const response = await POST(
      mockRequest({ content: "Any ideas?", conversationId: "conv1" }),
      { params: Promise.resolve({ projectId: "proj1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveAgentPrompt).toHaveBeenCalledWith("chat", "proj1");
    expect(mockPromptBuilder.buildChatPrompt).toHaveBeenCalledTimes(1);
    expect(mockPromptBuilder.buildEpicRefinementPrompt).not.toHaveBeenCalled();
    expect(mockSpawnHelpers.spawnClaudeStream).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "CHAT_PROMPT" }),
    );
  });
});
