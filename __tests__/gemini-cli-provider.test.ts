/**
 * Tests for GeminiCliProvider and provider factory registration.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => {
  const execSync = vi.fn();
  return {
    spawn: mockSpawn,
    execSync,
    default: { spawn: mockSpawn, execSync },
  };
});

import { GeminiCliProvider } from "@/lib/providers/gemini-cli";
import type { ProviderChunk, ProviderSpawnOptions } from "@/lib/providers/types";

type Listener = (...args: unknown[]) => void;

/** Fake child process whose stdout/stderr/exit events tests can drive. */
function createFakeChild() {
  const listeners = new Map<string, Listener[]>();
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const stderrListeners: Array<(chunk: Buffer) => void> = [];

  return {
    stdout: {
      on: (event: string, fn: (chunk: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(fn);
      },
    },
    stderr: {
      on: (event: string, fn: (chunk: Buffer) => void) => {
        if (event === "data") stderrListeners.push(fn);
      },
    },
    on: (event: string, fn: Listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
    },
    kill: vi.fn(),
    killed: false,
    emitStdout(text: string) {
      for (const fn of stdoutListeners) fn(Buffer.from(text));
    },
    emitStderr(text: string) {
      for (const fn of stderrListeners) fn(Buffer.from(text));
    },
    emitClose(code: number | null) {
      for (const fn of listeners.get("close") ?? []) fn(code);
    },
    emitError(err: Error) {
      for (const fn of listeners.get("error") ?? []) fn(err);
    },
  };
}

function baseOptions(overrides: Partial<ProviderSpawnOptions> = {}): ProviderSpawnOptions {
  return {
    sessionId: "test-123",
    prompt: "Write hello world",
    cwd: "/tmp/test",
    mode: "code",
    ...overrides,
  };
}

let fakeChild: ReturnType<typeof createFakeChild>;

beforeEach(() => {
  fakeChild = createFakeChild();
  mockSpawn.mockClear();
  mockSpawn.mockImplementation(() => fakeChild);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GeminiCliProvider", () => {
  it("has type 'gemini-cli'", () => {
    const provider = new GeminiCliProvider();
    expect(provider.type).toBe("gemini-cli");
  });

  it("spawn returns a ProviderSession with handle, kill, and promise", () => {
    const provider = new GeminiCliProvider();

    const session = provider.spawn(
      baseOptions({ model: "gemini-2.0-flash" })
    );

    expect(session.handle).toBe("gemini-test-123");
    expect(typeof session.kill).toBe("function");
    expect(session.promise).toBeInstanceOf(Promise);
  });

  it("spawn resolves with ProviderResult from Gemini CLI", async () => {
    const provider = new GeminiCliProvider();

    const session = provider.spawn(
      baseOptions({ sessionId: "test-456", prompt: "Implement feature" })
    );

    fakeChild.emitStdout(JSON.stringify({ result: "gemini output (mode=code)" }));
    fakeChild.emitClose(0);

    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toContain("gemini output");
    expect(typeof result.duration).toBe("number");
  });

  it("cancel calls kill on the session", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const provider = new GeminiCliProvider();

      const session = provider.spawn(
        baseOptions({ sessionId: "test-789", prompt: "test", cwd: "/tmp", mode: "plan" })
      );

      const result = provider.cancel(session);
      expect(result).toBe(true);
      expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes model to the gemini CLI as -m", () => {
    const provider = new GeminiCliProvider();

    provider.spawn(
      baseOptions({ sessionId: "model-test", prompt: "test", cwd: "/tmp", model: "gemini-2.5-pro" })
    );

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn.mock.calls[0][0]).toBe("gemini");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("gemini-2.5-pro");
    expect(args[args.indexOf("-p") + 1]).toBe("test");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("-y");
  });

  it("auto-approves writes in analyze mode so imports can create arji.json", () => {
    const provider = new GeminiCliProvider();

    provider.spawn(
      baseOptions({
        sessionId: "analyze-test",
        prompt: "Analyze the repository and write arji.json",
        cwd: "/tmp",
        mode: "analyze",
      })
    );

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("-y");
  });

  it("maps onChunk to raw/output/response chunks", async () => {
    const provider = new GeminiCliProvider();

    const chunks: ProviderChunk[] = [];
    const session = provider.spawn(
      baseOptions({ sessionId: "chunk-test", prompt: "test", cwd: "/tmp", onChunk: (c) => chunks.push(c) })
    );

    fakeChild.emitStdout(JSON.stringify({ result: "streamed text" }));
    fakeChild.emitClose(0);
    await session.promise;

    expect(chunks.map((c) => c.streamType)).toEqual(["raw", "output", "response"]);
    expect(chunks[0].chunkKey).toBe("stdout:1");
    expect(chunks[1]).toMatchObject({ chunkKey: "final-output", text: "streamed text" });
    expect(chunks[2]).toMatchObject({ chunkKey: "final-response", text: "streamed text" });
  });

  it("passes cliSessionId and resumeSession as --resume args", () => {
    const provider = new GeminiCliProvider();

    provider.spawn(
      baseOptions({
        sessionId: "resume-test",
        prompt: "continue",
        cwd: "/tmp",
        mode: "plan",
        cliSessionId: "gem-session-123",
        resumeSession: true,
      })
    );

    expect(mockSpawn).toHaveBeenCalledOnce();
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 2)).toEqual(["--resume", "gem-session-123"]);
  });

  it("extracts cliSessionId from output, falling back to the option", async () => {
    const provider = new GeminiCliProvider();

    const first = provider.spawn(baseOptions());
    fakeChild.emitStdout(JSON.stringify({ session_id: "gem-from-output", result: "done" }));
    fakeChild.emitClose(0);
    expect((await first.promise).cliSessionId).toBe("gem-from-output");

    fakeChild = createFakeChild();
    const second = provider.spawn(
      baseOptions({ cliSessionId: "gem-fallback", resumeSession: true })
    );
    fakeChild.emitStdout("plain text, no session id");
    fakeChild.emitClose(0);
    expect((await second.promise).cliSessionId).toBe("gem-fallback");
  });
});

describe("GeminiCliProvider error handling", () => {
  it("maps auth failures to an actionable error", async () => {
    const provider = new GeminiCliProvider();
    const session = provider.spawn(baseOptions());

    fakeChild.emitStderr("Error: user is not authenticated");
    fakeChild.emitClose(1);

    const result = await session.promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Gemini CLI is not authenticated. Run `gemini auth login` in your terminal."
    );
  });

  it("maps invalid-model failures to an actionable error", async () => {
    const provider = new GeminiCliProvider();
    const session = provider.spawn(baseOptions());

    fakeChild.emitStderr("Error: model gemini-9000 not found");
    fakeChild.emitClose(1);

    const result = await session.promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Invalid model name. Check available Gemini models with `gemini models list`."
    );
  });

  it("falls back to stderr, then to the exit-code message", async () => {
    const provider = new GeminiCliProvider();
    const first = provider.spawn(baseOptions());
    fakeChild.emitStderr("boom");
    fakeChild.emitClose(3);
    expect((await first.promise).error).toBe("boom");

    fakeChild = createFakeChild();
    const second = provider.spawn(baseOptions());
    fakeChild.emitClose(3);
    expect((await second.promise).error).toBe("Gemini CLI exited with code 3");
  });

  it("maps ENOENT to the gemini install hint", async () => {
    const provider = new GeminiCliProvider();
    const session = provider.spawn(baseOptions());

    fakeChild.emitError(new Error("spawn gemini ENOENT"));

    const result = await session.promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Gemini CLI not found. Install it with: npm i -g @google/gemini-cli"
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
