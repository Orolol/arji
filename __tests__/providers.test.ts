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

vi.mock("@/lib/codex/spawn", () => ({
  spawnCodex: vi.fn(() => ({
    promise: Promise.resolve({
      success: true,
      result: "Codex output",
      duration: 500,
    }),
    kill: vi.fn(),
  })),
}));

vi.mock("@/lib/gemini/spawn", () => ({
  spawnGemini: vi.fn(() => ({
    promise: Promise.resolve({
      success: true,
      result: "Gemini output",
      duration: 400,
    }),
    kill: vi.fn(),
  })),
}));

vi.mock("child_process", () => {
  const execSync = vi.fn();
  return {
    execSync,
    default: {
      execSync,
    },
  };
});

import { getProvider } from "@/lib/providers";
import { ClaudeCodeProvider } from "@/lib/providers/claude-code";
import { CodexProvider } from "@/lib/providers/codex";
import { GeminiCliProvider } from "@/lib/providers/gemini-cli";
import type { ProviderSpawnOptions } from "@/lib/providers/types";
import { spawnClaude } from "@/lib/claude/spawn";
import { spawnCodex } from "@/lib/codex/spawn";
import { spawnGemini } from "@/lib/gemini/spawn";

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

  it("returns GeminiCliProvider for 'gemini-cli'", () => {
    const provider = getProvider("gemini-cli");
    expect(provider.type).toBe("gemini-cli");
    expect(provider).toBeInstanceOf(GeminiCliProvider);
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

  it("forwards cliSessionId and resumeSession to spawnClaude", () => {
    provider.spawn({
      ...baseOptions,
      cliSessionId: "cli-cc-1",
      resumeSession: true,
    });

    expect(spawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        cliSessionId: "cli-cc-1",
        resumeSession: true,
      })
    );
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

  it("spawn resolves with ProviderResult from Codex CLI", async () => {
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

  it("does not forward resume fields to spawnCodex (exec is non-resumable)", () => {
    provider.spawn({
      ...baseOptions,
      cliSessionId: "cli-codex-1",
      resumeSession: true,
    });

    expect(spawnCodex).toHaveBeenCalledWith(
      expect.not.objectContaining({
        sessionId: expect.anything(),
        resumeSession: expect.anything(),
      })
    );
  });
});

describe("GeminiCliProvider", () => {
  const provider = new GeminiCliProvider();

  it("has type 'gemini-cli'", () => {
    expect(provider.type).toBe("gemini-cli");
  });

  it("spawn returns a ProviderSession with handle, kill, and promise", () => {
    const session = provider.spawn(baseOptions);
    expect(session.handle).toMatch(/^gemini-/);
    expect(typeof session.kill).toBe("function");
    expect(session.promise).toBeInstanceOf(Promise);
  });

  it("spawn resolves with ProviderResult from Gemini CLI", async () => {
    const session = provider.spawn(baseOptions);
    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toContain("Gemini output");
  });

  it("forwards cliSessionId and resumeSession to spawnGemini", () => {
    provider.spawn({
      ...baseOptions,
      cliSessionId: "cli-gem-1",
      resumeSession: true,
    });

    expect(spawnGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cli-gem-1",
        resumeSession: true,
      })
    );
  });
});
