/**
 * Tests for the Pi and Oh My Pi providers.
 *
 * Pi drives the `pi` binary; Oh My Pi is a standalone fork with its own `omp`
 * binary, a `--resume` flag instead of `--session`, and a different read-only
 * tool set — but the same `--mode json` event stream. The interesting shared
 * behavior is that stream: the final answer is the last assistant
 * `message_end`, the session id comes from the stream header, and a run that
 * ended on a model error still exits 0 — so success has to be downgraded from
 * the stream, not the exit code.
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

// Real @/lib/db/schema; the shared chain mock keeps the provider factory
// importable without touching SQLite.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import { getProvider } from "@/lib/providers";
import {
  PiProvider,
  collectPiAssistantMessages,
  extractPiResult,
  extractPiSessionId,
  findPiRunFailure,
} from "@/lib/providers/pi";
import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";
import { isResumableProvider } from "@/lib/agent-sessions/validate-resume";
import type { McpSpawnConfig, ProviderSpawnOptions } from "@/lib/providers/types";
import type { BaseCliProvider } from "@/lib/providers/base-provider";

type Listener = (...args: unknown[]) => void;

/** Fake child process whose stdout/stderr/exit events tests can drive. */
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
    sessionId: "test-123",
    prompt: "Implement a hello world function",
    cwd: "/tmp/test",
    mode: "code",
    ...overrides,
  };
}

const SESSION_ID = "3f1c9a52-1b7e-4f21-9a6f-7b1c2d3e4f50";

const sessionHeader = `{"type":"session","version":3,"id":"${SESSION_ID}","timestamp":"2026-08-19T10:00:00.000Z","cwd":"/tmp/test"}`;

function assistantMessageEnd(
  text: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      ...extra,
    },
  });
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

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

describe("Provider factory — Pi providers", () => {
  it("returns PiProvider for 'pi'", () => {
    const provider = getProvider("pi");
    expect(provider.type).toBe("pi");
    expect(provider).toBeInstanceOf(PiProvider);
  });

  it("returns OhMyPiProvider for 'oh-my-pi'", () => {
    const provider = getProvider("oh-my-pi");
    expect(provider.type).toBe("oh-my-pi");
    expect(provider).toBeInstanceOf(OhMyPiProvider);
  });
});

// ---------------------------------------------------------------------------
// PiProvider
// ---------------------------------------------------------------------------

