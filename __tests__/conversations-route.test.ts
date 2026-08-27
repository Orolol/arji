import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

const {
  runCutoverMigrationOnce,
  resolveAgent: mockResolveAgent,
  restartPersistentChatSession,
} = vi.hoisted(() => ({
  runCutoverMigrationOnce: vi.fn(),
  resolveAgent: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
  })),
  restartPersistentChatSession: vi.fn(() => true),
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "conv-created"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgent: mockResolveAgent,
}));

vi.mock("@/lib/chat/unified-cutover-migration", () => ({
  runUnifiedChatCutoverMigrationOnce: runCutoverMigrationOnce,
}));

vi.mock("@/lib/chat/persistent-runner", () => ({
  getPersistentChatSessionState: vi.fn(() => "cold"),
  restartPersistentChatSession,
}));

describe("conversations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockResolveAgent.mockReset();
    mockResolveAgent.mockReturnValue({
      provider: "claude-code",
      namedAgentId: null,
    });
  });

  it("runs cutover migration and normalizes legacy type/status order", async () => {
    // GET first checks the project exists via .get()
    dbMockState.getQueue.push({ id: "proj-1" });
    // …then loads the project's conversations via .all()
    dbMockState.allQueue.push([
      {
        id: "conv-newer",
        projectId: "proj-1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "mystery",
        epicId: null,
        provider: "claude-code",
        createdAt: "2026-02-12T12:00:00.000Z",
      },
      {
        id: "conv-older",
        projectId: "proj-1",
        type: "epic",
        label: "Legacy Epic",
        status: "generating",
        epicId: null,
        provider: "claude-code",
        createdAt: "2026-02-12T11:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/conversations/route");

    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await response.json();

    expect(runCutoverMigrationOnce).toHaveBeenCalledWith("proj-1");
    expect(json.data).toHaveLength(2);
    expect(json.data[0]).toMatchObject({
      id: "conv-older",
      type: "epic_creation",
      status: "generating",
    });
    expect(json.data[1]).toMatchObject({
      id: "conv-newer",
      status: "active",
    });
  });

  it("POST persists the openai-compatible provider on the conversation", async () => {
    dbMockState.getQueue.push({ id: "proj-1" }); // project exists
    dbMockState.getQueue.push({ id: "conv-created" }); // created row read-back

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    const response = await POST(
      {
        json: async () => ({
          type: "chat",
          label: "Chat",
          provider: "openai-compatible",
        }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    // The fast-mode provider is a known chat provider: no fallback resolution.
    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        id: "conv-created",
        type: "chat",
        provider: "openai-compatible",
        namedAgentId: null,
      })
    );
    expect(json.data).toMatchObject({ id: "conv-created" });
  });

  it("POST persists the explicit persistent Claude chat mode", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.getQueue.push({ id: "conv-created" });

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    await POST(
      {
        json: async () => ({
          type: "chat",
          provider: "claude-code-persistent",
        }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({ provider: "claude-code-persistent" }),
    );
  });

  it("POST falls back to the configured default for unknown providers", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.getQueue.push({ id: "conv-created" });

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    await POST(
      {
        json: async () => ({ type: "chat", provider: "carrier-pigeon" }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    expect(mockResolveAgent).toHaveBeenCalledWith("chat", "proj-1");
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({ provider: "claude-code" })
    );
  });

  it("PATCH accepts the openai-compatible provider and clears named-agent linkage", async () => {
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "claude-code",
      namedAgentId: null,
      cliSessionId: null,
    });
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "openai-compatible",
      namedAgentId: null,
      cliSessionId: null,
    });

    const { PATCH } = await import(
      "@/app/api/projects/[projectId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      {
        json: async () => ({ provider: "openai-compatible" }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1", conversationId: "conv-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(dbMockState.updateCalls).toContainEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        namedAgentId: null,
        cliSessionId: null,
      })
    );
    expect(json.data).toMatchObject({ provider: "openai-compatible" });
  });

  it("PATCH ignores unknown provider values", async () => {
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "claude-code",
      namedAgentId: null,
      cliSessionId: null,
    });
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "claude-code",
      namedAgentId: null,
      cliSessionId: null,
    });

    const { PATCH } = await import(
      "@/app/api/projects/[projectId]/conversations/[conversationId]/route"
    );
    await PATCH(
      {
        json: async () => ({ provider: "carrier-pigeon" }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1", conversationId: "conv-1" }) },
    );

    expect(dbMockState.updateCalls).toHaveLength(0);
  });

  it("restart endpoint terminates the warm process without clearing durable history", async () => {
    dbMockState.getQueue.push({ id: "conv-1" });
    const { DELETE } = await import(
      "@/app/api/projects/[projectId]/conversations/[conversationId]/persistent-session/route"
    );
    const response = await DELETE({} as never, {
      params: Promise.resolve({ projectId: "proj-1", conversationId: "conv-1" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(restartPersistentChatSession).toHaveBeenCalledWith("conv-1");
    expect(json.data).toEqual({
      restarted: true,
      persistentSessionState: "cold",
    });
    expect(dbMockState.updateCalls).toHaveLength(0);
  });
});
