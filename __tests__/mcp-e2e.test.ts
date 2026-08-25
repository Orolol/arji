/**
 * End-to-end proof that the Arij MCP protocol chain speaks REAL MCP:
 *
 *   buildMcpSpawnConfig() → the actual bin/arij-mcp.mjs child process →
 *   a genuine MCP handshake driven by the OFFICIAL @modelcontextprotocol/sdk
 *   Client over stdio → the shim's HTTP bridge into a stub Arij backend.
 *
 * arij-mcp-shim.test.ts drives the shim with a hand-rolled JSON-RPC client;
 * this file replaces that half of the proof with the official SDK client —
 * the same protocol implementation CLI agents embed — so protocol-version
 * negotiation, capability exchange, initialized notification, and result
 * shape validation are exercised for real instead of simulated.
 *
 * Cross-builder seam locks (each failed silently during the parallel build
 * if only one side changed):
 *   1. The spawn config built by lib/claude/mcp-injection launches THIS shim
 *      (command/args/env round-trip — no independently drifting paths).
 *   2. tools/list names == ARIJ_MCP_ALLOWED_TOOL_NAMES modulo the
 *      mcp__arij__ prefix. The allowlist (injection) and the tool registry
 *      (shim) are declared in two files that cannot import each other; a
 *      sixth tool added on one side only fails here.
 *   3. Every declared tool maps to an existing app/api/mcp/<kebab>/route.ts.
 *   4. The bearer token from the spawn config reaches the backend verbatim
 *      as `Authorization: Bearer <token>`.
 *   5. { data } / { error, code } envelopes round-trip into tool results /
 *      isError tool errors through the real client.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ARIJ_MCP_ALLOWED_TOOL_NAMES,
  ARIJ_MCP_SERVER_NAME,
  buildMcpSpawnConfig,
} from "@/lib/claude/mcp-injection";
import type { McpSpawnConfig } from "@/lib/providers/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TOKEN = "arij-mcp-e2e-bearer-token";

/* ------------------------------------------------------------------ */
/* Stub Arij HTTP backend                                              */
/* ------------------------------------------------------------------ */

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

let httpServer: HttpServer;
let stubBaseUrl: string;
let capturedRequests: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } = {
  status: 200,
  body: { data: null },
};

function startStubServer(): Promise<void> {
  httpServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      capturedRequests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(nextResponse.status, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  return new Promise((resolvePromise) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      stubBaseUrl = `http://127.0.0.1:${port}`;
      resolvePromise();
    });
  });
}

/* ------------------------------------------------------------------ */
/* SDK client plumbing                                                 */
/* ------------------------------------------------------------------ */

/** Minimal view of a tools/call result — keeps the SDK's union types out. */
interface ToolCallOutcome {
  content?: unknown;
  isError?: boolean;
}

let spawnConfig: McpSpawnConfig;
let client: Client;

function firstText(result: ToolCallOutcome): string {
  const content = (result.content ?? []) as Array<{
    type?: string;
    text?: string;
  }>;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  expect(typeof content[0].text).toBe("string");
  return content[0].text as string;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallOutcome> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as ToolCallOutcome;
}

const originalBaseUrlEnv = process.env.ARIJ_BASE_URL;

beforeAll(async () => {
  await startStubServer();

  // getAppBaseUrl() (used by buildMcpSpawnConfig) reads ARIJ_BASE_URL from
  // the server's env — point it at the stub so the config we launch is the
  // one the injection layer would genuinely build for this backend.
  process.env.ARIJ_BASE_URL = stubBaseUrl;
  spawnConfig = buildMcpSpawnConfig({ token: TEST_TOKEN });

  // The declared env block plus a sanitized default environment mirrors how
  // claude/codex launch MCP servers (inherited env + the config's env).
  const transport = new StdioClientTransport({
    command: spawnConfig.command,
    args: spawnConfig.args,
    env: { ...getDefaultEnvironment(), ...spawnConfig.env },
  });

  client = new Client({ name: "arij-mcp-e2e-test", version: "0.0.0" });
  // connect() performs the real MCP handshake: initialize with protocol
  // version negotiation, then the notifications/initialized notification.
  await client.connect(transport);
}, 20000);

afterAll(async () => {
  await client?.close();
  if (originalBaseUrlEnv === undefined) {
    delete process.env.ARIJ_BASE_URL;
  } else {
    process.env.ARIJ_BASE_URL = originalBaseUrlEnv;
  }
  await new Promise<void>((resolvePromise) =>
    httpServer.close(() => resolvePromise())
  );
});

beforeEach(() => {
  capturedRequests = [];
  nextResponse = { status: 200, body: { data: null } };
});

/* ------------------------------------------------------------------ */
/* Injection config → real shim                                        */
/* ------------------------------------------------------------------ */

describe("spawn config seam", () => {
  it("launches the real shim binary with exactly the two contract env vars", () => {
    expect(spawnConfig.command).toBe(process.execPath);
    expect(spawnConfig.args).toHaveLength(1);
    expect(spawnConfig.args[0].endsWith(join("bin", "arij-mcp.mjs"))).toBe(
      true
    );
    expect(existsSync(spawnConfig.args[0])).toBe(true);
    expect(Object.keys(spawnConfig.env).sort()).toEqual([
      "ARIJ_BASE_URL",
      "ARIJ_MCP_TOKEN",
    ]);
    expect(spawnConfig.env.ARIJ_BASE_URL).toBe(stubBaseUrl);
    expect(spawnConfig.env.ARIJ_MCP_TOKEN).toBe(TEST_TOKEN);
  });
});

