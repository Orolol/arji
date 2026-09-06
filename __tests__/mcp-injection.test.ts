/**
 * Arij MCP tool-channel injection — argument construction layer.
 *
 * Covers the per-provider CLI wiring for the MCP spawn config
 * (lib/claude/spawn.ts buildClaudeArgs/prepareClaudeSpawn,
 * lib/providers/codex.ts buildArgs), the 0600 temp-file form of claude's
 * --mcp-config (which is what keeps the bearer token out of argv and thus out
 * of /proc/<pid>/cmdline), the token redaction in persisted display commands,
 * the arijToolsSection prompt block, and the mcp_tools_enabled setting parse
 * (default ON).
 *
 * The process-manager gating matrix + token lifecycle live in
 * __tests__/mcp-injection-lifecycle.test.ts (they need module resets and a
 * db chain mock; this file stays pure).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it, expect, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

// child_process is only needed by the spawnClaude display-command test; the
// codex provider imports execSync at module level but never calls it here.
vi.mock("child_process", () => {
  const execSync = vi.fn();
  return {
    spawn: mockSpawn,
    execSync,
    default: { spawn: mockSpawn, execSync },
  };
});

import { buildClaudeArgs, prepareClaudeSpawn, spawnClaude } from "@/lib/claude/spawn";
import { CodexProvider } from "@/lib/providers/codex";
import { arijToolsSection } from "@/lib/claude/prompt-sections";
import { isMcpExemptAgentType } from "@/lib/workflow/dreaming-constants";
import {
  ARIJ_MCP_ALLOWED_TOOL_NAMES,
  allowedToolNamesForAgentType,
  ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES,
  ARIJ_MCP_SERVER_NAME,
  arijMcpToolName,
  arijMcpToolPrefix,
  buildMcpSpawnConfig,
  cleanupMcpConfigFile,
  parseMcpToolsEnabledSetting,
  providerSupportsMcp,
  writeMcpConfigFile,
} from "@/lib/claude/mcp-injection";
import {
  arijChannelSpec,
  type McpSpawnConfig,
  type ProviderSpawnOptions,
} from "@/lib/providers/types";

const TOKEN = "arij-mcp-secret-token-12345";

const sampleArijChannel = {
  name: "arij",
  command: "/usr/bin/node",
  args: ["/app/bin/arij-mcp.mjs"],
  env: {
    ARIJ_BASE_URL: "http://localhost:3000",
    ARIJ_MCP_TOKEN: TOKEN,
  },
};

const sampleMcp: McpSpawnConfig = {
  servers: [sampleArijChannel],
  allowedToolNames: [...ARIJ_MCP_ALLOWED_TOOL_NAMES],
};

const EXPECTED_MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    arij: {
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/app/bin/arij-mcp.mjs"],
      env: {
        ARIJ_BASE_URL: "http://localhost:3000",
        ARIJ_MCP_TOKEN: TOKEN,
      },
    },
  },
});

/** Stand-in path for the pure buildClaudeArgs tests (no file is written). */
const FAKE_CONFIG_PATH = "/tmp/arij-mcp-fake/mcp-config.json";

function createFakeChild() {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
  };
}

