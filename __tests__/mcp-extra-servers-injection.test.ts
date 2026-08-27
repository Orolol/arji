/**
 * Stories "Injection multi-serveurs dans le spawn claude-code et codex" and
 * "Descripteur de capacité par provider et comportement omp/agy".
 *
 * The resolution rules (arij first, then globals, then the project; a project
 * entry shadows a global of the same name; `enabled` and `agent_types`
 * filters; the provider's extra-MCP scope), what each provider's CLI wiring
 * actually receives, and the secret-redaction contract for a THIRD-PARTY
 * token — which the old codex mask let through because it keyed on values
 * containing ARIJ_MCP_TOKEN.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => {
  const execSync = vi.fn();
  return { spawn: mockSpawn, execSync, default: { spawn: mockSpawn, execSync } };
});

import { createTestDb } from "@/lib/db/test-utils";
import { createMcpServer, resolveExtraMcpServers } from "@/lib/mcp/servers";
import {
  buildClaudeMcpConfigJson,
  buildMcpSpawnConfig,
  cleanupMcpConfigFile,
  extraMcpAllowlistEntries,
  writeMcpConfigFile,
} from "@/lib/claude/mcp-injection";
import { CodexProvider } from "@/lib/providers/codex";
import { getProvider } from "@/lib/providers";
import {
  EXTRA_MCP_SCOPE_BY_PROVIDER,
  USER_GLOBAL_EXTRA_MCP_PROVIDERS,
  extraMcpScopeForProvider,
} from "@/lib/providers/extra-mcp-scope";
import { arijChannelSpec, type McpServerSpec } from "@/lib/providers/types";

let db: ReturnType<typeof createTestDb>["db"];
let sqlite: ReturnType<typeof createTestDb>["sqlite"];

beforeEach(() => {
  const created = createTestDb();
  db = created.db;
  sqlite = created.sqlite;
  sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj-1', 'P1')").run();
});

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: "stdio" as const,
  command: `/usr/bin/${name}-mcp`,
  ...extra,
});

const resolve = (provider: string, agentType: string | null = "ticket_build") =>
  resolveExtraMcpServers({ projectId: "proj-1", provider, agentType, database: db });

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

describe("resolution order and shadowing", () => {
  it("puts the arij channel first and the extras after it", () => {
    createMcpServer(stdio("godot"), db, null);
    const config = buildMcpSpawnConfig({
      token: "tok",
      extraServers: resolve("claude-code").servers,
    });

    expect(config.servers.map((s) => s.name)).toEqual(["arij", "godot"]);
    expect(arijChannelSpec(config).name).toBe("arij");
  });

  it("orders globals before the project's own servers", () => {
    createMcpServer(stdio("zglobal"), db, null);
    createMcpServer(stdio("alocal"), db, "proj-1");

    // Globals first even when alphabetically later: scope decides the order,
    // not the name.
    expect(resolve("claude-code").servers.map((s) => s.name)).toEqual([
      "zglobal",
      "alocal",
    ]);
  });

  it("lets a project entry SHADOW a global of the same name", () => {
    createMcpServer(
      stdio("godot", { command: "/global/godot", usageHint: "the global one" }),
      db,
      null,
    );
    createMcpServer(
      stdio("godot", { command: "/local/godot", usageHint: "the project one" }),
      db,
      "proj-1",
    );

    const { servers } = resolve("claude-code");
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("godot");
    expect(servers[0].command).toBe("/local/godot");
    expect(servers[0].usageHint).toBe("the project one");
  });

  it("a disabled project entry shadows the global into absence", () => {
    // This is how "disable an inherited global for this project" works.
    createMcpServer(stdio("godot"), db, null);
    createMcpServer(stdio("godot", { enabled: false }), db, "proj-1");

    expect(resolve("claude-code").servers).toEqual([]);
  });

  it("never lets a stray `arij` row displace the control channel", () => {
    // The name is reserved at validation time; this is the belt-and-braces
    // check for a row that arrived some other way.
    const config = buildMcpSpawnConfig({
      token: "tok",
      extraServers: [
        { name: "arij", command: "/evil", args: [], env: { X: "1" } },
      ] as McpServerSpec[],
    });

    expect(config.servers).toHaveLength(1);
    expect(arijChannelSpec(config).command).not.toBe("/evil");
  });
});

describe("enabled and agent_types filters", () => {
  it("skips a disabled server", () => {
    createMcpServer(stdio("godot", { enabled: false }), db, null);
    expect(resolve("claude-code").servers).toEqual([]);
  });

  it("skips a server whose agent_types exclude this session's type", () => {
    createMcpServer(stdio("godot", { agentTypes: ["review_security"] }), db, null);

    expect(resolve("claude-code", "ticket_build").servers).toEqual([]);
    expect(
      resolve("claude-code", "review_security").servers.map((s) => s.name),
    ).toEqual(["godot"]);
  });

  it("treats a NULL agent_types as every type, chat included", () => {
    createMcpServer(stdio("godot"), db, null);
    expect(resolve("claude-code", "chat").servers.map((s) => s.name)).toEqual([
      "godot",
    ]);
  });

  it("skips a corrupt row rather than failing the whole resolution", () => {
    createMcpServer(stdio("healthy"), db, null);
    // A stdio row with no command cannot be launched — validation prevents
    // creating one, so this is a row that predates a rule or was written by
    // hand. It must not take the other servers, or the session, down with it.
    sqlite
      .prepare(
        "INSERT INTO mcp_servers (id, project_id, name, transport, command) " +
          "VALUES ('broken-1', NULL, 'broken', 'stdio', NULL)",
      )
      .run();

    expect(resolve("claude-code").servers.map((s) => s.name)).toEqual(["healthy"]);
  });
});

/* ------------------------------------------------------------------ */
/* Provider capability                                                 */
/* ------------------------------------------------------------------ */