describe("PiProvider", () => {
  const provider: BaseCliProvider = new PiProvider();

  it("has type 'pi' and binary name 'pi'", () => {
    expect(provider.type).toBe("pi");
    expect(provider.binaryName).toBe("pi");
  });

  describe("buildArgs", () => {
    it("requests the JSON event stream and passes the prompt via -p", () => {
      const args = provider.buildArgs(baseOptions());
      expect(args.slice(0, 2)).toEqual(["--mode", "json"]);
      expect(args.slice(-2)).toEqual(["-p", baseOptions().prompt]);
    });

    it("leaves the full tool set enabled in code mode", () => {
      const args = provider.buildArgs(baseOptions({ mode: "code" }));
      expect(args).not.toContain("--tools");
    });

    it("restricts tools to read-only ones in plan mode", () => {
      const args = provider.buildArgs(baseOptions({ mode: "plan" }));
      expect(args).toContain("--tools");
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    });

    it("restricts tools to read-only ones in analyze mode", () => {
      const args = provider.buildArgs(baseOptions({ mode: "analyze" }));
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    });

    it("ignores an MCP config — pi has no MCP support (omp's rides env, not args)", () => {
      const mcp: McpSpawnConfig = {
        serverName: "arij",
        command: "/usr/bin/node",
        args: ["/app/bin/arij-mcp.mjs"],
        env: { ARIJ_BASE_URL: "http://x", ARIJ_MCP_TOKEN: "t" },
        allowedToolNames: ["mcp__arij_get_ticket"],
      };
      const args = provider.buildArgs(baseOptions({ mode: "plan", mcp }));
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
      expect(provider.buildEnv(baseOptions({ mcp }))).toEqual({
        ...process.env,
      });
    });

    it("includes --session when resuming", () => {
      const args = provider.buildArgs(
        baseOptions({ cliSessionId: SESSION_ID, resumeSession: true }),
      );
      expect(args).toContain("--session");
      expect(args[args.indexOf("--session") + 1]).toBe(SESSION_ID);
    });

    it("omits --session when not resuming", () => {
      const args = provider.buildArgs(baseOptions({ cliSessionId: SESSION_ID }));
      expect(args).not.toContain("--session");
    });

    it("includes --model when a model is specified", () => {
      const args = provider.buildArgs(baseOptions({ model: "anthropic/sonnet" }));
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("anthropic/sonnet");
    });

    it("does not load any extension", () => {
      expect(provider.buildArgs(baseOptions())).not.toContain("-e");
    });
  });

  describe("extractResult", () => {
    it("returns the last assistant message, matching pi's own text mode", () => {
      const stdout = [
        sessionHeader,
        assistantMessageEnd("Let me look at the code.", { stopReason: "toolUse" }),
        assistantMessageEnd("Added the function.", { stopReason: "stop" }),
      ].join("\n");

      expect(provider.extractResult(stdout, "")).toBe("Added the function.");
    });

    it("joins the text blocks of a single message", () => {
      const stdout = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First." },
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Second." },
          ],
          stopReason: "stop",
        },
      });

      expect(provider.extractResult(stdout, "")).toBe("First.\nSecond.");
    });

    it("falls back to earlier assistant text when the last turn has none", () => {
      const stdout = [
        sessionHeader,
        assistantMessageEnd("Here is the plan.", { stopReason: "toolUse" }),
        assistantMessageEnd("", { stopReason: "stop" }),
      ].join("\n");

      expect(provider.extractResult(stdout, "")).toBe("Here is the plan.");
    });

    it("ignores non-assistant messages", () => {
      const stdout = [
        JSON.stringify({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "prompt" }] },
        }),
        assistantMessageEnd("Answer.", { stopReason: "stop" }),
      ].join("\n");

      expect(provider.extractResult(stdout, "")).toBe("Answer.");
    });

    it("falls back to the raw output for an unrecognised stream", () => {
      expect(provider.extractResult("plain text output", "")).toBe(
        "plain text output",
      );
    });

    it("returns an empty string for empty output", () => {
      expect(provider.extractResult("   ", "")).toBe("");
    });
  });

  describe("parseSessionId", () => {
    it("extracts the id from the JSON session header", () => {
      const stdout = [sessionHeader, assistantMessageEnd("Done.")].join("\n");
      expect(provider.parseSessionId(stdout, "")).toBe(SESSION_ID);
    });

    it("falls back to the provided id when no header was emitted", () => {
      expect(provider.parseSessionId("no json here", "", "fallback-id")).toBe(
        "fallback-id",
      );
    });

    it("returns undefined without a header or a fallback", () => {
      expect(provider.parseSessionId("no json here", "")).toBeUndefined();
    });
  });

  describe("run failure detection", () => {
    it("reports the error message of a failed final turn", () => {
      const stdout = [
        sessionHeader,
        assistantMessageEnd("", {
          stopReason: "error",
          errorMessage: "Rate limit exceeded",
        }),
      ].join("\n");

      expect(findPiRunFailure(stdout)).toBe("Rate limit exceeded");
    });

    it("reports an aborted run without an error message", () => {
      const stdout = assistantMessageEnd("", { stopReason: "aborted" });
      expect(findPiRunFailure(stdout)).toBe("Pi run was aborted.");
    });

    it("labels fallback failure messages with the caller's CLI name", () => {
      const stdout = assistantMessageEnd("", { stopReason: "aborted" });
      expect(findPiRunFailure(stdout, "Oh My Pi")).toBe("Oh My Pi run was aborted.");
    });

    it("ignores an error on an earlier turn that the run recovered from", () => {
      const stdout = [
        assistantMessageEnd("", { stopReason: "error", errorMessage: "blip" }),
        assistantMessageEnd("Recovered.", { stopReason: "stop" }),
      ].join("\n");

      expect(findPiRunFailure(stdout)).toBeNull();
    });

    it("returns null for a clean run", () => {
      expect(findPiRunFailure(assistantMessageEnd("Done.", { stopReason: "stop" })))
        .toBeNull();
    });
  });

  describe("spawn lifecycle", () => {
    it("resolves successfully on a clean run", async () => {
      const session = provider.spawn(baseOptions());
      fakeChild.emitStdout(
        [sessionHeader, assistantMessageEnd("All done.", { stopReason: "stop" })]
          .join("\n"),
      );
      fakeChild.emitClose(0);

      const result = await session.promise;
      expect(result.success).toBe(true);
      expect(result.result).toBe("All done.");
      expect(result.cliSessionId).toBe(SESSION_ID);
    });

    it("fails a zero-exit run whose final turn errored out", async () => {
      const session = provider.spawn(baseOptions());
      fakeChild.emitStdout(
        [
          sessionHeader,
          assistantMessageEnd("", {
            stopReason: "error",
            errorMessage: "Context window exceeded",
          }),
        ].join("\n"),
      );
      // --mode json exits 0 even when the run failed.
      fakeChild.emitClose(0);

      const result = await session.promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe("Context window exceeded");
      expect(result.cliSessionId).toBe(SESSION_ID);
    });

    it("redacts the prompt from the display command", () => {
      const session = provider.spawn(baseOptions());
      expect(session.command).toContain("pi --mode json");
      expect(session.command).toContain("-p <prompt>");
      expect(session.command).not.toContain("hello world");
    });
  });
});