describe("buildClaudeArgs — MCP config injection", () => {
  it("stays byte-identical without mcp (no MCP flags leak into plain spawns)", () => {
    const args = buildClaudeArgs(
      { mode: "code", prompt: "hello", allowedTools: ["Edit", "Bash"] },
      "json",
    );
    expect(args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--print",
      "-p",
      "hello",
      "--allowedTools",
      "Edit",
      "Bash",
    ]);
  });

  it("appends --mcp-config <file path> + --strict-mcp-config and merges the exact tool names", () => {
    const args = buildClaudeArgs(
      {
        mode: "code",
        prompt: "hello",
        allowedTools: ["Edit", "Bash"],
        mcp: sampleMcp,
      },
      "json",
      FAKE_CONFIG_PATH,
    );

    expect(args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--print",
      "-p",
      "hello",
      "--mcp-config",
      FAKE_CONFIG_PATH,
      "--strict-mcp-config",
      "--allowedTools",
      "Edit",
      "Bash",
      "mcp__arij__get_ticket",
      "mcp__arij__update_ticket_status",
      "mcp__arij__post_comment",
      "mcp__arij__report_friction",
      "mcp__arij__attach_artifact",
      "mcp__arij__create_bug",
      "mcp__arij__ask_question",
      "mcp__arij__submit_findings",
      "mcp__arij__submit_grading",
      "mcp__arij__set_priority",
      "mcp__arij__reorder_tickets",
      "mcp__arij__add_dependency",
      "mcp__arij__remove_dependency",
      "mcp__arij__promote_ticket",
      "mcp__arij__merge_tickets",
      "mcp__arij__discard_ticket",
      "mcp__arij__create_planning_ticket",
    ]);
  });

  it("never puts the token in argv — no argument carries it, inline JSON is gone", () => {
    const args = buildClaudeArgs(
      { mode: "code", prompt: "hello", mcp: sampleMcp },
      "json",
      FAKE_CONFIG_PATH,
    );

    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.some((a) => a.includes("ARIJ_MCP_TOKEN"))).toBe(false);
    expect(args.some((a) => a.includes("mcpServers"))).toBe(false);
  });

  it("degrades to a plain spawn when no config path was produced (write failure)", () => {
    const args = buildClaudeArgs(
      { mode: "code", prompt: "hello", allowedTools: ["Edit"], mcp: sampleMcp },
      "json",
    );

    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    // no allowlist entries for a server that was never configured
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual(["Edit"]);
  });

  it("chat mode: permission mode default with a read-only repo allowlist plus the MCP names", () => {
    const args = buildClaudeArgs(
      { mode: "chat", prompt: "p", mcp: sampleMcp },
      "json",
      FAKE_CONFIG_PATH,
    );

    // Plan mode refuses allowlisted mutating MCP tools headlessly — chat
    // turns need "default" so the board tools actually run.
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    const allowed = args.slice(args.indexOf("--allowedTools") + 1);
    expect(allowed.slice(0, 3)).toEqual(["Read", "Glob", "Grep"]);
    expect(allowed).toContain("mcp__arij__get_ticket");
    // The repo stays read-only: no Bash, no Write, no Edit.
    expect(allowed).not.toContain("Bash");
    expect(allowed).not.toContain("Write");
    expect(allowed).not.toContain("Edit");
  });

  it("chat mode without MCP still pins the read-only allowlist", () => {
    const args = buildClaudeArgs({ mode: "chat", prompt: "p" }, "json");
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual([
      "Read",
      "Glob",
      "Grep",
    ]);
  });

  it("adds --allowedTools with only the MCP names when no base tools exist (plan mode)", () => {
    const args = buildClaudeArgs(
      { mode: "plan", prompt: "p", mcp: sampleMcp },
      "json",
      FAKE_CONFIG_PATH,
    );
    expect(args).toContain("--strict-mcp-config");
    const allowedIdx = args.indexOf("--allowedTools");
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(args.slice(allowedIdx + 1)).toEqual([...ARIJ_MCP_ALLOWED_TOOL_NAMES]);
    // plan mode keeps its read-only permission mode
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "plan"]);
  });

  it("merges on top of the analyze-mode default toolset", () => {
    const args = buildClaudeArgs(
      { mode: "analyze", prompt: "p", mcp: sampleMcp },
      "json",
      FAKE_CONFIG_PATH,
    );
    const allowedIdx = args.indexOf("--allowedTools");
    expect(args.slice(allowedIdx + 1)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      ...ARIJ_MCP_ALLOWED_TOOL_NAMES,
    ]);
  });
});