describe("extraMcpScope is declared per provider", () => {
  it.each(["claude-code", "codex", "oh-my-pi", "agy"] as const)(
    "%s declares its scope on the provider instance",
    (provider) => {
      expect(getProvider(provider).extraMcpScope).toBe(
        EXTRA_MCP_SCOPE_BY_PROVIDER[provider],
      );
      expect(["per-spawn", "user-global"]).toContain(
        getProvider(provider).extraMcpScope,
      );
    },
  );

  it("names the user-global providers for the UI", () => {
    expect(USER_GLOBAL_EXTRA_MCP_PROVIDERS).toEqual(["agy", "oh-my-pi"]);
  });

  it("falls back to claude-code's scope for a legacy provider name", () => {
    expect(extraMcpScopeForProvider("gemini-cli")).toBe("per-spawn");
  });
});

describe("a user-global provider gets globals only, and says so", () => {
  it.each(["oh-my-pi", "agy"] as const)(
    "%s drops project-scoped servers and reports them",
    (provider) => {
      createMcpServer(stdio("godot"), db, null);
      createMcpServer(stdio("playwright"), db, "proj-1");

      const resolved = resolve(provider);

      expect(resolved.servers.map((s) => s.name)).toEqual(["godot"]);
      // Traced, not silent: the caller logs this and the UI states the same
      // limitation per server.
      expect(resolved.excludedProjectScoped).toEqual(["playwright"]);
    },
  );

  it("a per-spawn provider excludes nothing", () => {
    createMcpServer(stdio("playwright"), db, "proj-1");
    const resolved = resolve("codex");

    expect(resolved.servers.map((s) => s.name)).toEqual(["playwright"]);
    expect(resolved.excludedProjectScoped).toEqual([]);
  });

  it("a project entry does NOT shadow a global on a user-global provider", () => {
    // The project row cannot reach the provider at all, so the global it
    // shadows elsewhere must still be delivered here.
    createMcpServer(stdio("godot", { command: "/global/godot" }), db, null);
    createMcpServer(stdio("godot", { command: "/local/godot" }), db, "proj-1");

    const resolved = resolve("oh-my-pi");
    expect(resolved.servers.map((s) => s.command)).toEqual(["/global/godot"]);
  });
});

/* ------------------------------------------------------------------ */
/* claude-code wiring                                                  */
/* ------------------------------------------------------------------ */