// ---------------------------------------------------------------------------
// OhMyPiProvider
// ---------------------------------------------------------------------------

describe("OhMyPiProvider", () => {
  const provider: BaseCliProvider = new OhMyPiProvider();

  it("has type 'oh-my-pi' and runs the standalone omp binary", () => {
    expect(provider.type).toBe("oh-my-pi");
    expect(provider.binaryName).toBe("omp");
  });

  it("does not load any extension — the orchestrator is the CLI itself", () => {
    expect(provider.buildArgs(baseOptions())).not.toContain("-e");
  });

  it("keeps pi's --mode json / -p argument shape", () => {
    const args = provider.buildArgs(baseOptions({ model: "sonnet" }));
    expect(args.slice(0, 2)).toEqual(["--mode", "json"]);
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args.slice(-2)).toEqual(["-p", baseOptions().prompt]);
  });

  it("restricts to omp's read-only tools in plan mode (glob, not find/ls)", () => {
    const args = provider.buildArgs(baseOptions({ mode: "plan" }));
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
  });

  it("resumes with --resume, not pi's --session", () => {
    const args = provider.buildArgs(
      baseOptions({ cliSessionId: SESSION_ID, resumeSession: true }),
    );
    expect(args[args.indexOf("--resume") + 1]).toBe(SESSION_ID);
    expect(args).not.toContain("--session");
  });

  it("parses the pi event stream like the Pi provider", () => {
    const stdout = [
      sessionHeader,
      assistantMessageEnd("Orchestrated.", { stopReason: "stop" }),
    ].join("\n");

    expect(provider.extractResult(stdout, "")).toBe("Orchestrated.");
    expect(provider.parseSessionId(stdout, "")).toBe(SESSION_ID);
  });

  it("shows the omp display command, and points a missing binary at omp", async () => {
    const session = provider.spawn(baseOptions());
    expect(session.command).toContain("omp --mode json");

    fakeChild.emitError(new Error("spawn omp ENOENT"));

    const result = await session.promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("`omp`");
    expect(result.error).not.toContain("pi-coding-agent");
  });

  describe("Arij MCP tool channel", () => {
    const mcp: McpSpawnConfig = {
      serverName: "arij",
      command: "/usr/bin/node",
      args: ["/app/bin/arij-mcp.mjs"],
      env: {
        ARIJ_BASE_URL: "http://localhost:3000",
        ARIJ_MCP_TOKEN: "omp-test-token",
      },
      // omp spelling: single underscore between server and tool
      allowedToolNames: ["mcp__arij_get_ticket", "mcp__arij_post_comment"],
    };

    it("injects the channel's env vars into the child environment", () => {
      const env = provider.buildEnv(baseOptions({ mcp }));
      expect(env.ARIJ_BASE_URL).toBe("http://localhost:3000");
      expect(env.ARIJ_MCP_TOKEN).toBe("omp-test-token");
      // still inherits the parent env rather than replacing it
      expect(env.PATH).toBe(process.env.PATH);
    });

    it("keeps the child environment untouched without a channel", () => {
      const env = provider.buildEnv(baseOptions());
      expect(env).toEqual({ ...process.env });
      expect("ARIJ_MCP_TOKEN" in env).toBe(false);
    });

    it("passes the chat toolset selector through when the channel sets it", () => {
      const chatMcp = {
        ...mcp,
        env: { ...mcp.env, ARIJ_MCP_TOOLSET: "chat" as const },
      };
      const env = provider.buildEnv(baseOptions({ mcp: chatMcp }));
      expect(env.ARIJ_MCP_TOOLSET).toBe("chat");
    });

    it("strips an inherited toolset selector when the channel sets none", () => {
      // The shim and the mcp.json entry both select the toolset by key
      // PRESENCE, so a stray ARIJ_MCP_TOOLSET in the server's own env would
      // silently flip agent sessions to the board-wide chat toolset.
      vi.stubEnv("ARIJ_MCP_TOOLSET", "chat");
      try {
        const env = provider.buildEnv(baseOptions({ mcp }));
        expect("ARIJ_MCP_TOOLSET" in env).toBe(false);
        // …but only channel-carrying spawns are policed: a spawn without a
        // channel keeps the parent env untouched, stray keys included.
        const bare = provider.buildEnv(baseOptions());
        expect(bare.ARIJ_MCP_TOOLSET).toBe("chat");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("keeps MCP names OUT of --tools — unknown names are a fatal omp argv error", () => {
      // Measured on omp 17.2.1: --tools validates against built-in names
      // only, and `Unknown tools in --tools: mcp__arij_…` kills the spawn.
      // MCP tools stay mounted regardless of the allowlist, so non-code
      // sessions keep the channel with the plain read-only list.
      const args = provider.buildArgs(baseOptions({ mode: "plan", mcp }));
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
    });

    it("passes no --tools in code mode — omp's default set already has MCP", () => {
      const args = provider.buildArgs(baseOptions({ mode: "code", mcp }));
      expect(args).not.toContain("--tools");
    });

    it("keeps --tools to the read-only built-ins without a channel", () => {
      const args = provider.buildArgs(baseOptions({ mode: "analyze" }));
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
    });
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe("pi stream helpers", () => {
  it("collectPiAssistantMessages keeps turn order and stop reasons", () => {
    const stdout = [
      sessionHeader,
      assistantMessageEnd("one", { stopReason: "toolUse" }),
      "not json",
      assistantMessageEnd("two", { stopReason: "stop" }),
    ].join("\n");

    expect(collectPiAssistantMessages(stdout)).toEqual([
      { text: "one", stopReason: "toolUse", errorMessage: undefined },
      { text: "two", stopReason: "stop", errorMessage: undefined },
    ]);
  });

  it("extractPiSessionId ignores lines that are not the session header", () => {
    expect(extractPiSessionId(assistantMessageEnd("hi"))).toBeUndefined();
    expect(extractPiSessionId(sessionHeader)).toBe(SESSION_ID);
  });

  it("extractPiResult tolerates a truncated trailing line", () => {
    const stdout = [
      sessionHeader,
      assistantMessageEnd("Complete.", { stopReason: "stop" }),
      '{"type":"agent_end","messa',
    ].join("\n");

    expect(extractPiResult(stdout)).toBe("Complete.");
  });
});

// ---------------------------------------------------------------------------
// Resume classification
// ---------------------------------------------------------------------------

describe("Resume classification — Pi providers", () => {
  it("treats pi (--session) and oh-my-pi (--resume) as resumable", () => {
    expect(isResumableProvider("pi")).toBe(true);
    expect(isResumableProvider("oh-my-pi")).toBe(true);
  });
});