describe("allowedToolNamesForAgentType", () => {
  /**
   * The agent toolset MINUS the three refinement-exclusive tools — what any
   * ordinary agent type is offered. Spelled out rather than derived from
   * `allowedToolNamesForAgentType` itself, so a bug in the narrowing cannot
   * make this expectation agree with it.
   */
  const REFINEMENT_EXCLUSIVE = [
    "mcp__arij__merge_tickets",
    "mcp__arij__discard_ticket",
    "mcp__arij__create_planning_ticket",
  ];
  const ORDINARY_AGENT_TOOLS = ARIJ_MCP_ALLOWED_TOOL_NAMES.filter(
    (tool) => !REFINEMENT_EXCLUSIVE.includes(tool),
  );

  it("gives an ordinary agent type every tool except the refinement-exclusive ones", () => {
    expect(allowedToolNamesForAgentType("build")).toEqual(ORDINARY_AGENT_TOOLS);
    expect(allowedToolNamesForAgentType(null)).toEqual(ORDINARY_AGENT_TOOLS);
  });

  /**
   * merge_tickets and discard_ticket permanently delete board rows and
   * create_planning_ticket invents them. A build or review session has no
   * business doing either, so they never reach its allowlist — and the
   * routes refuse its token outright (requireRefinementSessionToken).
   */
  it("withholds the row-creating and row-destroying tools from every other agent type", () => {
    for (const agentType of ["build", "review", "grading", "merge", null]) {
      const tools = allowedToolNamesForAgentType(agentType);
      for (const exclusive of REFINEMENT_EXCLUSIVE) {
        expect(tools).not.toContain(exclusive);
      }
    }
  });

  it("offers them to a refinement pass", () => {
    const tools = allowedToolNamesForAgentType("refinement");
    for (const exclusive of REFINEMENT_EXCLUSIVE) {
      expect(tools).toContain(exclusive);
    }
  });

  /**
   * A refinement pass is confined to Backlog/To do by an engine guard keyed
   * on `source: "refinement"`. update_ticket_status writes with
   * `source: "api"`, so it bypasses that guard entirely — the spawn must not
   * be offered it. (The route refuses it too; that is the actual guard.)
   */
  it("withholds update_ticket_status from a refinement pass", () => {
    const tools = allowedToolNamesForAgentType("refinement");
    expect(tools).not.toContain("mcp__arij__update_ticket_status");
    // Its own board tools are untouched.
    for (const tool of [
      "mcp__arij__promote_ticket",
      "mcp__arij__reorder_tickets",
      "mcp__arij__set_priority",
      "mcp__arij__add_dependency",
      "mcp__arij__remove_dependency",
      "mcp__arij__post_comment",
    ]) {
      expect(tools).toContain(tool);
    }
    expect(tools).toHaveLength(ARIJ_MCP_ALLOWED_TOOL_NAMES.length - 1);
  });

  it("is applied by buildMcpSpawnConfig", () => {
    const config = buildMcpSpawnConfig({
      token: "t",
      agentType: "refinement",
    });
    expect(config.allowedToolNames).not.toContain(
      "mcp__arij__update_ticket_status"
    );
    expect(
      buildMcpSpawnConfig({ token: "t", agentType: "build" }).allowedToolNames
    ).toContain("mcp__arij__update_ticket_status");

    const ompConfig = buildMcpSpawnConfig({
      token: "t",
      agentType: "refinement",
      provider: "oh-my-pi",
    });
    expect(ompConfig.allowedToolNames).not.toContain(
      "mcp__arij_update_ticket_status",
    );
    expect(ompConfig.allowedToolNames).toContain("mcp__arij_promote_ticket");
  });
});

describe("writeMcpConfigFile / cleanupMcpConfigFile", () => {
  it("writes the config as a 0600 file whose contents carry the token", () => {
    const filePath = writeMcpConfigFile(sampleMcp);
    try {
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe(EXPECTED_MCP_CONFIG_JSON);
      // owner-only: no group/other bits on the file…
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      // …nor on the temp directory holding it
      expect(statSync(dirname(filePath)).mode & 0o077).toBe(0);
    } finally {
      cleanupMcpConfigFile(filePath);
    }
  });

  it("mints a distinct unpredictable path per call", () => {
    const a = writeMcpConfigFile(sampleMcp);
    const b = writeMcpConfigFile(sampleMcp);
    try {
      expect(a).not.toBe(b);
    } finally {
      cleanupMcpConfigFile(a);
      cleanupMcpConfigFile(b);
    }
  });

  it("removes the file and its temp directory, and is idempotent", () => {
    const filePath = writeMcpConfigFile(sampleMcp);
    const dir = dirname(filePath);

    cleanupMcpConfigFile(filePath);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dir)).toBe(false);

    // second call (and a nullish path) must not throw
    expect(() => cleanupMcpConfigFile(filePath)).not.toThrow();
    expect(() => cleanupMcpConfigFile(null)).not.toThrow();
    expect(() => cleanupMcpConfigFile(undefined)).not.toThrow();
  });
});

