/**
 * Tests for GeminiCliProvider and provider factory registration.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gemini/spawn", () => ({
  spawnGemini: vi.fn(({ mode }: { mode: string }) => {
    const killFn = vi.fn();
    return {
      promise: Promise.resolve({
        success: true,
        result: `gemini output (mode=${mode})`,
        duration: 100,
      }),
      kill: killFn,
    };
  }),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

describe("GeminiCliProvider", () => {
  it("has type 'gemini-cli'", async () => {
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();
    expect(provider.type).toBe("gemini-cli");
  });

  it("spawn returns a ProviderSession with handle, kill, and promise", async () => {
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();

    const session = provider.spawn({
      sessionId: "test-123",
      prompt: "Write hello world",
      cwd: "/tmp/test",
      mode: "code",
      model: "gemini-2.0-flash",
    });

    expect(session.handle).toBe("gemini-test-123");
    expect(typeof session.kill).toBe("function");
    expect(session.promise).toBeInstanceOf(Promise);
  });

  it("spawn resolves with ProviderResult from Gemini CLI", async () => {
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();

    const session = provider.spawn({
      sessionId: "test-456",
      prompt: "Implement feature",
      cwd: "/tmp/test",
      mode: "code",
    });

    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toContain("gemini output");
    expect(result.duration).toBe(100);
  });

  it("cancel calls kill on the session", async () => {
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();

    const session = provider.spawn({
      sessionId: "test-789",
      prompt: "test",
      cwd: "/tmp",
      mode: "plan",
    });

    const result = provider.cancel(session);
    expect(result).toBe(true);
    expect(session.kill).toHaveBeenCalled();
  });

  it("passes model to spawnGemini", async () => {
    const { spawnGemini } = await import("@/lib/gemini/spawn");
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();

    provider.spawn({
      sessionId: "model-test",
      prompt: "test",
      cwd: "/tmp",
      mode: "code",
      model: "gemini-2.5-pro",
    });

    expect(spawnGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.5-pro",
        mode: "code",
        prompt: "test",
      })
    );
  });

  it("passes onChunk callbacks to spawnGemini", async () => {
    const { spawnGemini } = await import("@/lib/gemini/spawn");
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();

    const onChunk = vi.fn();
    provider.spawn({
      sessionId: "chunk-test",
      prompt: "test",
      cwd: "/tmp",
      mode: "code",
      onChunk,
    });

    expect(spawnGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        onRawChunk: expect.any(Function),
        onOutputChunk: expect.any(Function),
        onResponseChunk: expect.any(Function),
      })
    );
  });

  it("passes cliSessionId and resumeSession to spawnGemini", async () => {
    const { spawnGemini } = await import("@/lib/gemini/spawn");
    const { GeminiCliProvider } = await import("@/lib/providers/gemini-cli");
    const provider = new GeminiCliProvider();

    provider.spawn({
      sessionId: "resume-test",
      prompt: "continue",
      cwd: "/tmp",
      mode: "plan",
      cliSessionId: "gem-session-123",
      resumeSession: true,
    });

    expect(spawnGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "gem-session-123",
        resumeSession: true,
      })
    );
  });
});

describe("Provider Factory with Gemini CLI", () => {
  it("returns GeminiCliProvider for 'gemini-cli'", async () => {
    const { getProvider } = await import("@/lib/providers");
    const provider = getProvider("gemini-cli");
    expect(provider.type).toBe("gemini-cli");
  });

  it("returns ClaudeCodeProvider by default", async () => {
    const { getProvider } = await import("@/lib/providers");
    const provider = getProvider();
    expect(provider.type).toBe("claude-code");
  });

  it("all three providers are registered", async () => {
    const { getProvider } = await import("@/lib/providers");
    expect(getProvider("claude-code").type).toBe("claude-code");
    expect(getProvider("codex").type).toBe("codex");
    expect(getProvider("gemini-cli").type).toBe("gemini-cli");
  });
});
