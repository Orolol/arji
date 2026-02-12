import { describe, it, expect, vi } from "vitest";

// Mock external dependencies before importing
vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: vi.fn(() => ({
    promise: Promise.resolve({
      success: true,
      result: "test output",
      duration: 1000,
    }),
    kill: vi.fn(),
  })),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: vi.fn().mockReturnValue({
      id: "thread-123",
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield {
            type: "item.completed",
            item: { type: "agent_message", text: "Codex output" },
          };
          yield { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20, cached_input_tokens: 0 } };
        })(),
      }),
    }),
  })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            key: "codex_api_key",
            value: JSON.stringify("test-api-key"),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  settings: { key: "key" },
}));

import { getProvider } from "@/lib/providers";
import { ClaudeCodeProvider } from "@/lib/providers/claude-code";
import { CodexProvider } from "@/lib/providers/codex";
import type { ProviderSpawnOptions } from "@/lib/providers/types";

const baseOptions: ProviderSpawnOptions = {
  sessionId: "test-session-1",
  prompt: "Implement a hello world function",
  cwd: "/tmp/test",
  mode: "code",
};

describe("Provider Factory", () => {
  it("returns ClaudeCodeProvider for 'claude-code'", () => {
    const provider = getProvider("claude-code");
    expect(provider.type).toBe("claude-code");
    expect(provider).toBeInstanceOf(ClaudeCodeProvider);
  });

  it("returns CodexProvider for 'codex'", () => {
    const provider = getProvider("codex");
    expect(provider.type).toBe("codex");
    expect(provider).toBeInstanceOf(CodexProvider);
  });

  it("defaults to claude-code when no type given", () => {
    const provider = getProvider();
    expect(provider.type).toBe("claude-code");
  });
});

describe("ClaudeCodeProvider", () => {
  const provider = new ClaudeCodeProvider();

  it("has type 'claude-code'", () => {
    expect(provider.type).toBe("claude-code");
  });

  it("spawn returns a ProviderSession with handle, kill, and promise", () => {
    const session = provider.spawn(baseOptions);
    expect(session.handle).toMatch(/^cc-/);
    expect(typeof session.kill).toBe("function");
    expect(session.promise).toBeInstanceOf(Promise);
  });

  it("spawn resolves with ProviderResult", async () => {
    const session = provider.spawn(baseOptions);
    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toBe("test output");
    expect(result.duration).toBe(1000);
  });

  it("cancel calls kill on the session", () => {
    const session = provider.spawn(baseOptions);
    const result = provider.cancel(session);
    expect(result).toBe(true);
  });
});

describe("CodexProvider", () => {
  const provider = new CodexProvider();

  it("has type 'codex'", () => {
    expect(provider.type).toBe("codex");
  });

  it("spawn returns a ProviderSession with handle, kill, and promise", () => {
    const session = provider.spawn(baseOptions);
    expect(session.handle).toMatch(/^codex-/);
    expect(typeof session.kill).toBe("function");
    expect(session.promise).toBeInstanceOf(Promise);
  });

  it("spawn resolves with ProviderResult from Codex SDK", async () => {
    const session = provider.spawn(baseOptions);
    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toContain("Codex output");
  });

  it("cancel calls kill on the session", () => {
    const session = provider.spawn(baseOptions);
    const result = provider.cancel(session);
    expect(result).toBe(true);
  });
});