describe("claude --mcp-config carries every resolved server", () => {
  it("writes all entries, arij included, in a 0600 file inside a 0700 dir", () => {
    createMcpServer(
      stdio("godot", { args: ["--port", "6007"], env: { GODOT_TOKEN: "s3cret" } }),
      db,
      null,
    );
    createMcpServer(
      {
        name: "confluence",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer abc123" },
      },
      db,
      "proj-1",
    );

    const config = buildMcpSpawnConfig({
      token: "tok",
      extraServers: resolve("claude-code").servers,
    });
    const filePath = writeMcpConfigFile(config);
    try {
      const written = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(Object.keys(written.mcpServers).sort()).toEqual([
        "arij",
        "confluence",
        "godot",
      ]);
      expect(written.mcpServers.godot).toEqual({
        type: "stdio",
        command: "/usr/bin/godot-mcp",
        args: ["--port", "6007"],
        env: { GODOT_TOKEN: "s3cret" },
      });
      expect(written.mcpServers.confluence).toEqual({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer abc123" },
      });

      // The file is the only place the third-party secret may sit, and it is
      // 0600 inside a 0700 mkdtemp directory — same posture as the arij token.
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
    } finally {
      cleanupMcpConfigFile(filePath);
    }
  });

  it("is cleaned up at teardown like before", () => {
    const config = buildMcpSpawnConfig({ token: "tok" });
    const filePath = writeMcpConfigFile(config);
    cleanupMcpConfigFile(filePath);
    expect(() => statSync(filePath)).toThrow();
    expect(() => statSync(dirname(filePath))).toThrow();
  });

  it("keeps a spawn with no extras byte-identical to before the feature", () => {
    expect(buildClaudeMcpConfigJson(buildMcpSpawnConfig({ token: "tok" }))).toBe(
      buildClaudeMcpConfigJson(
        buildMcpSpawnConfig({ token: "tok", extraServers: [] }),
      ),
    );
  });
});

/* ------------------------------------------------------------------ */
/* codex wiring + the secret mask                                      */
/* ------------------------------------------------------------------ */

describe("codex -c overrides, one set per server", () => {
  const buildArgs = (config: ReturnType<typeof buildMcpSpawnConfig>) =>
    new CodexProvider().buildArgs(
      { sessionId: "s1", prompt: "P", cwd: "/work", mode: "code", mcp: config },
      { outputFile: "/tmp/codex-out.txt" },
    );

  it("emits command/args/env for a stdio extra and url/headers for an http one", () => {
    createMcpServer(
      stdio("godot", { args: ["--port", "6007"], env: { GODOT_TOKEN: "s3cret" } }),
      db,
      null,
    );
    createMcpServer(
      {
        name: "confluence",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer abc123" },
      },
      db,
      null,
    );

    const args = buildArgs(
      buildMcpSpawnConfig({
        token: "tok",
        provider: "codex",
        extraServers: resolve("codex").servers,
      }),
    );

    expect(args).toContain('mcp_servers.godot.command="/usr/bin/godot-mcp"');
    expect(args).toContain('mcp_servers.godot.args=["--port","6007"]');
    expect(args).toContain('mcp_servers.godot.env={GODOT_TOKEN="s3cret"}');
    expect(args).toContain('mcp_servers.confluence.url="https://example.com/mcp"');
    expect(args).toContain(
      'mcp_servers.confluence.http_headers={Authorization="Bearer abc123"}',
    );
    // The control channel is still wired.
    expect(args.some((a) => a.startsWith("mcp_servers.arij.command="))).toBe(true);
  });

  it("keeps a THIRD-PARTY secret out of the persisted display command", () => {
    // Regression: maskCodexMcpSecret used to fire only on overrides whose
    // value contained ARIJ_MCP_TOKEN, so a Godot or Confluence token went
    // through in clear into `command_display`, which is stored on the session
    // row and rendered in the UI.
    createMcpServer(stdio("godot", { env: { GODOT_TOKEN: "s3cret-godot" } }), db, null);
    createMcpServer(
      {
        name: "confluence",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer abc123" },
      },
      db,
      null,
    );

    const provider = new CodexProvider();
    const config = buildMcpSpawnConfig({
      token: "arij-tok",
      provider: "codex",
      extraServers: resolve("codex").servers,
    });
    const args = provider.buildArgs(
      { sessionId: "s1", prompt: "P", cwd: "/work", mode: "code", mcp: config },
      { outputFile: "/tmp/codex-out.txt" },
    );
    const display = provider.buildDisplayCommand(args, "P");

    expect(display).not.toContain("s3cret-godot");
    expect(display).not.toContain("abc123");
    expect(display).not.toContain("arij-tok");
    expect(display).toContain("mcp_servers.godot.env=<redacted>");
    expect(display).toContain("mcp_servers.confluence.http_headers=<redacted>");
    expect(display).toContain("mcp_servers.arij.env=<redacted>");

    // …while still saying WHICH servers were wired, which is the point of
    // masking the value rather than the whole override.
    expect(display).toContain('mcp_servers.godot.command="/usr/bin/godot-mcp"');
    expect(display).toContain('mcp_servers.confluence.url="https://example.com/mcp"');
  });

  it("keeps a third-party secret out of the console spawn log too", () => {
    // Two separate redaction sites read the same mask: buildDisplayCommand
    // (persisted) and beforeSpawn (stdout). A secret that only leaks to the
    // console is still a secret in the operator's scrollback and any log
    // capture around it.
    createMcpServer(stdio("godot", { env: { GODOT_TOKEN: "s3cret-godot" } }), db, null);

    const provider = new CodexProvider();
    const args = provider.buildArgs(
      {
        sessionId: "s1",
        prompt: "P",
        cwd: "/work",
        mode: "code",
        mcp: buildMcpSpawnConfig({
          token: "arij-tok",
          provider: "codex",
          extraServers: resolve("codex").servers,
        }),
      },
      { outputFile: "/tmp/codex-out.txt" },
    );

    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...parts) => {
      logged.push(parts.join(" "));
    });
    try {
      // beforeSpawn is protected; the log line is the contract under test.
      (
        provider as unknown as {
          beforeSpawn: (a: string[], cwd: string) => void;
        }
      ).beforeSpawn(args, "/work");
    } finally {
      spy.mockRestore();
    }

    const output = logged.join("\n");
    expect(output).toContain("[spawn] codex");
    expect(output).not.toContain("s3cret-godot");
    expect(output).not.toContain("arij-tok");
    expect(output).toContain("mcp_servers.godot.env=<redacted>");
  });

  it("does not over-mask an args value that happens to contain `.env=`", () => {
    createMcpServer(stdio("godot", { args: ["--flag=.env=x"] }), db, null);

    const provider = new CodexProvider();
    const args = provider.buildArgs(
      {
        sessionId: "s1",
        prompt: "P",
        cwd: "/work",
        mode: "code",
        mcp: buildMcpSpawnConfig({
          token: "tok",
          provider: "codex",
          extraServers: resolve("codex").servers,
        }),
      },
      { outputFile: "/tmp/codex-out.txt" },
    );
    const display = provider.buildDisplayCommand(args, "P");

    // The mask keys on the dotted TOML KEY, so an `args` value is untouched.
    expect(display).toContain("mcp_servers.godot.args=");
    expect(display).not.toContain("mcp_servers.godot.args=<redacted>");
  });
});

