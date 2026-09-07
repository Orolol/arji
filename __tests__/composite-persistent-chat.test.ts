/** Real PATCH/stream handlers, resolver and migrated SQLite; process runners are stubs. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  return { ...createTestDb(), ensureDbReady: vi.fn() };
});
vi.mock("@/lib/providers", () => ({ getProvider: vi.fn() }));
vi.mock("@/lib/claude/spawn", () => ({ spawnClaude: vi.fn(), spawnClaudeStream: vi.fn() }));
vi.mock("@/lib/chat/cli-tool-channel", () => ({ createChatCliToolChannel: vi.fn(() => null) }));
vi.mock("@/lib/chat/persistent-runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat/persistent-runner")>(),
  getPersistentChatSessionState: vi.fn(() => "warm"),
  restartPersistentChatSession: vi.fn(),
  runPersistentChatTurn: vi.fn(),
}));

import { sqlite } from "@/lib/db";
import { getProvider } from "@/lib/providers";
import { spawnClaudeStream } from "@/lib/claude/spawn";
import { runPersistentChatTurn } from "@/lib/chat/persistent-runner";
import { PATCH } from "@/app/api/projects/[projectId]/conversations/[conversationId]/route";
import { POST } from "@/app/api/projects/[projectId]/chat/stream/route";

const context = { params: Promise.resolve({ projectId: "p", conversationId: "chat" }) };
const spawn = vi.fn();

async function selectAgent(id: string) {
  const response = await PATCH(new NextRequest("http://localhost/api/projects/p/conversations/chat", {
    method: "PATCH", body: JSON.stringify({ namedAgentId: id }),
  }), context);
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

async function sendTurn() {
  const response = await POST(new NextRequest("http://localhost/api/projects/p/chat/stream", {
    method: "POST", body: JSON.stringify({ content: "Hello", conversationId: "chat" }),
  }), context);
  expect(response.status).toBe(200);
  await response.text(); // Drain SSE so terminal persistence and cleanup have finished.
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite.exec(`
    DELETE FROM projects; DELETE FROM agent_provider_defaults;
    DELETE FROM composite_agent_members; DELETE FROM named_agents; DELETE FROM settings;
    INSERT INTO projects(id,name,git_repo_path) VALUES('p','Project','/tmp/composite-chat-repo');
    INSERT INTO named_agents(id,name,provider,model,kind) VALUES
      ('m','Member','agy','model-one','simple'),
      ('m2','Second member','codex','model-two','simple'),
      ('c','Fallback list','composite','','composite');
    INSERT INTO composite_agent_members(id,composite_id,member_id,position) VALUES
      ('cm','c','m',0), ('cm2','c','m2',1);
    INSERT INTO chat_conversations(id,project_id,provider,label)
      VALUES('chat','p','claude-code-persistent','Regression conversation');
  `);
  spawn.mockReturnValue({ promise: Promise.resolve({ success: true, result: "Member reply" }), kill: vi.fn() });
  vi.mocked(getProvider).mockReturnValue({ spawn } as unknown as ReturnType<typeof getProvider>);
  vi.mocked(spawnClaudeStream).mockImplementation(() => ({
    stream: new ReadableStream({ start(controller) { controller.close(); } }),
    kill: vi.fn(),
  } as ReturnType<typeof spawnClaudeStream>));
  vi.mocked(runPersistentChatTurn).mockReturnValue({
    wasWarm: true, kill: vi.fn(), promise: Promise.resolve(),
  } as ReturnType<typeof runPersistentChatTurn>);
});
afterAll(() => sqlite.close());

describe("named agents take precedence over a conversation's persistent mode", () => {
  it.each(["claude-code-persistent", "oh-my-pi-persistent"])(
    "dispatches the composite member after PATCH on %s", async (provider) => {
      sqlite.prepare("UPDATE chat_conversations SET provider = ?").run(provider);
      expect(await selectAgent("c")).toMatchObject({ provider, namedAgentId: "c" });
      await sendTurn();
      expect(runPersistentChatTurn).not.toHaveBeenCalled();
      expect(getProvider).toHaveBeenCalledWith("agy");
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: "model-one" }));
      expect(spawnClaudeStream).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT content FROM chat_messages WHERE role='assistant'").get())
        .toEqual({ content: "Member reply" });
    },
  );

  it("resolves the new first member after reordering without repatching the conversation", async () => {
    await selectAgent("c");
    sqlite.exec(`UPDATE composite_agent_members SET position=position+2;
      UPDATE composite_agent_members SET position=CASE member_id WHEN 'm2' THEN 0 ELSE 1 END;`);
    await sendTurn();
    expect(runPersistentChatTurn).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalledWith("codex");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: "model-two" }));
  });

  it("uses named-agent execution even when the member shares the warm provider", async () => {
    sqlite.exec(`UPDATE named_agents SET provider='claude-code', options='{"effort":"high"}' WHERE id='m'`);
    await selectAgent("c");
    await sendTurn();
    expect(runPersistentChatTurn).not.toHaveBeenCalled();
    expect(spawnClaudeStream).toHaveBeenCalledWith(expect.objectContaining({
      model: "model-one", cliOptions: { effort: "high" },
    }));
  });

  it("keeps simple-agent dispatch on that agent", async () => {
    await selectAgent("m");
    await sendTurn();
    expect(runPersistentChatTurn).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalledWith("agy");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: "model-one" }));
  });

  it("keeps persistent execution when no named agent is selected", async () => {
    await sendTurn();
    expect(runPersistentChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude-code-persistent", conversationId: "chat",
    }));
    expect(getProvider).not.toHaveBeenCalled();
    expect(spawnClaudeStream).not.toHaveBeenCalled();
  });
});
