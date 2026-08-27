/**
 * Story "Test de connexion et remontée de l'état de santé".
 *
 * The probe runs a REAL MCP handshake against a real child process — a stub
 * would not tell us whether `initialize` + `tools/list` actually work, which is
 * the whole question the feature answers. The fixture server is a few lines of
 * node speaking JSON-RPC over stdio.
 *
 * The load-bearing properties are the negative ones: bounded by a timeout, no
 * orphan process left behind, no secret in the returned message, and — most
 * importantly — a broken third-party server never stops a session from
 * starting, because health is recorded rather than enforced.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { createTestDb } from "@/lib/db/test-utils";
import { createMcpServer, resolveExtraMcpServers } from "@/lib/mcp/servers";
import { buildMcpSpawnConfig } from "@/lib/claude/mcp-injection";
import { probeMcpServer, scrubSecrets } from "@/lib/mcp/probe";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-mcp-probe-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A minimal stdio MCP server: newline-delimited JSON-RPC answering
 * `initialize` and `tools/list`. `mode` picks the misbehaviour to exercise.
 */
function writeFixtureServer(
  mode: "ok" | "silent" | "crash",
  toolNames: string[] = ["list_nodes", "run_scene"],
): string {
  const file = path.join(tempDir, `server-${mode}.mjs`);
  fs.writeFileSync(
    file,
    `
const MODE = ${JSON.stringify(mode)};
const TOOLS = ${JSON.stringify(toolNames)};
if (MODE === "crash") {
  // Echo the environment first: a real broken server often does, which is why
  // the probe scrubs its own configured values out of the error.
  process.stderr.write("failed to start with " + JSON.stringify(process.env.GODOT_TOKEN ?? "") + "\\n");
  process.exit(3);
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "notifications/initialized") continue;
    if (MODE === "silent") continue;
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: TOOLS.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object" },
        })),
      };
    } else {
      result = {};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    "utf-8",
  );
  return file;
}

const stdioSpec = (command: string, extra: Record<string, unknown> = {}) => ({
  name: "godot",
  command: process.execPath,
  args: [command],
  env: {},
  ...extra,
});

describe("probeMcpServer — a reachable server", () => {
  it("reports the tool count and names", async () => {
    const result = await probeMcpServer(stdioSpec(writeFixtureServer("ok")));

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.toolCount).toBe(2);
    expect(result.toolNames).toEqual(["list_nodes", "run_scene"]);
  });

  it("reports a server that starts but exposes nothing", async () => {
    // Broken in the way that matters: it answers, but a session would get no
    // tools out of it.
    const result = await probeMcpServer(stdioSpec(writeFixtureServer("ok", [])));

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(0);
    expect(result.toolNames).toEqual([]);
  });
});

describe("probeMcpServer — a broken server", () => {
  it("returns a readable error instead of throwing", async () => {
    const result = await probeMcpServer(
      stdioSpec("/nonexistent/definitely-not-a-server.mjs"),
    );

    expect(result.ok).toBe(false);
    expect(result.toolCount).toBe(0);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("is bounded by a timeout and leaves no orphan process", async () => {
    const before = childProcessCount();

    const started = Date.now();
    const result = await probeMcpServer(
      stdioSpec(writeFixtureServer("silent")),
      1200,
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(elapsed).toBeLessThan(8000);

    // close() kills the stdio child, so a server that hung during the
    // handshake does not outlive the request that started it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(childProcessCount()).toBeLessThanOrEqual(before);
  }, 20000);

  it("keeps configured secrets out of the returned error", async () => {
    const result = await probeMcpServer(
      stdioSpec(writeFixtureServer("crash"), {
        env: { GODOT_TOKEN: "s3cret-godot-value" },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("s3cret-godot-value");
  });
});

describe("scrubSecrets", () => {
  it("replaces every occurrence of a configured value", () => {
    expect(scrubSecrets("auth=abc123 retry auth=abc123", ["abc123"])).toBe(
      "auth=<redacted> retry auth=<redacted>",
    );
  });

  it("leaves short values alone — those are not credentials", () => {
    // Scrubbing "1" or "on" would redact half of every error message.
    expect(scrubSecrets("port 80 is closed", ["80"])).toBe("port 80 is closed");
  });
});

describe("a broken third-party server never blocks a session", () => {
  it("still resolves and injects it, so the spawn proceeds", () => {
    const { db, sqlite } = createTestDb();
    sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj-1', 'P1')").run();

    createMcpServer(
      {
        name: "godot",
        transport: "stdio",
        command: "/nonexistent/definitely-not-a-server",
      },
      db,
      null,
    );

    // Health is RECORDED, not enforced: resolution does not contact the server,
    // so an unreachable one costs the session that server's tools and nothing
    // else. Gating the spawn on reachability would let a third party's downtime
    // stop a build.
    const resolved = resolveExtraMcpServers({
      projectId: "proj-1",
      provider: "claude-code",
      agentType: "ticket_build",
      database: db,
    });
    expect(resolved.servers.map((s) => s.name)).toEqual(["godot"]);

    const config = buildMcpSpawnConfig({
      token: "tok",
      extraServers: resolved.servers,
    });
    // The arij control channel is intact regardless.
    expect(config.servers[0].name).toBe("arij");
    expect(config.servers.map((s) => s.name)).toEqual(["arij", "godot"]);

    sqlite.close();
  });
});

/** Rough count of this user's node children, for the orphan check. */
function childProcessCount(): number {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-u", String(process.getuid?.() ?? 0)], {
      encoding: "utf-8",
    });
    return out
      .split("\n")
      .filter((line) => line.trim() === String(process.pid)).length;
  } catch {
    return 0;
  }
}