describe("prepareClaudeSpawn — token lands in the file, never in argv", () => {
  it("writes the config file and points --mcp-config at it", () => {
    const { args, mcpConfigPath } = prepareClaudeSpawn(
      { mode: "code", prompt: "hello", mcp: sampleMcp },
      "json",
    );

    try {
      expect(mcpConfigPath).toBeTruthy();
      expect(args[args.indexOf("--mcp-config") + 1]).toBe(mcpConfigPath);
      expect(args.join(" ")).not.toContain(TOKEN);

      const written = JSON.parse(readFileSync(mcpConfigPath!, "utf-8"));
      expect(written.mcpServers.arij.env.ARIJ_MCP_TOKEN).toBe(TOKEN);
      expect(written.mcpServers.arij.type).toBe("stdio");
    } finally {
      cleanupMcpConfigFile(mcpConfigPath);
    }
  });

  it("writes nothing when there is no mcp config", () => {
    const { args, mcpConfigPath } = prepareClaudeSpawn(
      { mode: "code", prompt: "hello" },
      "json",
    );
    expect(mcpConfigPath).toBeNull();
    expect(args).not.toContain("--mcp-config");
  });
});

describe("spawnClaude — display command redaction", () => {
  it("never leaks the bearer token into the persisted cliCommand", () => {
    mockSpawn.mockReturnValue(createFakeChild());

    const { command, mcpConfigPath } = spawnClaude({
      mode: "code",
      prompt: "do the thing",
      mcp: sampleMcp,
    });

    try {
      expect(command).toBeDefined();
      expect(command).toContain("<mcp-config>");
      expect(command).toContain("--strict-mcp-config");
      expect(command).not.toContain(TOKEN);

      // The token lives in the temp file, and the spawned argv points at it.
      expect(mcpConfigPath).toBeTruthy();
      expect(readFileSync(mcpConfigPath!, "utf-8")).toContain(TOKEN);
      const spawnedArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnedArgs.join(" ")).not.toContain(TOKEN);
      expect(spawnedArgs[spawnedArgs.indexOf("--mcp-config") + 1]).toBe(
        mcpConfigPath,
      );
    } finally {
      // the fake child never emits "close", so clean up by hand
      cleanupMcpConfigFile(mcpConfigPath);
    }
  });
});

