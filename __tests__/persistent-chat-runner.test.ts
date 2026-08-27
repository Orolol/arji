import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  release: vi.fn(),
  createChannel: vi.fn(),
  writeMcpConfigFile: vi.fn(() => "/tmp/arij-persistent-mcp.json"),
  cleanupMcpConfigFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  default: { spawn: mocks.spawn },
  spawn: mocks.spawn,
}));
vi.mock("@/lib/chat/cli-tool-channel", () => ({
  createChatCliToolChannel: mocks.createChannel,
}));
vi.mock("@/lib/claude/mcp-injection", () => ({
  writeMcpConfigFile: mocks.writeMcpConfigFile,
  cleanupMcpConfigFile: mocks.cleanupMcpConfigFile,
}));

import {
  getPersistentChatSessionState,
  resetPersistentChatRunnerForTests,
  restartPersistentChatSession,
  runPersistentChatTurn,
} from "@/lib/chat/persistent-runner";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  writes: string[] = [];
  stdin = {
    writable: true,
    on: vi.fn(),
    write: vi.fn((value: string, callback?: (error?: Error | null) => void) => {
      this.writes.push(value);
      callback?.(null);
      return true;
    }),
  };
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.killed = true;
    if (signal === "SIGKILL") this.exitCode = 137;
    return true;
  });

  started(): void {
    this.emit("spawn");
  }

  event(value: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

  closed(code = 0): void {
    this.exitCode = code;
    this.emit("close", code);
  }
}

function options(
  conversationId: string,
  onChunk = vi.fn(),
  overrides: Record<string, unknown> = {},
) {
  return {
    conversationId,
    projectId: "project-1",
    provider: "claude-code-persistent" as const,
    prompt: "first prompt",
    cwd: process.cwd(),
    mode: "chat" as const,
    conversationType: "chat",
    idleTimeoutMs: 60_000,
    maxWarmConversations: 3,
    onChunk,
    ...overrides,
  };
}

async function waitForSpawn(): Promise<FakeChild> {
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  return mocks.spawn.mock.results.at(-1)!.value as FakeChild;
}

async function startAndWaitForInput(child: FakeChild, count = 1): Promise<void> {
  child.started();
  await vi.waitFor(() => expect(child.writes).toHaveLength(count));
}

function finishClaudeTurn(child: FakeChild, text: string, sessionId = "session-1"): void {
  child.event({ type: "system", subtype: "init", session_id: sessionId });
  child.event({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  });
  child.event({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
  });
}

