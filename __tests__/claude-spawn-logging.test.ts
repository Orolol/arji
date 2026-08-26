import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createStreamLog: vi.fn(),
  appendStreamEvent: vi.fn(),
  appendStderrEvent: vi.fn(),
  endStreamLog: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
  default: { spawn: mocks.spawn },
}));

vi.mock("@/lib/claude/logger", () => ({
  createStreamLog: mocks.createStreamLog,
  appendStreamEvent: mocks.appendStreamEvent,
  appendStderrEvent: mocks.appendStderrEvent,
  endStreamLog: mocks.endStreamLog,
}));

const { spawnClaude } = await import("@/lib/claude/spawn");

type Listener = (...args: unknown[]) => void;

function createFakeChild() {
  const listeners = new Map<string, Listener[]>();
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const stderrListeners: Array<(chunk: Buffer) => void> = [];

  return {
    stdout: {
      on: (event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(listener);
      },
    },
    stderr: {
      on: (event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") stderrListeners.push(listener);
      },
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    kill: vi.fn(),
    killed: false,
    emitStdout(text: string) {
      for (const listener of stdoutListeners) listener(Buffer.from(text));
    },
    emitStderr(text: string) {
      for (const listener of stderrListeners) listener(Buffer.from(text));
    },
    emitClose(code: number | null) {
      for (const listener of listeners.get("close") ?? []) listener(code);
    },
  };
}

describe("spawnClaude non-streaming logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createStreamLog.mockReturnValue({
      filePath: "/tmp/claude-log.ndjson",
      startTime: 0,
      chunkCount: 0,
    });
  });

  it("creates and closes a log when logIdentifier is provided", async () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child);

    const session = spawnClaude({
      mode: "analyze",
      prompt: "Analyze and write arji.json",
      cwd: "/tmp/repo",
      logIdentifier: "import-project-1",
    });

    expect(mocks.createStreamLog).toHaveBeenCalledWith(
      "import-project-1",
      expect.arrayContaining(["--output-format", "json"]),
      "Analyze and write arji.json"
    );

    child.emitStdout('{"result":"done"}');
    child.emitStderr("diagnostic");
    child.emitClose(0);

    await expect(session.promise).resolves.toMatchObject({ success: true });
    expect(mocks.appendStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/claude-log.ndjson" }),
      '{"result":"done"}'
    );
    expect(mocks.appendStderrEvent).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/claude-log.ndjson" }),
      "diagnostic"
    );
    expect(mocks.endStreamLog).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/claude-log.ndjson" }),
      { exitCode: 0 }
    );
  });
});
