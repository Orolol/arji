/**
 * Regression: a tool-restricted omp spawn must refuse an omp that is not
 * measured to honour `--tools`.
 *
 * Arij used to back the read-only allowlist with a `--config` overlay that
 * turned omp's xd:// device system off, because omp 17.2.1 force-mounted the
 * real `write` tool despite `--tools read,grep,glob`. That overlay is gone —
 * it displaced the user's whole `~/.omp/agent/config.yml` (see
 * `omp-user-config-not-displaced.test.ts`) and measures as a no-op on 18.0.6,
 * where the allowlist is honoured exactly.
 *
 * Removing it made the allowlist the WHOLE isolation mechanism, and Arij
 * spawns whatever `omp` sits on PATH. On 17.2.1 — or on 18.0.5, which was
 * never probed for this property — a plan/review/chat session would silently
 * regain a working `write` tool against the worktree. So every restricted
 * spawn now checks the installed version first, on BOTH paths: the one-shot
 * provider and the persistent RPC chat runner.
 *
 * The gate fails closed (an unreadable version is not evidence of safety) with
 * one exception: a MISSING binary is left to the spawn's own "CLI not found"
 * error, because nothing runs and there is no isolation to protect.
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  createChannel: vi.fn(),
  writeMcpConfigFile: vi.fn(() => "/tmp/arij-persistent-mcp.json"),
  cleanupMcpConfigFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  default: {
    spawn: mocks.spawn,
    execSync: mocks.execSync,
    execFileSync: mocks.execFileSync,
  },
  spawn: mocks.spawn,
  execSync: mocks.execSync,
  execFileSync: mocks.execFileSync,
}));
vi.mock("@/lib/chat/cli-tool-channel", () => ({
  createChatCliToolChannel: mocks.createChannel,
}));
vi.mock("@/lib/claude/mcp-injection", () => ({
  writeMcpConfigFile: mocks.writeMcpConfigFile,
  cleanupMcpConfigFile: mocks.cleanupMcpConfigFile,
}));
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import {
  resetPersistentChatRunnerForTests,
  runPersistentChatTurn,
} from "@/lib/chat/persistent-runner";
import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";
import {
  OMP_MIN_ALLOWLIST_VERSION,
  ompAllowlistIsEnforced,
  ompRestrictedToolsBlockReason,
  parseOmpVersion,
  probeOmpVersion,
  resetOmpVersionProbeForTests,
} from "@/lib/providers/omp-version";
import type { ProviderSpawnOptions } from "@/lib/providers/types";

/** The version the ticket's own measurements were taken against. */
const SAFE_VERSION = "18.0.6";
/** Measured force-mounting `write` through the read-only allowlist. */
const LEAKY_VERSION = "17.2.1";
/** Between the two, never probed for this property — unproven, so refused. */
const UNPROBED_VERSION = "18.0.5";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  stdin = {
    writable: true,
    on: vi.fn(),
    write: vi.fn((_value: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      return true;
    }),
  };
  kill = vi.fn(() => true);
}

/** `omp --version` answers with this release. */
function installedOmp(version: string): void {
  mocks.execFileSync.mockReturnValue(`omp/${version}\n`);
}

/** `omp` is not on PATH at all. */
function ompNotInstalled(): void {
  mocks.execFileSync.mockImplementation(() => {
    const error: NodeJS.ErrnoException = new Error("spawnSync omp ENOENT");
    error.code = "ENOENT";
    throw error;
  });
}

function spawnOptions(
  overrides: Partial<ProviderSpawnOptions> = {},
): ProviderSpawnOptions {
  return {
    sessionId: "omp-version-gate",
    prompt: "Review the diff",
    cwd: "/tmp/test",
    mode: "plan",
    ...overrides,
  };
}

function persistentTurn() {
  return runPersistentChatTurn({
    conversationId: "omp-version-gate",
    projectId: "project-1",
    provider: "oh-my-pi-persistent",
    prompt: "hello",
    cwd: process.cwd(),
    mode: "chat",
    conversationType: "chat",
    idleTimeoutMs: 60_000,
    maxWarmConversations: 3,
    onChunk: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOmpVersionProbeForTests();
  mocks.createChannel.mockReturnValue(null);
  mocks.spawn.mockImplementation(() => new FakeChild());
  installedOmp(SAFE_VERSION);
});

afterEach(() => {
  resetPersistentChatRunnerForTests();
});

describe("omp version comparison", () => {
  it.each([
    ["omp/18.0.6\n", "18.0.6"],
    ["omp v18.0.6", "18.0.6"],
    ["18.0.6-rc.1", "18.0.6-rc.1"],
    ["", null],
    ["omp/unknown", null],
  ])("parses %j as %j", (raw, expected) => {
    expect(parseOmpVersion(raw)).toBe(expected);
  });

  it.each([
    [SAFE_VERSION, true],
    ["18.0.7", true],
    ["18.1.0", true],
    ["19.0.0", true],
    // Both sides of the floor, so the boundary cannot silently move.
    [UNPROBED_VERSION, false],
    [LEAKY_VERSION, false],
    ["17.9.9", false],
    // A prerelease of the floor predates the floor itself.
    ["18.0.6-rc.1", false],
    ["not-a-version", false],
  ])("treats %s as enforced=%s", (version, enforced) => {
    expect(ompAllowlistIsEnforced(version)).toBe(enforced);
  });

  it("names the measured floor so the gate and the docs cannot drift", () => {
    expect(OMP_MIN_ALLOWLIST_VERSION).toBe(SAFE_VERSION);
  });
});

describe("omp version probe", () => {
  it("reports a missing binary separately from an unreadable version", () => {
    ompNotInstalled();
    expect(probeOmpVersion()).toEqual({ status: "absent" });
    expect(ompRestrictedToolsBlockReason()).toBeNull();
  });

  it("refuses when the binary answers with something unparseable", () => {
    mocks.execFileSync.mockReturnValue("omp: some future banner\n");
    expect(probeOmpVersion().status).toBe("unreadable");
    expect(ompRestrictedToolsBlockReason()).toMatch(
      /Could not determine the Oh My Pi version/,
    );
  });

  it("refuses when `omp --version` itself fails", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("Command failed: omp --version");
    });
    expect(probeOmpVersion().status).toBe("unreadable");
    expect(ompRestrictedToolsBlockReason()).toContain("omp update");
  });

  it("memoises a trusted version but re-probes a refusal", () => {
    installedOmp(SAFE_VERSION);
    expect(ompRestrictedToolsBlockReason()).toBeNull();
    expect(ompRestrictedToolsBlockReason()).toBeNull();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);

    // A refusal must NOT stick: a user who reacts to the error by running
    // `omp update` gets unblocked without restarting the Arij server.
    resetOmpVersionProbeForTests();
    installedOmp(LEAKY_VERSION);
    expect(ompRestrictedToolsBlockReason()).not.toBeNull();
    installedOmp(SAFE_VERSION);
    expect(ompRestrictedToolsBlockReason()).toBeNull();
  });
});

