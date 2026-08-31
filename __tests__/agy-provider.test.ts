/**
 * Tests for the Antigravity (agy) provider.
 *
 * Every behavior asserted here mirrors a live measurement on agy 1.1.21
 * (2026-08-26) — see the header of lib/providers/agy.ts and
 * docs/architecture/mcp-provider-matrix.md: JSON envelope on stdout,
 * self-reported conversation_id, `--conversation` resume, `--mode plan`
 * read-only posture, `--add-dir` workspace anchoring, and the env-borne
 * MCP channel with BARE tool names.
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

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import { getProvider } from "@/lib/providers";
import { AgyProvider, parseAgyEnvelope } from "@/lib/providers/agy";
import {
  arijMcpToolPrefix,
  buildMcpSpawnConfig,
} from "@/lib/claude/mcp-injection";
import {
  isResumableProvider,
  providerReportsOwnSessionId,
  providerAcceptsAssignedSessionId,
} from "@/lib/agent-sessions/resume-capability";
import {
  arijChannelSpec,
  type McpSpawnConfig,
  type ProviderSpawnOptions,
} from "@/lib/providers/types";

type Listener = (...args: unknown[]) => void;

function createFakeChild() {
  const listeners = new Map<string, Listener[]>();
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];

  return {
    stdout: {
      on: (event: string, fn: (chunk: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(fn);
      },
    },
    stderr: { on: () => {} },
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
    emitClose(code: number | null) {
      for (const fn of listeners.get("close") ?? []) fn(code);
    },
    emitError(err: Error) {
      for (const fn of listeners.get("error") ?? []) fn(err);
    },
  };
}

function baseOptions(
  overrides: Partial<ProviderSpawnOptions> = {},
): ProviderSpawnOptions {
  return {
    sessionId: "test-agy-1",
    prompt: "Implement a hello world function",
    cwd: "/tmp/worktree",
    mode: "code",
    ...overrides,
  };
}

const CONVERSATION_ID = "f9768bca-f8ca-4690-8eb3-b728f170f819";

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conversation_id: CONVERSATION_ID,
    status: "SUCCESS",
    response: "Done.\n",
    duration_seconds: 2.1,
    num_turns: 1,
    ...overrides,
  });
}

const ARIJ_CHANNEL = {
  name: "arij",
  command: "/usr/bin/node",
  args: ["/app/bin/arij-mcp.mjs"],
  env: { ARIJ_BASE_URL: "http://localhost:3000", ARIJ_MCP_TOKEN: "tok-1" },
};

const MCP: McpSpawnConfig = {
  servers: [ARIJ_CHANNEL],
  allowedToolNames: ["get_ticket"],
};

let fakeChild: ReturnType<typeof createFakeChild>;

beforeEach(() => {
  fakeChild = createFakeChild();
  mockSpawn.mockClear();
  mockSpawn.mockImplementation(() => fakeChild);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Provider factory — agy", () => {
  it("returns AgyProvider for 'agy'", () => {
    const provider = getProvider("agy");
    expect(provider.type).toBe("agy");
    expect(provider).toBeInstanceOf(AgyProvider);
  });
});

describe("AgyProvider", () => {
  const provider = new AgyProvider();

  describe("buildArgs", () => {
    it("requests JSON output with a long print timeout and the prompt via -p", () => {
      const args = provider.buildArgs(baseOptions());
      expect(args.slice(0, 4)).toEqual([
        "--output-format",
        "json",
        "--print-timeout",
        "24h",
      ]);
      expect(args.slice(-2)).toEqual(["-p", baseOptions().prompt]);
    });

    it("anchors the workspace to the worktree with --add-dir", () => {
      // Measured: without --add-dir agy writes relative files into $HOME,
      // not the process cwd.
      const args = provider.buildArgs(baseOptions());
      expect(args[args.indexOf("--add-dir") + 1]).toBe("/tmp/worktree");
    });

    it("uses --mode plan for plan and chat sessions", () => {
      for (const mode of ["plan", "chat"] as const) {
        const args = provider.buildArgs(baseOptions({ mode }));
        expect(args[args.indexOf("--mode") + 1]).toBe("plan");
      }
    });

    it("keeps the default full posture in code and analyze modes", () => {
      // agy has no tool allowlist; --mode plan would block the arji.json
      // write that analyze exists for.
      for (const mode of ["code", "analyze"] as const) {
        expect(provider.buildArgs(baseOptions({ mode }))).not.toContain(
          "--mode",
        );
      }
    });

    it("resumes with --conversation", () => {
      const args = provider.buildArgs(
        baseOptions({ cliSessionId: CONVERSATION_ID, resumeSession: true }),
      );
      expect(args[args.indexOf("--conversation") + 1]).toBe(CONVERSATION_ID);
    });

    it("omits --conversation when not resuming", () => {
      const args = provider.buildArgs(
        baseOptions({ cliSessionId: CONVERSATION_ID }),
      );
      expect(args).not.toContain("--conversation");
    });

    it("passes the model through", () => {
      const args = provider.buildArgs(baseOptions({ model: "gemini-3-pro" }));
      expect(args[args.indexOf("--model") + 1]).toBe("gemini-3-pro");
    });

    it("needs no permission-bypass flag — print mode auto-approves", () => {
      // Measured: writes, run_command and MCP calls all execute in plain
      // print mode; there is no codex-style approval gate to open.
      const args = provider.buildArgs(baseOptions({ mode: "code" }));
      expect(args.join(" ")).not.toContain("dangerously");
    });
  });

  describe("MCP channel via child env", () => {
    it("injects the channel's env vars into the child environment", () => {
      const env = provider.buildEnv(baseOptions({ mcp: MCP }));
      expect(env.ARIJ_BASE_URL).toBe("http://localhost:3000");
      expect(env.ARIJ_MCP_TOKEN).toBe("tok-1");
    });

    it("keeps the child environment untouched without a channel", () => {
      expect(provider.buildEnv(baseOptions())).toEqual({ ...process.env });
    });

    it("strips an inherited toolset selector when the channel sets none", () => {
      const original = process.env.ARIJ_MCP_TOOLSET;
      process.env.ARIJ_MCP_TOOLSET = "chat";
      try {
        const env = provider.buildEnv(baseOptions({ mcp: MCP }));
        expect(env.ARIJ_MCP_TOOLSET).toBeUndefined();
      } finally {
        if (original === undefined) delete process.env.ARIJ_MCP_TOOLSET;
        else process.env.ARIJ_MCP_TOOLSET = original;
      }
    });

    it("passes the chat toolset selector through when the channel sets it", () => {
      const env = provider.buildEnv(
        baseOptions({
          mcp: {
            ...MCP,
            servers: [
              {
                ...ARIJ_CHANNEL,
                env: { ...ARIJ_CHANNEL.env, ARIJ_MCP_TOOLSET: "chat" },
              },
            ],
          },
        }),
      );
      expect(env.ARIJ_MCP_TOOLSET).toBe("chat");
    });

    it("spells tool names BARE — no mcp__arij prefix at all", () => {
      // Measured on 1.1.21: agy mounts MCP tools as get_ticket, post_comment…
      expect(arijMcpToolPrefix("agy")).toBe("");
      const config = buildMcpSpawnConfig({ token: "t", provider: "agy" });
      expect(config.allowedToolNames).toContain("get_ticket");
      expect(config.allowedToolNames).toContain("submit_findings");
      expect(
        config.allowedToolNames.every((name) => !name.startsWith("mcp__")),
      ).toBe(true);
      // spelling is the ONLY divergence — server, shim and env are unchanged
      expect(arijChannelSpec(config).env).toEqual(
        arijChannelSpec(buildMcpSpawnConfig({ token: "t" })).env,
      );
    });
  });

  describe("envelope parsing", () => {
    it("parses the JSON envelope, skipping startup noise", () => {
      const parsed = parseAgyEnvelope(
        `Update available: 1.2.0\n${envelope()}\n`,
      );
      expect(parsed).toEqual({
        conversationId: CONVERSATION_ID,
        status: "SUCCESS",
        response: "Done.\n",
      });
    });

    it("extractResult returns the trimmed response, falling back to raw output", () => {
      expect(provider.extractResult(envelope())).toBe("Done.");
      expect(provider.extractResult("plain text output\n")).toBe(
        "plain text output",
      );
    });

    it("parseSessionId reads the self-reported conversation_id", () => {
      expect(provider.parseSessionId(envelope(), "", "fallback")).toBe(
        CONVERSATION_ID,
      );
      expect(provider.parseSessionId("no json here", "", "fallback")).toBe(
        "fallback",
      );
    });
  });

  describe("spawn lifecycle", () => {
    it("resolves successfully on a clean run", async () => {
      const session = provider.spawn(baseOptions());
      fakeChild.emitStdout(envelope());
      fakeChild.emitClose(0);

      const result = await session.promise;
      expect(result.success).toBe(true);
      expect(result.result).toBe("Done.");
      expect(result.cliSessionId).toBe(CONVERSATION_ID);
    });

    it("downgrades a zero-exit run whose envelope status is not SUCCESS", async () => {
      const session = provider.spawn(baseOptions());
      fakeChild.emitStdout(
        envelope({ status: "ERROR", response: "Model overloaded" }),
      );
      fakeChild.emitClose(0);

      const result = await session.promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe("Model overloaded");
    });

    it("points a missing binary at the Antigravity install", async () => {
      const session = provider.spawn(baseOptions());
      fakeChild.emitError(
        Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }),
      );

      const result = await session.promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain("Antigravity CLI not found");
    });
  });
});

describe("Resume classification — agy", () => {
  it("is resumable, self-reporting, and never pre-assigned an id", () => {
    expect(isResumableProvider("agy")).toBe(true);
    expect(providerReportsOwnSessionId("agy")).toBe(true);
    expect(providerAcceptsAssignedSessionId("agy")).toBe(false);
  });
});