describe("CodexProvider.buildArgs — -c mcp_servers overrides", () => {
  const provider = new CodexProvider();

  function baseOptions(
    overrides: Partial<ProviderSpawnOptions> = {},
  ): ProviderSpawnOptions {
    return {
      sessionId: "s1",
      prompt: "PROMPT",
      cwd: "/work",
      mode: "code",
      ...overrides,
    };
  }

  const spawnContext = { outputFile: "/tmp/codex-out-test.txt" };

  it.each(["code", "plan", "analyze", "chat"] as const)(
    "opens the approval gate in %s mode, so MCP tool calls can land",
    (mode) => {
      // `codex exec` refuses every MCP tool call unless approvals are
      // bypassed — its closed stdin reads as a refusal. Measured on 0.148:
      // read-only and workspace-write both start the server and then refuse
      // the call. A sandboxed codex agent is an agent with no tool channel,
      // so all modes get the same posture.
      const args = provider.buildArgs(
        baseOptions({ mode, mcp: sampleMcp }),
        spawnContext,
      );
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("-s");
    },
  );

  it("opens the same gate on the resume subcommand", () => {
    const args = provider.buildArgs(
      baseOptions({
        mode: "plan",
        mcp: sampleMcp,
        cliSessionId: "cli-1",
        resumeSession: true,
      }),
      spawnContext,
    );
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("adds the three TOML overrides in the non-resume branch, before the prompt", () => {
    const args = provider.buildArgs(baseOptions({ mcp: sampleMcp }), spawnContext);

    const expectedOverrides = [
      "-c",
      'mcp_servers.arij.command="/usr/bin/node"',
      "-c",
      'mcp_servers.arij.args=["/app/bin/arij-mcp.mjs"]',
      "-c",
      `mcp_servers.arij.env={ARIJ_BASE_URL="http://localhost:3000",ARIJ_MCP_TOKEN=${JSON.stringify(TOKEN)}}`,
    ];
    const start = args.indexOf(expectedOverrides[1]) - 1;
    expect(start).toBeGreaterThan(-1);
    expect(args.slice(start, start + 6)).toEqual(expectedOverrides);
    // prompt stays the last positional argument
    expect(args[args.length - 1]).toBe("PROMPT");
  });

  it("adds the same overrides in the resume branch", () => {
    const args = provider.buildArgs(
      baseOptions({
        mcp: sampleMcp,
        cliSessionId: "cli-123",
        resumeSession: true,
      }),
      spawnContext,
    );

    expect(args.slice(0, 3)).toEqual(["exec", "resume", "cli-123"]);
    expect(args).toContain('mcp_servers.arij.command="/usr/bin/node"');
    expect(args).toContain('mcp_servers.arij.args=["/app/bin/arij-mcp.mjs"]');
    expect(args).toContain(
      `mcp_servers.arij.env={ARIJ_BASE_URL="http://localhost:3000",ARIJ_MCP_TOKEN=${JSON.stringify(TOKEN)}}`,
    );
    expect(args[args.length - 1]).toBe("PROMPT");
  });

  it("emits no mcp_servers overrides without mcp", () => {
    const withoutMcp = provider.buildArgs(baseOptions(), spawnContext);
    expect(withoutMcp.some((a) => a.startsWith("mcp_servers."))).toBe(false);
  });

  it("masks the token-bearing env override in the display command only", () => {
    const args = provider.buildArgs(baseOptions({ mcp: sampleMcp }), spawnContext);
    const command = provider.buildDisplayCommand(args, "PROMPT");

    expect(command).not.toContain(TOKEN);
    expect(command).toContain("mcp_servers.arij.env=<redacted>");
    // command/args overrides carry no secret and stay readable
    expect(command).toContain('mcp_servers.arij.command="/usr/bin/node"');
    expect(command).toContain('mcp_servers.arij.args=["/app/bin/arij-mcp.mjs"]');
  });
});

describe("arijToolsSection", () => {
  it("renders the section with the mcp__arij__* instructions", () => {
    const text = arijToolsSection("build");
    expect(text.startsWith("## Arij tools\n\n")).toBe(true);
    expect(text).toContain("mcp__arij__*");
    expect(text).toContain("ask_question");
    expect(text).toContain("create_bug");
    expect(text).toContain("update_ticket_status");
    expect(text).toContain("report_friction and then continue working");
    expect(text).toContain("fire-and-forget");
    expect(text).toContain("never a reason to stop or leave the task unfinished");
    expect(text).not.toContain("submit_findings");
    expect(text).not.toContain("Overall Verdict");
  });

  it.each(["build", "ticket_build"])(
    "tells %s sessions they may move their own ticket to Review",
    (agentType) => {
      const text = arijToolsSection(agentType);
      expect(text).toContain("You may move the ticket you are building");
      expect(text).toContain("move it to Review");
      expect(text).toContain("update_ticket_status");
      expect(text).toContain("pending");
    }
  );

  it("does not promise the ticket move to team_build (its session row has no ticket)", () => {
    // Team builds are dispatched ticket-less: the session row carries no
    // epicId, so the MCP token cannot address a ticket and
    // update_ticket_status would 400 with MISSING_TICKET. The prompt must
    // not tell the team agent to make a move it cannot make — but the base
    // tool documentation still applies.
    const text = arijToolsSection("team_build");
    expect(text).not.toContain("You may move the ticket you are building");
    expect(text).toContain("mcp__arij__*");
    expect(text).toContain("update_ticket_status");
  });

  it.each(["review_security", "review_code", "review_compliance", "review_feature"])(
    "adds the submit_findings + Overall Verdict sentence for %s",
    (agentType) => {
      const text = arijToolsSection(agentType);
      expect(text).toContain("submit_findings");
      expect(text).toContain("'**Overall Verdict: …**'");
      expect(text).not.toContain("You may move the ticket you are building");
    },
  );

  it("presents submit_findings as the authoritative channel and the prose line as its fallback", () => {
    const text = arijToolsSection("review_code");

    // The structured channel decides the transition...
    expect(text).toContain(
      "submit_findings is the channel your review is read from"
    );
    expect(text).toContain(
      "a passing verdict moves it to To Merge"
    );
    expect(text).toContain(
      "'changes_requested' sends it back to In Progress"
    );
    // ...prior findings are verified through the same structured channel...
    expect(text).toContain("prior_findings");
    expect(text).toContain("'fixed' resolves it in Arij");
    expect(text).toContain("a finding you do not mention stays open");
    // ...and the prose verdict survives, explicitly as the fallback, because
    // providers without MCP injection have no other channel.
    expect(text).toContain(
      "it is the fallback Arij reads only when no submit_findings verdict was recorded"
    );
  });

  it("tells grading sessions to submit the structured grading report", () => {
    const text = arijToolsSection("grading");
    expect(text).toContain("submit_grading");
    expect(text).toContain("every acceptance criterion");
    expect(text).not.toContain("submit_findings");
    expect(text).not.toContain("You may move the ticket you are building");
  });

  it.each([null, "chat", "merge", "memory_distill"])(
    "keeps the base section for non-review agent type %s",
    (agentType) => {
      const text = arijToolsSection(agentType);
      expect(text).toContain("mcp__arij__*");
      expect(text).not.toContain("submit_findings");
      expect(text).not.toContain("You may move the ticket you are building");
    },
  );

  it("renders the provider's own tool spelling when given a prefix", () => {
    const text = arijToolsSection("build", arijMcpToolPrefix("oh-my-pi"));
    expect(text).toContain("mcp__arij_*");
    // the double-underscore claude spelling must not leak into an omp prompt
    expect(text).not.toContain("mcp__arij__");
  });
});

/**
 * The tools section is APPENDED to the prompt. For an agent whose entire
 * response is written verbatim into a document, that would land after the
 * "respond with the document body and nothing else" contract and end the
 * prompt with ticket-tool guidance — for a session that owns no ticket.
 */
describe("isMcpExemptAgentType", () => {
  it("exempts the memory writers", () => {
    expect(isMcpExemptAgentType("dreaming")).toBe(true);
    expect(isMcpExemptAgentType("memory_distill")).toBe(true);
  });

  it("exempts the ticket-less failure digest report writer", () => {
    expect(isMcpExemptAgentType("failure_digest")).toBe(true);
  });

  it("leaves every ticket-scoped agent on the channel", () => {
    for (const agentType of [
      "build",
      "ticket_build",
      "team_build",
      "review_code",
      "merge",
      "forensic",
      null,
      undefined,
    ]) {
      expect(isMcpExemptAgentType(agentType)).toBe(false);
    }
  });
});

describe("parseMcpToolsEnabledSetting — default ON", () => {
  it.each([
    [JSON.stringify(false), false],
    ["false", false],
    ['"false"', false],
    ["FALSE", false],
    [false, false],
    [JSON.stringify(true), true],
    ["true", true],
    [true, true],
    ["garbage", true],
    ["", true],
    [null, true],
    [undefined, true],
    [42, true],
  ])("parses %j as %s", (value, expected) => {
    expect(parseMcpToolsEnabledSetting(value)).toBe(expected);
  });
});

describe("providerSupportsMcp — contract verdicts", () => {
  it.each([
    ["claude-code", true],
    ["codex", true],
    ["oh-my-pi", true],
    ["pi", false],
    ["gemini-cli", false],
    ["mistral-vibe", false],
    ["qwen-code", false],
    ["opencode", false],
  ])("%s -> %s", (provider, expected) => {
    expect(providerSupportsMcp(provider)).toBe(expected);
  });
});

describe("arijMcpToolPrefix / arijMcpToolName — per-provider spelling", () => {
  it.each([
    ["claude-code", "mcp__arij__"],
    ["codex", "mcp__arij__"],
    ["oh-my-pi", "mcp__arij_"],
  ])("%s spells the prefix %s", (provider, prefix) => {
    expect(arijMcpToolPrefix(provider)).toBe(prefix);
  });

  it("names an omp tool with a single separating underscore", () => {
    expect(arijMcpToolName("oh-my-pi", "get_ticket")).toBe(
      "mcp__arij_get_ticket",
    );
    expect(arijMcpToolName("claude-code", "get_ticket")).toBe(
      "mcp__arij__get_ticket",
    );
  });
});

describe("buildMcpSpawnConfig", () => {
  it("targets the app-root shim via the running node binary and carries the token", () => {
    const config = buildMcpSpawnConfig({ token: TOKEN });
    expect(arijChannelSpec(config).name).toBe(ARIJ_MCP_SERVER_NAME);
    expect(arijChannelSpec(config).command).toBe(process.execPath);
    expect(arijChannelSpec(config).args).toHaveLength(1);
    expect(arijChannelSpec(config).args[0].endsWith("bin/arij-mcp.mjs")).toBe(true);
    expect(arijChannelSpec(config).args[0].startsWith(process.cwd())).toBe(true);
    expect(arijChannelSpec(config).env.ARIJ_MCP_TOKEN).toBe(TOKEN);
    expect(arijChannelSpec(config).env.ARIJ_BASE_URL.length).toBeGreaterThan(0);
    // No agent type named, so the refinement-exclusive tools are withheld.
    expect(config.allowedToolNames).toEqual(allowedToolNamesForAgentType(null));
    expect(config.allowedToolNames).not.toContain("mcp__arij__discard_ticket");
  });

  it("keeps the default (agent) config free of any toolset selector", () => {
    const config = buildMcpSpawnConfig({ token: TOKEN });
    expect("ARIJ_MCP_TOOLSET" in arijChannelSpec(config).env).toBe(false);
    expect(buildMcpSpawnConfig({ token: TOKEN, toolset: "agent" })).toEqual(config);
  });

  it("selects the chat toolset via env and swaps in the chat allowlist", () => {
    const config = buildMcpSpawnConfig({ token: TOKEN, toolset: "chat" });
    expect(arijChannelSpec(config).env.ARIJ_MCP_TOOLSET).toBe("chat");
    expect(arijChannelSpec(config).env.ARIJ_MCP_TOKEN).toBe(TOKEN);
    expect(config.allowedToolNames).toEqual([...ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES]);
    // no agent-only tools leak into the chat allowlist
    expect(config.allowedToolNames).not.toContain("mcp__arij__ask_question");
    expect(config.allowedToolNames).not.toContain("mcp__arij__report_friction");
    expect(config.allowedToolNames).not.toContain("mcp__arij__attach_artifact");
    expect(config.allowedToolNames).not.toContain("mcp__arij__submit_findings");
    expect(config.allowedToolNames).not.toContain("mcp__arij__submit_grading");
  });

  it("spells the allowlist in omp's single-underscore form for oh-my-pi", () => {
    const config = buildMcpSpawnConfig({ token: TOKEN, provider: "oh-my-pi" });
    expect(config.allowedToolNames).toEqual([
      "mcp__arij_get_ticket",
      "mcp__arij_update_ticket_status",
      "mcp__arij_post_comment",
      "mcp__arij_report_friction",
      "mcp__arij_attach_artifact",
      "mcp__arij_create_bug",
      "mcp__arij_ask_question",
      "mcp__arij_submit_findings",
      "mcp__arij_submit_grading",
      "mcp__arij_set_priority",
      "mcp__arij_reorder_tickets",
      "mcp__arij_add_dependency",
      "mcp__arij_remove_dependency",
      "mcp__arij_promote_ticket",
    ]);
    // spelling is the ONLY divergence — server, shim and env are unchanged
    expect(arijChannelSpec(config).env).toEqual(
      arijChannelSpec(buildMcpSpawnConfig({ token: TOKEN })).env,
    );
  });

  it("applies the omp spelling to the chat toolset too", () => {
    const config = buildMcpSpawnConfig({
      token: TOKEN,
      toolset: "chat",
      provider: "oh-my-pi",
    });
    expect(arijChannelSpec(config).env.ARIJ_MCP_TOOLSET).toBe("chat");
    expect(config.allowedToolNames).toContain("mcp__arij_create_ticket");
    expect(config.allowedToolNames).not.toContain("mcp__arij__create_ticket");
  });

  it("keeps an explicit claude-code provider byte-identical to the default", () => {
    expect(buildMcpSpawnConfig({ token: TOKEN, provider: "claude-code" })).toEqual(
      buildMcpSpawnConfig({ token: TOKEN }),
    );
  });
});

describe("chat-toolset spawn configs — provider wiring", () => {
  const chatMcp: McpSpawnConfig = {
    servers: [
      {
        ...sampleArijChannel,
        env: { ...sampleArijChannel.env, ARIJ_MCP_TOOLSET: "chat" },
      },
    ],
    allowedToolNames: [...ARIJ_MCP_CHAT_ALLOWED_TOOL_NAMES],
  };

  it("claude: the toolset selector rides the per-session config file env", () => {
    const filePath = writeMcpConfigFile(chatMcp);
    try {
      const written = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(written.mcpServers.arij.env.ARIJ_MCP_TOOLSET).toBe("chat");
      expect(written.mcpServers.arij.env.ARIJ_MCP_TOKEN).toBe(TOKEN);
    } finally {
      cleanupMcpConfigFile(filePath);
    }
  });

  it("codex: the env override inline table carries all three keys", () => {
    const provider = new CodexProvider();
    const args = provider.buildArgs(
      {
        sessionId: "s1",
        prompt: "PROMPT",
        cwd: "/work",
        mode: "plan",
        mcp: chatMcp,
      },
      { outputFile: "/tmp/codex-out-test.txt" },
    );

    expect(args).toContain(
      `mcp_servers.arij.env={ARIJ_BASE_URL="http://localhost:3000",ARIJ_MCP_TOKEN=${JSON.stringify(TOKEN)},ARIJ_MCP_TOOLSET="chat"}`,
    );
    // the display command still redacts the whole env override
    const command = provider.buildDisplayCommand(args, "PROMPT");
    expect(command).not.toContain(TOKEN);
    expect(command).toContain("mcp_servers.arij.env=<redacted>");
  });
});


it("filters refinement spawn tools by selected actions and preserves all-checked legacy tools", () => {
  const actions = ["dependencies", "merge", "discard"] as const;
  const config = buildMcpSpawnConfig({
    token: "test-token", agentType: "refinement", refinementActions: actions,
  });
  for (const tool of ["post_comment", "promote_ticket", "create_bug", "set_priority",
    "reorder_tickets", "create_planning_ticket"]) {
    expect(config.allowedToolNames).not.toContain(`mcp__arij__${tool}`);
  }
  for (const tool of ["attach_artifact", "get_ticket", "add_dependency",
    "remove_dependency", "merge_tickets", "discard_ticket"]) {
    expect(config.allowedToolNames).toContain(`mcp__arij__${tool}`);
  }
  expect(allowedToolNamesForAgentType("refinement", "claude-code", [
    "grooming", "dependencies", "ordering", "priorities", "readiness",
    "merge", "discard", "create",
  ])).toEqual(allowedToolNamesForAgentType("refinement"));
});