/* ------------------------------------------------------------------ */
/* Handshake + registry                                                */
/* ------------------------------------------------------------------ */

describe("MCP handshake via the official SDK client", () => {
  it("negotiates and identifies the arij server with tools capability", () => {
    // connect() resolving at all proves initialize/initialized round-tripped
    // with a protocol version both sides accept.
    expect(client.getServerVersion()?.name).toBe("arij");
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it("tools/list matches the injection allowlist name-for-name", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    // The seam lock: shim registry (bin/arij-mcp.mjs TOOLS) and injection
    // allowlist (ARIJ_MCP_ALLOWED_TOOL_NAMES) are maintained independently.
    expect(
      names.map((name) => `mcp__${ARIJ_MCP_SERVER_NAME}__${name}`).sort()
    ).toEqual([...ARIJ_MCP_ALLOWED_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect((tool.description ?? "").length).toBeGreaterThan(20);
    }
  });

  it("every declared tool bridges to an existing app/api/mcp route file", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const kebab = tool.name.replace(/_/g, "-");
      const routeFile = join(REPO_ROOT, "app", "api", "mcp", kebab, "route.ts");
      expect(existsSync(routeFile), `${tool.name} → ${routeFile}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* tools/call round-trips for every tool                               */
/* ------------------------------------------------------------------ */

const CALL_MATRIX: ReadonlyArray<{
  tool: string;
  args: Record<string, unknown>;
  data: unknown;
}> = [
  {
    tool: "get_ticket",
    args: {},
    data: {
      ticket: { id: "T-1", title: "Ship MCP", status: "in_progress" },
      userStories: [],
      comments: [],
      reviewFindings: [],
    },
  },
  {
    tool: "update_ticket_status",
    args: { status: "review", reason: "Implementation complete" },
    data: { ticketId: "T-1", fromStatus: "in_progress", toStatus: "review" },
  },
  {
    tool: "post_comment",
    args: { body: "Wired the token store into the classifier." },
    data: { commentId: "comment-1" },
  },
  {
    tool: "attach_artifact",
    args: {
      path: "screenshots/result.png",
      caption: "Rendered result after the change",
    },
    data: {
      artifact: { id: "artifact-1", filename: "artifact-1.png" },
    },
  },
  {
    tool: "create_bug",
    args: {
      title: "Board refresh drops ticket moves",
      description: "Observed after a reconnect; the card stays in the old column.",
      severity: "high",
    },
    data: {
      bug: {
        id: "bug-1",
        readable_id: "B-arij-101",
        title: "Board refresh drops ticket moves",
        status: "backlog",
        type: "bug",
        priority: 2,
      },
    },
  },
  {
    tool: "ask_question",
    args: { question: "Should retries be capped at 3 or configurable?" },
    data: { acknowledged: true, holds_ticket: true },
  },
  {
    tool: "submit_findings",
    args: {
      verdict: "changes_requested",
      summary: "One blocking issue.",
      findings: [
        {
          file_path: "lib/mcp/token-store.ts",
          line: 42,
          body: "TTL purge skips revoked records",
          severity: "major",
        },
      ],
    },
    data: { findingIds: ["finding-1"], commentId: "comment-2" },
  },
];

describe("tools/call → authed HTTP bridge → result round-trip", () => {
  it.each(CALL_MATRIX)(
    "$tool POSTs an authed, verbatim body and returns the data envelope",
    async ({ tool, args, data }) => {
      nextResponse = { status: 200, body: { data } };

      const result = await callTool(tool, args);

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toEqual(data);

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0]).toMatchObject({
        method: "POST",
        url: `/api/mcp/${tool.replace(/_/g, "-")}`,
        authorization: `Bearer ${TEST_TOKEN}`,
        contentType: "application/json",
      });
      expect(capturedRequests[0].body).toEqual(args);
    }
  );

  it("maps a { error, code } backend envelope to an isError tool result", async () => {
    nextResponse = {
      status: 409,
      body: {
        error: "Cannot move to Done: manual approval is required.",
        code: "INVALID_TRANSITION",
      },
    };

    const result = await callTool("update_ticket_status", { status: "done" });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      "Error (INVALID_TRANSITION): Cannot move to Done: manual approval is required."
    );
  });

  it("maps the http-auth 401 envelope to an isError result with its code", async () => {
    nextResponse = {
      status: 401,
      body: { error: "Invalid or expired MCP token", code: "UNAUTHORIZED" },
    };

    const result = await callTool("get_ticket", {});

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      "Error (UNAUTHORIZED): Invalid or expired MCP token"
    );
  });

  it("rejects unknown tools shim-side and keeps the protocol alive", async () => {
    const result = await callTool("definitely_not_a_tool", {});

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("UNKNOWN_TOOL");
    expect(capturedRequests).toHaveLength(0);

    // The connection survived the bad call — the registry still answers.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(ARIJ_MCP_ALLOWED_TOOL_NAMES.length);
  });
});
