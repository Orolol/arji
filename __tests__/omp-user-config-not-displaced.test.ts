/**
 * Regression: Arij must not hand `omp` a `--config` overlay.
 *
 * Arij used to pass `--config <temp>.yml` containing only `tools: {xdev:
 * false}` on every read-only omp spawn, to strip a `write` tool that omp
 * 17.2.1 force-mounted despite `--tools read,grep,glob`. That flag is a lever
 * over the user's whole configuration: a session reported the overlay
 * DISPLACING `~/.omp/agent/config.yml` instead of layering over it, so every
 * omp session silently ran on a fallback model — a local one, on the user's
 * GPU — and lost modelRoles, agentModelOverrides and session settings with it.
 *
 * Re-probed on omp 18.0.6 (2026-08-28), with a live stdio MCP server mounted
 * so the xd:// device surface was non-empty:
 *
 *   --tools read,grep,glob                         -> read, grep, glob, mcp__arij_get_ticket
 *   --tools read,grep,glob --config <xdev-off>.yml -> read, grep, glob, mcp__arij_get_ticket
 *
 * `write` is no longer force-mounted, MCP tools already mount as first-class
 * tools under the exact `mcp__arij_*` names Arij spells into prompts, and the
 * overlay changes the tool surface by nothing at all. So the flag buys no
 * isolation and only carries the displacement risk: drop it, and omp reads the
 * user's own configuration through its normal layering.
 *
 * These assertions cover BOTH call sites — the one-shot provider
 * (`OhMyPiProvider`) and the persistent chat runner — because they built the
 * overlay path from the same helper and would have regressed together.
 */
import { EventEmitter } from "events";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => "omp/18.0.6\n"),
  createChannel: vi.fn(),
  writeMcpConfigFile: vi.fn(() => "/tmp/arij-persistent-mcp.json"),
  cleanupMcpConfigFile: vi.fn(),
}));

// The persistent omp path now checks `omp --version` before it spawns
// anything: with the `tools.xdev` overlay gone, the `--tools` allowlist is the
// whole read-only isolation mechanism and only omp 18.0.6+ is measured to
// honour it. Report a version at the floor so these tests exercise the spawn
// path itself — the gate's own supported/refused/unreadable cases live in
// `omp-version-gate.test.ts`.
vi.mock("child_process", () => ({
  default: { spawn: mocks.spawn, execFileSync: mocks.execFileSync },
  spawn: mocks.spawn,
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
import type { ProviderSpawnOptions } from "@/lib/providers/types";

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

function spawnOptions(
  overrides: Partial<ProviderSpawnOptions> = {},
): ProviderSpawnOptions {
  return {
    sessionId: "omp-config-regression",
    prompt: "Summarise the repository",
    cwd: "/tmp/test",
    mode: "code",
    ...overrides,
  };
}

/**
 * Every argv value that names a file Arij wrote for this spawn. `--config`
 * is the flag under test; the tmpdir sweep is the backstop, so re-introducing
 * the overlay under any other flag name still fails.
 */
function configFileArgs(args: string[]): string[] {
  return args.filter(
    (arg, index) =>
      args[index - 1] === "--config" ||
      (arg.startsWith(os.tmpdir()) && arg.endsWith(".yml")),
  );
}

describe("omp spawns leave the user's omp configuration alone", () => {
  describe("one-shot provider", () => {
    const provider = new OhMyPiProvider();

    it.each(["plan", "chat", "analyze", "code"] as const)(
      "passes no config overlay in %s mode",
      (mode) => {
        const args = provider.buildArgs(spawnOptions({ mode }));
        expect(args).not.toContain("--config");
        expect(configFileArgs(args)).toEqual([]);
      },
    );

    it("still restricts read-only modes through the tool allowlist alone", () => {
      // The isolation property the overlay used to backstop has to survive
      // its removal: omp 18.0.6 honours the allowlist exactly, so `write`
      // must still be absent from every read-only mode's argv.
      for (const mode of ["plan", "chat"] as const) {
        const args = provider.buildArgs(spawnOptions({ mode }));
        expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
      }
      const analyze = provider.buildArgs(spawnOptions({ mode: "analyze" }));
      expect(analyze[analyze.indexOf("--tools") + 1]).toBe(
        "read,grep,glob,write",
      );
    });
  });

  describe("persistent chat runner", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.createChannel.mockReturnValue(null);
      mocks.spawn.mockImplementation(() => new FakeChild());
    });

    afterEach(() => {
      resetPersistentChatRunnerForTests();
    });

    it("passes no config overlay to the persistent omp process", async () => {
      const turn = runPersistentChatTurn({
        conversationId: "omp-config-regression",
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
      turn.promise.catch(() => {});

      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
      const [binary, args] = mocks.spawn.mock.calls[0] as [string, string[]];
      turn.kill();

      expect(binary).toBe("omp");
      expect(args).toContain("--tools");
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
      expect(args).not.toContain("--config");
      expect(configFileArgs(args)).toEqual([]);
    });
  });
});
