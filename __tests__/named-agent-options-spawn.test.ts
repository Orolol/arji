/**
 * Named-agent CLI options at the spawn boundary.
 *
 * Two properties per provider:
 *  - with options, the flags land on argv in the CLI's own spelling;
 *  - WITHOUT options, argv is byte-identical to what it was before the
 *    registry existed. The second one is the regression test that keeps this
 *    feature non-breaking for every agent nobody has configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("child_process", () => {
  const execSync = vi.fn();
  return { spawn: mockSpawn, execSync, default: { spawn: mockSpawn, execSync } };
});

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => {
      throw new Error("ENOENT");
    }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("@/lib/claude/logger", () => ({
  createStreamLog: vi.fn(),
  appendStreamEvent: vi.fn(),
  appendStderrEvent: vi.fn(),
  endStreamLog: vi.fn(),
}));

import { CodexProvider } from "@/lib/providers/codex";
import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";
import { AgyProvider } from "@/lib/providers/agy";
import { buildClaudeArgs } from "@/lib/claude/spawn";
import type { ProviderSpawnOptions } from "@/lib/providers/types";
import type { NamedAgentCliOptions } from "@/lib/providers/options-registry";

type Listener = (...args: unknown[]) => void;

function createFakeChild() {
  const listeners = new Map<string, Listener[]>();
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    on: (event: string, fn: Listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
    },
    kill: vi.fn(),
    killed: false,
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };
}

function baseOptions(
  overrides: Partial<ProviderSpawnOptions> = {},
): ProviderSpawnOptions {
  return {
    sessionId: "test-session",
    prompt: "implement feature",
    cwd: "/tmp/test",
    mode: "code",
    ...overrides,
  };
}

/**
 * Codex names its `-o` capture file per spawn, so two otherwise identical
 * argvs differ in that one element. Normalise it before comparing.
 */
function stable(args: string[]): string[] {
  return args.map((arg) =>
    /codex-out-\d+-[a-z0-9]+\.txt$/.test(arg) ? "<codex-out-file>" : arg,
  );
}

/** argv of a spawn, with and without the given options. */
function argvPair(
  spawnOnce: (options: ProviderSpawnOptions) => void,
  cliOptions: NamedAgentCliOptions,
  overrides: Partial<ProviderSpawnOptions> = {},
): { without: string[]; with: string[] } {
  mockSpawn.mockClear();
  spawnOnce(baseOptions(overrides));
  const without = mockSpawn.mock.calls[0][1] as string[];

  mockSpawn.mockClear();
  spawnOnce(baseOptions({ ...overrides, cliOptions }));
  const withOptions = mockSpawn.mock.calls[0][1] as string[];

  return { without: stable(without), with: stable(withOptions) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawn.mockImplementation(() => createFakeChild());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claude-code argv", () => {
  const claudeOptions = {
    mode: "code" as const,
    prompt: "implement feature",
    cwd: "/tmp/test",
  };

  it("is unchanged when the agent has no options", () => {
    const before = buildClaudeArgs(claudeOptions, "json");
    const after = buildClaudeArgs({ ...claudeOptions, cliOptions: {} }, "json");
    expect(after).toEqual(before);
    expect(after).not.toContain("--effort");
  });

  it("appends --effort when the agent sets it", () => {
    const args = buildClaudeArgs(
      { ...claudeOptions, cliOptions: { effort: "xhigh" } },
      "json",
    );
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("replaces the derived --permission-mode rather than adding a second", () => {
    const args = buildClaudeArgs(
      { ...claudeOptions, cliOptions: { permission_mode: "acceptEdits" } },
      "json",
    );
    expect(args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("keeps a review session read-only whatever the agent asks for", () => {
    const args = buildClaudeArgs(
      {
        ...claudeOptions,
        mode: "plan",
        cliOptions: { permission_mode: "bypassPermissions" },
      },
      "json",
    );
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("bypassPermissions");
  });
});

describe("codex argv", () => {
  const spawnOnce = (options: ProviderSpawnOptions) =>
    new CodexProvider().spawn(options);

  it("is unchanged when the agent has no options", () => {
    const { without, with: withEmpty } = argvPair(spawnOnce, {});
    expect(withEmpty).toEqual(without);
  });

  it("adds the reasoning-effort config override and the profile", () => {
    const { without, with: withOptions } = argvPair(spawnOnce, {
      reasoning_effort: "high",
      profile: "fast",
    });
    expect(withOptions).toContain("model_reasoning_effort=high");
    expect(withOptions[withOptions.indexOf("-p") + 1]).toBe("fast");
    // The prompt stays the last positional argument.
    expect(withOptions[withOptions.length - 1]).toBe("implement feature");
    expect(without).not.toContain("model_reasoning_effort=high");
  });

  it("drops --profile on the resume subcommand but keeps -c", () => {
    const { with: withOptions } = argvPair(
      spawnOnce,
      { reasoning_effort: "low", profile: "fast" },
      { cliSessionId: "cli-abc", resumeSession: true },
    );
    expect(withOptions.slice(0, 3)).toEqual(["exec", "resume", "cli-abc"]);
    expect(withOptions).toContain("model_reasoning_effort=low");
    expect(withOptions).not.toContain("-p");
    expect(withOptions).not.toContain("fast");
  });
});

describe("oh-my-pi argv", () => {
  const spawnOnce = (options: ProviderSpawnOptions) =>
    new OhMyPiProvider().spawn(options);

  it("is unchanged when the agent has no options", () => {
    const { without, with: withEmpty } = argvPair(spawnOnce, {});
    expect(withEmpty).toEqual(without);
  });

  it("adds --thinking, --max-time and --advisor", () => {
    const { with: withOptions } = argvPair(spawnOnce, {
      thinking: "high",
      max_time: 600,
      advisor: true,
    });
    expect(withOptions[withOptions.indexOf("--thinking") + 1]).toBe("high");
    expect(withOptions[withOptions.indexOf("--max-time") + 1]).toBe("600");
    expect(withOptions).toContain("--advisor");
    // -p and the prompt stay at the end: omp reads the prompt positionally.
    expect(withOptions[withOptions.length - 2]).toBe("-p");
  });

  it("does not carry another CLI's options onto argv", () => {
    // A stale codex key must never reach omp, which fails fatally on unknown
    // flags. The registry filters by provider, so the key is simply ignored.
    const { without, with: withForeign } = argvPair(spawnOnce, {
      reasoning_effort: "high",
    });
    expect(withForeign).toEqual(without);
  });
});

describe("agy argv", () => {
  const spawnOnce = (options: ProviderSpawnOptions) =>
    new AgyProvider().spawn(options);

  it("is unchanged when the agent has no options", () => {
    const { without, with: withEmpty } = argvPair(spawnOnce, {});
    expect(withEmpty).toEqual(without);
  });

  it("adds --effort and --sandbox", () => {
    const { with: withOptions } = argvPair(spawnOnce, {
      effort: "high",
      sandbox: true,
    });
    expect(withOptions[withOptions.indexOf("--effort") + 1]).toBe("high");
    expect(withOptions).toContain("--sandbox");
    expect(withOptions[withOptions.length - 2]).toBe("-p");
  });
});

describe("command display", () => {
  it("shows the options and still redacts the prompt", () => {
    const session = new OhMyPiProvider().spawn(
      baseOptions({ cliOptions: { thinking: "max" } }),
    );
    expect(session.command).toContain("--thinking max");
    expect(session.command).toContain("<prompt>");
    expect(session.command).not.toContain("implement feature");
  });
});