describe("persistent chat runner — Claude Code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createChannel.mockReturnValue({
      mcp: {
        serverName: "arij",
        command: process.execPath,
        args: ["bin/arij-mcp.mjs"],
        env: {
          ARIJ_BASE_URL: "http://localhost:3000",
          ARIJ_MCP_TOKEN: "secret",
          ARIJ_MCP_TOOLSET: "chat",
        },
        allowedToolNames: ["mcp__arij__get_ticket"],
      },
      release: mocks.release,
    });
    mocks.spawn.mockImplementation(() => new FakeChild());
  });

  afterEach(() => {
    resetPersistentChatRunnerForTests();
    vi.useRealTimers();
  });

  it("spawns once, writes later turns to stdin, and streams partial events", async () => {
    const firstChunks = vi.fn();
    const firstSessionId = vi.fn();
    const first = runPersistentChatTurn({
      ...options("conversation-1", firstChunks),
      onCliSessionId: firstSessionId,
    });
    expect(first.wasWarm).toBe(false);
    const child = await waitForSpawn();
    await startAndWaitForInput(child);
    finishClaudeTurn(child, "Hello");
    await first.promise;

    const secondChunks = vi.fn();
    const second = runPersistentChatTurn({
      ...options("conversation-1", secondChunks),
      prompt: "second prompt",
    });
    expect(second.wasWarm).toBe(true);
    await vi.waitFor(() => expect(child.writes).toHaveLength(2));
    finishClaudeTurn(child, " again");
    await second.promise;

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [binary, args] = mocks.spawn.mock.calls[0] as [string, string[]];
    expect(binary).toBe("claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
      ]),
    );
    expect(JSON.parse(child.writes[0])).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "first prompt" }] },
    });
    expect(JSON.parse(child.writes[1])).toMatchObject({
      message: { content: [{ text: "second prompt" }] },
    });
    expect(firstChunks).toHaveBeenCalledWith({ type: "text", text: "Hello" });
    expect(secondChunks).toHaveBeenCalledWith({ type: "text", text: " again" });
    expect(firstSessionId).toHaveBeenCalledWith("session-1");
    expect(mocks.createChannel).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(getPersistentChatSessionState("conversation-1")).toBe("hot");
  });

  it("keeps the global registry across a module reload", async () => {
    const turn = runPersistentChatTurn(options("conversation-hmr"));
    const child = await waitForSpawn();
    await startAndWaitForInput(child);
    finishClaudeTurn(child, "ready");
    await turn.promise;

    vi.resetModules();
    const reloaded = await import("@/lib/chat/persistent-runner");
    expect(reloaded.getPersistentChatSessionState("conversation-hmr")).toBe("hot");
  });

  it("releases the process-scoped MCP token only when the process dies", async () => {
    const turn = runPersistentChatTurn(options("conversation-restart"));
    const child = await waitForSpawn();
    await startAndWaitForInput(child);
    finishClaudeTurn(child, "ready");
    await turn.promise;

    expect(restartPersistentChatSession("conversation-restart")).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.release).not.toHaveBeenCalled();
    child.closed();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(getPersistentChatSessionState("conversation-restart")).toBe("cold");
  });

  it("reaps an idle process and leaves no MCP token behind", async () => {
    vi.useFakeTimers();
    const turn = runPersistentChatTurn(
      options("conversation-idle", vi.fn(), { idleTimeoutMs: 100 }),
    );
    await Promise.resolve();
    const child = mocks.spawn.mock.results[0].value as FakeChild;
    await startAndWaitForInput(child);
    finishClaudeTurn(child, "ready");
    await turn.promise;

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.closed();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(getPersistentChatSessionState("conversation-idle")).toBe("cold");
  });

  it("evicts the least-recent idle conversation when the warm cap is reached", async () => {
    const first = runPersistentChatTurn(
      options("conversation-1", vi.fn(), { maxWarmConversations: 1 }),
    );
    const firstChild = await waitForSpawn();
    await startAndWaitForInput(firstChild);
    finishClaudeTurn(firstChild, "one");
    await first.promise;

    const second = runPersistentChatTurn(
      options("conversation-2", vi.fn(), { maxWarmConversations: 1 }),
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    const secondChild = mocks.spawn.mock.results[1].value as FakeChild;
    await startAndWaitForInput(secondChild);
    finishClaudeTurn(secondChild, "two", "session-2");
    await second.promise;

    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(getPersistentChatSessionState("conversation-1")).toBe("cold");
    expect(getPersistentChatSessionState("conversation-2")).toBe("hot");
  });

  it("respawns with --resume after a restart", async () => {
    const first = runPersistentChatTurn(
      options("conversation-resume", vi.fn(), {
        cliSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
    const firstChild = await waitForSpawn();
    await startAndWaitForInput(firstChild);
    finishClaudeTurn(firstChild, "one", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await first.promise;
    restartPersistentChatSession("conversation-resume");
    firstChild.closed();

    const second = runPersistentChatTurn(
      options("conversation-resume", vi.fn(), {
        prompt: "continue",
        cliSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        resumeSession: true,
      }),
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    const secondChild = mocks.spawn.mock.results[1].value as FakeChild;
    await startAndWaitForInput(secondChild);
    finishClaudeTurn(secondChild, "two", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await second.promise;

    const args = mocks.spawn.mock.calls[1][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "--resume",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ]),
    );
    expect(args).not.toContain("--session-id");
  });

  it("surfaces spawn errors and releases the channel", async () => {
    const turn = runPersistentChatTurn(options("conversation-error"));
    const child = await waitForSpawn();
    child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await expect(turn.promise).rejects.toThrow("Claude CLI not found");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(getPersistentChatSessionState("conversation-error")).toBe("cold");
  });
});
