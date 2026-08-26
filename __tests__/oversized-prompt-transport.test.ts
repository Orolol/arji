/**
 * Prompts too large for argv.
 *
 * Linux caps a single argv element at 128 KiB. Arij build prompts carry the
 * project spec plus the entire comment history, so a ticket that collected a
 * few pasted code reviews crosses that cap and every provider that passes the
 * prompt as one argument dies with a bare `spawn E2BIG` before the CLI even
 * starts. These tests pin the escape hatch each CLI offers, and the readable
 * failure for the providers that have none.
 */
import { existsSync, readFileSync } from "fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("child_process", () => {
  const execSync = vi.fn();
  return {
    spawn: mockSpawn,
    execSync,
    default: { spawn: mockSpawn, execSync },
  };
});

import {
  ARGV_PROMPT_LIMIT_BYTES,
  MAX_ARG_STRLEN_BYTES,
  findOversizedArg,
  promptExceedsArgv,
} from "@/lib/providers/prompt-transport";
import { PiProvider, PI_PROMPT_FILE_FRAMING } from "@/lib/providers/pi";
import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";
import { CodexProvider } from "@/lib/providers/codex";
import { BaseCliProvider } from "@/lib/providers/base-provider";
import { buildClaudeArgs } from "@/lib/claude/spawn";
import type { ProviderSpawnOptions } from "@/lib/providers/types";

/** Concrete stand-in for the abstract pi-family base (see pi-providers.test.ts). */
class TestPiProvider extends PiProvider {
  readonly type = "oh-my-pi" as const;
}

/**
 * Minimal provider with NO out-of-band prompt transport, to exercise the
 * base-class E2BIG guard now that every registered provider has one.
 */
class ArgvOnlyProvider extends BaseCliProvider {
  readonly type = "oh-my-pi" as const;
  get binaryName(): string {
    return "argv-only";
  }
  buildArgs(options: ProviderSpawnOptions): string[] {
    return ["-p", options.prompt];
  }
  extractResult(stdout: string): string {
    return stdout;
  }
}

type Listener = (...args: unknown[]) => void;

/** Fake child whose stdin writes the test can inspect. */
function createFakeChild() {
  const listeners = new Map<string, Listener[]>();
  const stdinWrites: string[] = [];

  return {
    stdinWrites,
    stdin: {
      on: () => {},
      end: (chunk: string) => stdinWrites.push(chunk),
    },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, fn: Listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
    },
    kill: vi.fn(),
    killed: false,
    emitClose(code: number | null) {
      for (const fn of listeners.get("close") ?? []) fn(code);
    },
  };
}

/** A prompt past the argv cap, shaped like a real build prompt. */
const HUGE_PROMPT = `# Project: Arij\n\n${"Comment history line.\n".repeat(8000)}`;
const SMALL_PROMPT = "Implement a hello world function";

function options(prompt: string): ProviderSpawnOptions {
  return { sessionId: "test-123", prompt, cwd: "/tmp/test", mode: "code" };
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

describe("prompt-transport", () => {
  it("keeps the switch-over point under the kernel cap", () => {
    expect(ARGV_PROMPT_LIMIT_BYTES).toBeLessThan(MAX_ARG_STRLEN_BYTES);
  });

  it("measures the prompt in bytes, not characters", () => {
    const multibyte = "é".repeat(ARGV_PROMPT_LIMIT_BYTES - 10);
    expect(multibyte.length).toBeLessThan(ARGV_PROMPT_LIMIT_BYTES);
    expect(promptExceedsArgv(multibyte)).toBe(true);
  });

  it("leaves a normal prompt on argv", () => {
    expect(promptExceedsArgv(SMALL_PROMPT)).toBe(false);
  });

  it("flags only the argument that would trip execve", () => {
    expect(findOversizedArg(["-p", "x".repeat(MAX_ARG_STRLEN_BYTES)])).toHaveLength(
      MAX_ARG_STRLEN_BYTES,
    );
    expect(
      findOversizedArg(["-p", "x".repeat(MAX_ARG_STRLEN_BYTES - 1)]),
    ).toBeUndefined();
  });
});

describe("Pi family — oversized prompts go through a @file argument", () => {
  for (const [label, provider] of [
    ["pi-family base", new TestPiProvider()],
    ["omp", new OhMyPiProvider()],
  ] as const) {
    it(`${label}: passes @<file> plus the framing message, and no argument is oversized`, async () => {
      const session = provider.spawn(options(HUGE_PROMPT));
      const args = mockSpawn.mock.calls[0][1] as string[];

      const promptArg = args[args.indexOf("-p") + 1];
      expect(promptArg.startsWith("@")).toBe(true);
      expect(args[args.indexOf("-p") + 2]).toBe(PI_PROMPT_FILE_FRAMING);
      expect(findOversizedArg(args)).toBeUndefined();

      const filePath = promptArg.slice(1);
      expect(readFileSync(filePath, "utf-8")).toBe(HUGE_PROMPT);

      // The prompt file is per-spawn state: it must not outlive the process.
      fakeChild.emitClose(0);
      await session.promise;
      expect(existsSync(filePath)).toBe(false);
    });
  }

  it("leaves a normal prompt on argv", () => {
    new TestPiProvider().spawn(options(SMALL_PROMPT));
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-p") + 1]).toBe(SMALL_PROMPT);
  });
});

describe("Codex — oversized prompts are read from stdin", () => {
  it("passes `-` as the prompt and pipes the prompt in", () => {
    new CodexProvider().spawn(options(HUGE_PROMPT));
    const [, args, spawnOptions] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { stdio: string[] },
    ];

    expect(args[args.length - 1]).toBe("-");
    expect(findOversizedArg(args)).toBeUndefined();
    expect(spawnOptions.stdio[0]).toBe("pipe");
    expect(fakeChild.stdinWrites).toEqual([HUGE_PROMPT]);
  });

  it("keeps a normal prompt positional, with stdin closed", () => {
    new CodexProvider().spawn(options(SMALL_PROMPT));
    const [, args, spawnOptions] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { stdio: string[] },
    ];

    expect(args[args.length - 1]).toBe(SMALL_PROMPT);
    expect(spawnOptions.stdio[0]).toBe("ignore");
    expect(fakeChild.stdinWrites).toEqual([]);
  });
});

describe("Claude Code — oversized prompts are read from stdin", () => {
  it("drops -p so the CLI falls back to stdin", () => {
    const args = buildClaudeArgs(
      { mode: "code", prompt: HUGE_PROMPT },
      "json",
    );
    expect(args).toContain("--print");
    expect(args).not.toContain("-p");
    expect(findOversizedArg(args)).toBeUndefined();
  });

  it("keeps -p <prompt> for a normal prompt", () => {
    const args = buildClaudeArgs(
      { mode: "code", prompt: SMALL_PROMPT },
      "json",
    );
    expect(args[args.indexOf("-p") + 1]).toBe(SMALL_PROMPT);
  });
});

describe("Providers without an out-of-band channel", () => {
  it("fails with a readable message instead of a bare spawn E2BIG", async () => {
    const session = new ArgvOnlyProvider().spawn(options(HUGE_PROMPT));
    const result = await session.promise;

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Prompt too large");
    expect(result.error).toContain("E2BIG");
  });
});
