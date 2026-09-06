import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";
import type { ResolvedChatMode } from "@/lib/chat/default-chat-mode";

const {
  runCutoverMigrationOnce,
  resolveAgent: mockResolveAgent,
  resolveDefaultChatMode: mockResolveDefaultChatMode,
  restartPersistentChatSession,
} = vi.hoisted(() => ({
  runCutoverMigrationOnce: vi.fn(),
  resolveAgent: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
  })),
  resolveDefaultChatMode: vi.fn(
    async (): Promise<ResolvedChatMode> => ({
      provider: "claude-code-persistent",
      namedAgentId: null,
      source: "persistent-cli",
    }),
  ),
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

// The chat-mode default is resolved, not restated: it probes the real PATH
// and the real settings table, so leaving it live would make these
// assertions depend on which CLIs this machine happens to have installed.
vi.mock("@/lib/chat/default-chat-mode", () => ({
  resolveDefaultChatMode: mockResolveDefaultChatMode,
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
    mockResolveDefaultChatMode.mockReset();
    mockResolveDefaultChatMode.mockResolvedValue({
      provider: "claude-code-persistent",
      namedAgentId: null,
      source: "persistent-cli",
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

  it("POST opens a conversation on the resolved default chat mode", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.getQueue.push({ id: "conv-created" });

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    await POST(
      {
        json: async () => ({ type: "chat", provider: "carrier-pigeon" }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    // The default is the chat-mode resolution, not resolveAgent(): the latter
    // returns an AgentProvider and so can never name a persistent mode.
    expect(mockResolveDefaultChatMode).toHaveBeenCalledWith("proj-1");
    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        provider: "claude-code-persistent",
        namedAgentId: null,
      })
    );
  });

  it("POST carries the fallback rung's named agent onto the conversation", async () => {
    mockResolveDefaultChatMode.mockResolvedValue({
      provider: "codex",
      namedAgentId: "agent-7",
      source: "agent-resolution",
    });
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.getQueue.push({ id: "conv-created" });

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    await POST(
      { json: async () => ({ type: "chat" }) } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({ provider: "codex", namedAgentId: "agent-7" })
    );
  });

  it("POST keeps the agent resolution when a named agent names a dead provider", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    // A legacy row whose provider was removed in the 2026-08 cleanup: the
    // stream route ignores a stored provider whenever a named agent is set,
    // so a persistent default here would be state nothing reads.
    dbMockState.getQueue.push({ id: "agent-legacy", provider: "carrier-pigeon" });
    dbMockState.getQueue.push({ id: "conv-created" });

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    await POST(
      {
        json: async () => ({ type: "chat", namedAgentId: "agent-legacy" }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    expect(mockResolveAgent).toHaveBeenCalledWith("chat", "proj-1");
    expect(mockResolveDefaultChatMode).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        provider: "claude-code",
        namedAgentId: "agent-legacy",
      })
    );
  });

  it("POST lets an explicit named agent win over the resolved default", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.getQueue.push({ id: "agent-9", provider: "codex" });
    dbMockState.getQueue.push({ id: "conv-created" });

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    const response = await POST(
      {
        json: async () => ({
          type: "chat",
          // Both keys are sent on purpose: a named agent owns its provider, so
          // the body's provider is what must lose here — not the agent. Same
          // rule the PATCH payload builder documents in
          // components/chat-page/agent-selection.ts.
          provider: "openai-compatible",
          namedAgentId: "agent-9",
        }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveDefaultChatMode).not.toHaveBeenCalled();
    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({ provider: "codex", namedAgentId: "agent-9" }),
    );
  });

  it("POST refuses an unknown namedAgentId instead of falling back to the default", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    // The named-agent lookup then finds nothing (empty queue -> null). The
    // default resolution must not rescue a request that named a row it
    // believed in: silently opening on another mode would hide the stale id.

    const { POST } = await import("@/app/api/projects/[projectId]/conversations/route");
    const response = await POST(
      {
        json: async () => ({ type: "chat", namedAgentId: "agent-missing" }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("namedAgentId not found");
    expect(mockResolveDefaultChatMode).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("GET auto-creates the first conversation on the resolved default chat mode", async () => {
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.allQueue.push([]); // no conversations yet
    dbMockState.allQueue.push([
      {
        id: "conv-created",
        projectId: "proj-1",
        type: "brainstorm",
        label: "Brainstorm",
        status: null,
        epicId: null,
        provider: "claude-code-persistent",
        namedAgentId: null,
        createdAt: "2026-02-12T12:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/conversations/route");
    await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    expect(mockResolveDefaultChatMode).toHaveBeenCalledWith("proj-1");
    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        id: "conv-created",
        label: "Brainstorm",
        provider: "claude-code-persistent",
        namedAgentId: null,
      })
    );
  });

  it("GET reports the warm-process state only for a conversation on a persistent mode", async () => {
    // Now that a fresh conversation can default to a persistent mode, the
    // state the picker draws has to survive the same GET that created it.
    dbMockState.getQueue.push({ id: "proj-1" });
    dbMockState.allQueue.push([
      {
        id: "conv-persistent",
        projectId: "proj-1",
        type: "chat",
        label: "Chat",
        status: null,
        epicId: null,
        provider: "claude-code-persistent",
        namedAgentId: null,
        createdAt: "2026-02-12T11:00:00.000Z",
      },
      {
        id: "conv-one-shot",
        projectId: "proj-1",
        type: "chat",
        label: "Chat",
        status: null,
        epicId: null,
        provider: "claude-code",
        namedAgentId: null,
        createdAt: "2026-02-12T12:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/conversations/route");
    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await response.json();

    const byId = (id: string) =>
      json.data.find((conversation: { id: string }) => conversation.id === id);
    expect(byId("conv-persistent").persistentSessionState).toBe("cold");
    // A one-shot CLI has no warm process to report — null, not "cold".
    expect(byId("conv-one-shot").persistentSessionState).toBeNull();
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

  it("PATCH clearing the named agent without a provider lands on the resolved chat default", async () => {
    // A conversation opened on the warm Claude process — the default on any
    // machine with `claude` installed — whose agent link is cleared by a body
    // that names no provider. The pill never sends this shape
    // (agentSelectionPatch carries a provider alongside `namedAgentId: null`),
    // so this is the API contract, reachable by a client only. It must
    // answer with the same resolution creation uses: resolveAgent() returns
    // an AgentProvider and can therefore never name a persistent mode, which
    // is how the warm process was silently dropped for one-shot claude-code.
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "claude-code-persistent",
      namedAgentId: "agent-3",
      cliSessionId: null,
    });
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "claude-code-persistent",
      namedAgentId: null,
      cliSessionId: null,
    });

    const { PATCH } = await import(
      "@/app/api/projects/[projectId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      { json: async () => ({ namedAgentId: null }) } as never,
      { params: Promise.resolve({ projectId: "proj-1", conversationId: "conv-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    // The persisted row first: this is the claim — the warm process survives
    // the clear rather than degrading to one-shot claude-code.
    expect(dbMockState.updateCalls).toHaveLength(1);
    expect(dbMockState.updateCalls[0]).toEqual({
      provider: "claude-code-persistent",
      namedAgentId: null,
      cliSessionId: null,
      claudeSessionId: null,
    });
    expect(mockResolveDefaultChatMode).toHaveBeenCalledWith("proj-1");
    expect(mockResolveAgent).not.toHaveBeenCalled();
    // The execution mode changed, so the warm process is restarted like any
    // other provider/agent switch on this route.
    expect(restartPersistentChatSession).toHaveBeenCalledWith("conv-1");
    expect(json.data).toMatchObject({
      provider: "claude-code-persistent",
      persistentSessionState: "cold",
    });
  });

  it("PATCH clearing the named agent carries the default's own named agent", async () => {
    // The resolution's assignment rung (and its resolveAgent fallback) can
    // name an agent — the CHAT & SPEC assignment the user wrote, or the
    // seeded catch-all. "Clear the conversation-specific agent" then means
    // "back to that one", exactly as creation writes it; hard-coding
    // `namedAgentId = null` here would leave the conversation on a bare
    // provider the resolver never chose.
    mockResolveDefaultChatMode.mockResolvedValue({
      provider: "codex",
      namedAgentId: "agent-7",
      source: "role-assignment",
    });
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "oh-my-pi",
      namedAgentId: "agent-3",
      cliSessionId: "cli-session-old",
    });
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "codex",
      namedAgentId: "agent-7",
      cliSessionId: null,
    });

    const { PATCH } = await import(
      "@/app/api/projects/[projectId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      { json: async () => ({ namedAgentId: "" }) } as never,
      { params: Promise.resolve({ projectId: "proj-1", conversationId: "conv-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.updateCalls).toContainEqual(
      expect.objectContaining({
        provider: "codex",
        namedAgentId: "agent-7",
        cliSessionId: null,
        claudeSessionId: null,
      }),
    );
  });

  it("PATCH with a provider beside a cleared agent never consults the default resolution", async () => {
    // Control, green on both sides of the fix: this is the body the pill
    // actually sends (agentSelectionPatch), and it carries its own answer.
    // Pins that the resolver is reached only by the provider-less clear, so
    // an explicit choice can never be overridden by a default.
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "claude-code-persistent",
      namedAgentId: "agent-3",
      cliSessionId: null,
    });
    dbMockState.getQueue.push({
      id: "conv-1",
      projectId: "proj-1",
      type: "chat",
      provider: "oh-my-pi-persistent",
      namedAgentId: null,
      cliSessionId: null,
    });

    const { PATCH } = await import(
      "@/app/api/projects/[projectId]/conversations/[conversationId]/route"
    );
    const response = await PATCH(
      {
        json: async () => ({ provider: "oh-my-pi-persistent", namedAgentId: null }),
      } as never,
      { params: Promise.resolve({ projectId: "proj-1", conversationId: "conv-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockResolveDefaultChatMode).not.toHaveBeenCalled();
    expect(mockResolveAgent).not.toHaveBeenCalled();
    expect(dbMockState.updateCalls).toContainEqual(
      expect.objectContaining({
        provider: "oh-my-pi-persistent",
        namedAgentId: null,
      }),
    );
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