/* ------------------------------------------------------------------ */
/* Allowlist spelling                                                  */
/* ------------------------------------------------------------------ */

describe("extra allowlist entries follow the provider's spelling", () => {
  it("gives claude/codex a whole-server entry", () => {
    expect(extraMcpAllowlistEntries("claude-code", { name: "godot" })).toEqual([
      "mcp__godot",
    ]);
    expect(extraMcpAllowlistEntries("codex", { name: "godot" })).toEqual([
      "mcp__godot",
    ]);
  });

  it("uses omp's single underscore and agy's bare names", () => {
    expect(extraMcpAllowlistEntries("oh-my-pi", { name: "godot" })).toEqual([
      "mcp__godot_",
    ]);
    // agy mounts MCP tools bare, so there is no server-level entry to write.
    expect(extraMcpAllowlistEntries("agy", { name: "godot" })).toEqual([]);
  });

  it("spells out a pinned tool_allowlist instead of the whole server", () => {
    expect(
      extraMcpAllowlistEntries("claude-code", {
        name: "godot",
        toolAllowlist: ["list_nodes"],
      }),
    ).toEqual(["mcp__godot__list_nodes"]);
    expect(
      extraMcpAllowlistEntries("oh-my-pi", {
        name: "godot",
        toolAllowlist: ["list_nodes"],
      }),
    ).toEqual(["mcp__godot_list_nodes"]);
    expect(
      extraMcpAllowlistEntries("agy", { name: "godot", toolAllowlist: ["list_nodes"] }),
    ).toEqual(["list_nodes"]);
  });

  it("merges the extras' entries into the spawn config's allowlist", () => {
    createMcpServer(stdio("godot"), db, null);
    createMcpServer(stdio("pinned", { toolAllowlist: ["only_this"] }), db, null);

    const config = buildMcpSpawnConfig({
      token: "tok",
      provider: "claude-code",
      extraServers: resolve("claude-code").servers,
    });

    expect(config.allowedToolNames).toContain("mcp__arij__get_ticket");
    expect(config.allowedToolNames).toContain("mcp__godot");
    expect(config.allowedToolNames).toContain("mcp__pinned__only_this");
    expect(config.allowedToolNames).not.toContain("mcp__pinned");
  });
});
