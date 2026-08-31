/**
 * Wiring tests for the per-turn CLI MCP tool channel in the chat stream
 * route: every CLI branch (claude-code fresh stream, claude-code resume,
 * dynamic provider) must pass `channel.mcp` to its spawn and call
 * `channel.release()` on completion — success, provider failure, and the
 * expired-resume retry (both attempts share the turn's token).
 *
 * The channel factory itself is unit-tested in cli-tool-channel.test.ts;
 * here it is mocked so the route's contract with it is the only thing under
 * test (and the legacy streaming assertions stay in chat-stream-route.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";
import type { McpSpawnConfig } from "@/lib/providers/types";

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
const mockCreateChatCliToolChannel = vi.hoisted(() => vi.fn());

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
  getProvider: mockGetProvider,
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: mockResolveAgentPrompt,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: mockResolveAgentByNamedId,
}));

vi.mock("@/lib/chat/cli-tool-channel", () => ({
  createChatCliToolChannel: mockCreateChatCliToolChannel,
}));

const FAKE_MCP: McpSpawnConfig = {
  servers: [
    {
      name: "arij",
      command: "/usr/bin/node",
      args: ["/app/bin/arij-mcp.mjs"],
      env: {
        ARIJ_BASE_URL: "http://localhost:3000",
        ARIJ_MCP_TOKEN: "arij-mcp-test-token",
        ARIJ_MCP_TOOLSET: "chat",
      },
    },
  ],
  allowedToolNames: ["mcp__arij__list_tickets"],
};

function fakeChannel() {
  return { mcp: FAKE_MCP, release: vi.fn() };
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader();
  while (!(await reader.read()).done) {
    // consume the SSE stream so the start() callback runs to completion
  }
}

function seedFreshChat() {
  dbMockState.getQueue = [
    { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
  ];
  dbMockState.allQueue = [[]];
}

function seedResumeConversation(provider: string) {
  dbMockState.getQueue = [
    { id: "proj1", name: "Arij", description: "desc", spec: "spec", gitRepoPath: null },
    {
      id: "conv1",
      type: "chat",
      provider,
      namedAgentId: null,
      cliSessionId: "cli-session-1",
      label: "Chat",
    },
  ];
  dbMockState.allQueue = [
    [{ role: "user", content: "Previous", createdAt: "2026-01-01T10:00:00.000Z" }],
  ];
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/projects/[projectId]/chat/stream/route");
  return POST(mockJsonRequest(body), mockRouteContext({ projectId: "proj1" }));
}

describe("chat stream route — CLI MCP tool channel wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();

    mockResolveAgentPrompt.mockResolvedValue("Chat system prompt");
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: null,
    });
    mockCreateChatCliToolChannel.mockImplementation(() => fakeChannel());

    mockSpawnHelpers.spawnClaude.mockReturnValue({
      promise: Promise.resolve({ success: true, result: "Answer" }),
      kill: vi.fn(),
    });
    mockSpawnHelpers.spawnClaudeStream.mockReturnValue({
      stream: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      kill: vi.fn(),
    });
    mockGetProvider.mockReturnValue({ spawn: mockDynamicProviderSpawn });
    mockDynamicProviderSpawn.mockReturnValue({
      promise: Promise.resolve({ success: true, result: "Codex answer" }),
      kill: vi.fn(),
    });
  });

  it("fresh claude-code stream: channel created from the resolved context, mcp passed, released at end", async () => {
    seedFreshChat();
    const channel = fakeChannel();
    mockCreateChatCliToolChannel.mockReturnValue(channel);

    const response = await post({ content: "Hello" });
    expect(response.status).toBe(200);
    await drain(response);

    expect(mockCreateChatCliToolChannel).toHaveBeenCalledWith({
      projectId: "proj1",
      provider: "claude-code",
      conversationType: null,
    });
    expect(mockSpawnHelpers.spawnClaudeStream).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "CHAT_PROMPT", mcp: FAKE_MCP }),
    );
    expect(channel.release).toHaveBeenCalled();
  });

  it("claude-code resume: both the resume attempt and the expired-session retry carry the mcp config", async () => {
    seedResumeConversation("claude-code");
    const channel = fakeChannel();
    mockCreateChatCliToolChannel.mockReturnValue(channel);

    mockSpawnHelpers.spawnClaude
      .mockReturnValueOnce({
        promise: Promise.resolve({ success: false, error: "session not found" }),
        kill: vi.fn(),
      })
      .mockReturnValueOnce({
        promise: Promise.resolve({ success: true, result: "Fresh answer" }),
        kill: vi.fn(),
      });

    const response = await post({ content: "Continue", conversationId: "conv1" });
    expect(response.status).toBe(200);
    await drain(response);

    expect(mockSpawnHelpers.spawnClaude.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ resumeSession: true, mcp: FAKE_MCP }),
    );
    expect(mockSpawnHelpers.spawnClaude.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ prompt: "CHAT_PROMPT", mcp: FAKE_MCP }),
    );
    expect(channel.release).toHaveBeenCalledTimes(1);
  });

  it("dynamic provider (codex): spawn gets the mcp config and the channel is released", async () => {
    seedResumeConversation("codex");
    const channel = fakeChannel();
    mockCreateChatCliToolChannel.mockReturnValue(channel);

    const response = await post({ content: "Hello", conversationId: "conv1" });
    expect(response.status).toBe(200);
    await drain(response);

    expect(mockCreateChatCliToolChannel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", conversationType: "chat" }),
    );
    expect(mockDynamicProviderSpawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ mcp: FAKE_MCP }),
    );
    expect(channel.release).toHaveBeenCalled();
  });

  it("releases the token even when the provider promise rejects", async () => {
    seedResumeConversation("codex");
    const channel = fakeChannel();
    mockCreateChatCliToolChannel.mockReturnValue(channel);
    mockDynamicProviderSpawn.mockReturnValue({
      promise: Promise.reject(new Error("spawn blew up")),
      kill: vi.fn(),
    });

    const response = await post({ content: "Hello", conversationId: "conv1" });
    expect(response.status).toBe(200);
    await drain(response);

    expect(channel.release).toHaveBeenCalled();
  });

  it("carries the resolved agent's CLI options into every chat spawn", async () => {
    // A chat turn has no agent_sessions row, so it never passes through
    // processManager.start(): the options have to ride the resolved agent.
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "claude-code",
      model: undefined,
      namedAgentId: "na-1",
      cliOptions: { effort: "high" },
    });
    seedFreshChat();
    mockCreateChatCliToolChannel.mockReturnValue(fakeChannel());

    await drain(await post({ content: "Hello" }));

    expect(mockSpawnHelpers.spawnClaudeStream).toHaveBeenCalledWith(
      expect.objectContaining({ cliOptions: { effort: "high" } }),
    );
  });

  it("carries them into a dynamic provider spawn too", async () => {
    mockResolveAgentByNamedId.mockReturnValue({
      provider: "codex",
      model: undefined,
      namedAgentId: "na-2",
      cliOptions: { reasoning_effort: "xhigh" },
    });
    seedResumeConversation("codex");
    mockCreateChatCliToolChannel.mockReturnValue(fakeChannel());

    await drain(await post({ content: "Hello", conversationId: "conv1" }));

    expect(mockDynamicProviderSpawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ cliOptions: { reasoning_effort: "xhigh" } }),
    );
  });

  it("spawns plain (no mcp) when the channel is unavailable", async () => {
    seedFreshChat();
    mockCreateChatCliToolChannel.mockReturnValue(null);

    const response = await post({ content: "Hello" });
    expect(response.status).toBe(200);
    await drain(response);

    const options = mockSpawnHelpers.spawnClaudeStream.mock.calls[0]?.[0] as {
      mcp?: McpSpawnConfig;
    };
    expect(options.mcp).toBeUndefined();
  });
});
