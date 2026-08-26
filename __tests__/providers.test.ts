import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external dependencies before importing
vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: vi.fn(() => ({
    promise: Promise.resolve({
      success: true,
      result: "test output",
      duration: 1000,
      endedWithQuestion: false,
    }),
    kill: vi.fn(),
  })),
}));

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => {
  const execSync = vi.fn();
  return {
    spawn: mockSpawn,
    execSync,
    default: {
      spawn: mockSpawn,
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

const baseOptions: ProviderSpawnOptions = {
  sessionId: "test-session-1",
  prompt: "Implement a hello world function",
  cwd: "/tmp/test",
  mode: "code",
};

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
  };
}

let fakeChild: ReturnType<typeof createFakeChild>;

beforeEach(() => {
  fakeChild = createFakeChild();
  mockSpawn.mockClear();
  mockSpawn.mockImplementation(() => fakeChild);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(result.endedWithQuestion).toBe(false);
  });

  it("maps endedWithQuestion from spawnClaude", async () => {
    vi.mocked(spawnClaude).mockReturnValueOnce({
      promise: Promise.resolve({
        success: true,
        result: "Need input",
        duration: 250,
        endedWithQuestion: true,
      }),
      kill: vi.fn(),
    });

    const session = provider.spawn(baseOptions);
    const result = await session.promise;
    expect(result.endedWithQuestion).toBe(true);
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

  it("forwards logIdentifier to spawnClaude", () => {
    provider.spawn({
      ...baseOptions,
      logIdentifier: "title-project-1",
    });

    expect(spawnClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        logIdentifier: "title-project-1",
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
    fakeChild.emitStdout("Codex output");
    fakeChild.emitClose(0);

    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toContain("Codex output");
    expect(result.endedWithQuestion).toBe(false);
  });

  it("preserves endedWithQuestion from Codex output", async () => {
    const session = provider.spawn(baseOptions);
    fakeChild.emitStdout("Need user decision AskUserQuestion");
    fakeChild.emitClose(0);

    const result = await session.promise;
    expect(result.endedWithQuestion).toBe(true);
  });

  it("cancel calls kill on the session", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const session = provider.spawn(baseOptions);
      const result = provider.cancel(session);
      expect(result).toBe(true);
      expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the codex exec resume subcommand when resuming", () => {
    provider.spawn({
      ...baseOptions,
      cliSessionId: "cli-codex-1",
      resumeSession: true,
    });

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn.mock.calls[0][0]).toBe("codex");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "cli-codex-1"]);
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
    fakeChild.emitStdout(JSON.stringify({ result: "Gemini output" }));
    fakeChild.emitClose(0);

    const result = await session.promise;
    expect(result.success).toBe(true);
    expect(result.result).toContain("Gemini output");
    expect(result.endedWithQuestion).toBe(false);
  });

  it("preserves endedWithQuestion from Gemini output", async () => {
    const session = provider.spawn(baseOptions);
    fakeChild.emitStdout("Need clarification AskUserQuestion");
    fakeChild.emitClose(0);

    const result = await session.promise;
    expect(result.endedWithQuestion).toBe(true);
  });

  it("forwards cliSessionId and resumeSession as --resume args", () => {
    provider.spawn({
      ...baseOptions,
      cliSessionId: "cli-gem-1",
      resumeSession: true,
    });

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn.mock.calls[0][0]).toBe("gemini");
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 2)).toEqual(["--resume", "cli-gem-1"]);
  });
});