describe("one-shot omp spawns", () => {
  const provider = new OhMyPiProvider();

  it.each(["plan", "chat", "analyze"] as const)(
    "refuses %s mode on an omp that does not enforce the allowlist",
    async (mode) => {
      installedOmp(LEAKY_VERSION);
      const session = provider.spawn(spawnOptions({ mode }));
      // The point of the gate: no agent ever gets the unenforced tool set.
      expect(mocks.spawn).not.toHaveBeenCalled();

      const result = await session.promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain(LEAKY_VERSION);
      expect(result.error).toContain(OMP_MIN_ALLOWLIST_VERSION);
      expect(result.error).toContain("omp update");
    },
  );

  it("refuses the unprobed 18.0.5 too", async () => {
    installedOmp(UNPROBED_VERSION);
    const session = provider.spawn(spawnOptions({ mode: "plan" }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect((await session.promise).success).toBe(false);
  });

  it.each(["plan", "chat", "analyze"] as const)(
    "runs %s mode on an omp that does enforce it",
    (mode) => {
      installedOmp(SAFE_VERSION);
      provider.spawn(spawnOptions({ mode }));
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
      const [binary, args] = mocks.spawn.mock.calls[0] as [string, string[]];
      expect(binary).toBe("omp");
      expect(args).toContain("--tools");
    },
  );

  it("leaves code mode alone: it restricts nothing, so it claims nothing", () => {
    installedOmp(LEAKY_VERSION);
    provider.spawn(spawnOptions({ mode: "code" }));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][1]).not.toContain("--tools");
  });

  it("lets a missing binary reach the CLI-not-found path", () => {
    ompNotInstalled();
    provider.spawn(spawnOptions({ mode: "plan" }));
    // Nothing to isolate when nothing runs — the spawn's own ENOENT message
    // is more useful than a version complaint.
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses when the version cannot be read at all", async () => {
    mocks.execFileSync.mockReturnValue("");
    const session = provider.spawn(spawnOptions({ mode: "plan" }));
    expect(mocks.spawn).not.toHaveBeenCalled();

    const result = await session.promise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not determine the Oh My Pi version/);
  });
});

describe("persistent omp chat runner", () => {
  it("refuses a turn on an omp that does not enforce the allowlist", async () => {
    installedOmp(LEAKY_VERSION);
    const turn = persistentTurn();

    await expect(turn.promise).rejects.toThrow(
      new RegExp(`Oh My Pi ${LEAKY_VERSION.replace(/\./g, "\\.")}`),
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    // Refused before anything is allocated, so no MCP token is minted for a
    // process that never starts.
    expect(mocks.createChannel).not.toHaveBeenCalled();
  });

  it("starts the warm process on an omp that does enforce it", async () => {
    installedOmp(SAFE_VERSION);
    const turn = persistentTurn();
    turn.promise.catch(() => {});

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    const [binary, args] = mocks.spawn.mock.calls[0] as [string, string[]];
    turn.kill();

    expect(binary).toBe("omp");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
  });
});

/**
 * Exhaustive by construction: the call-site list is derived from the source,
 * not hand-maintained, so a third place that spawns `omp` fails this test
 * instead of silently escaping the gate.
 */
describe("every omp spawn site is gated", () => {
  const GATE = "lib/providers/omp-version.ts";
  /** Argv-position literals that mean "run the omp binary". */
  const SPAWNS_OMP = /(?:binaryName\(\)[^}]*return "omp"|binary:\s*"omp"|nodeSpawn\(\s*"omp"|spawn\(\s*"omp")/s;

  function libFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return libFiles(full);
      return entry.isFile() && full.endsWith(".ts") ? [full] : [];
    });
  }

  it("names the gate, and no other file spawns omp without calling it", () => {
    const gated: string[] = [];
    const ungated: string[] = [];
    for (const file of libFiles("lib")) {
      const relative = path.relative(".", file);
      if (relative === GATE) continue; // the probe itself
      const source = fs.readFileSync(file, "utf-8");
      if (!SPAWNS_OMP.test(source)) continue;
      (source.includes("ompRestrictedToolsBlockReason") ? gated : ungated).push(
        relative,
      );
    }

    expect(ungated).toEqual([]);
    // Both known spawn paths, listed so a REMOVED one is as visible as a new
    // one: the one-shot provider and the persistent RPC chat runner.
    expect(gated.sort()).toEqual([
      "lib/chat/persistent-runner.ts",
      "lib/providers/oh-my-pi.ts",
    ]);
  });
});
