/**
 * End-to-end tests for bin/arij-mcp.mjs — the stdio MCP shim.
 *
 * Spawns the real shim as a child process (exactly how a CLI agent's MCP
 * client would) and drives the JSON-RPC handshake over stdio:
 * initialize → notifications/initialized → tools/list → tools/call, against a
 * stub node:http backend standing in for the Arij server. Asserts the bearer
 * header, the agent-tool registry shape, kebab-case endpoint mapping, and the
 * error → isError tool-result mapping (never a protocol crash).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SHIM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "arij-mcp.mjs"
);

const EXPECTED_TOOL_NAMES = [
  "get_ticket",
  "update_ticket_status",
  "post_comment",
  "report_friction",
  "attach_artifact",
  "create_bug",
  "ask_question",
  "submit_findings",
  "submit_grading",
  "set_priority",
  "reorder_tickets",
  "add_dependency",
  "remove_dependency",
  "promote_ticket",
  "merge_tickets",
  "discard_ticket",
  "create_planning_ticket",
];

/**
 * PRIORITY_LABELS in lib/types/kanban.ts. The shim is plain .mjs and cannot
 * import it, so the scale is duplicated in the tool description — and that
 * string is the agent's only semantic anchor, since the board snapshot
 * renders bare numbers. An off-by-one there silently inflates every priority
 * the agent sets.
 */
const PRIORITY_SCALE_TEXT = "0 low, 1 medium, 2 high, 3 critical";

const EXPECTED_CHAT_TOOL_NAMES = [
  "list_tickets",
  "get_ticket",
  "create_ticket",
  "update_ticket",
  "update_ticket_status",
  "post_comment",
  "get_agent_status",
  "start_build",
];

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/* ------------------------------------------------------------------ */
/* Stub Arij HTTP backend                                              */
/* ------------------------------------------------------------------ */

let httpServer: HttpServer;
let baseUrl: string;
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
      res.writeHead(nextResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  return new Promise((resolvePromise) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolvePromise();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Minimal JSON-RPC stdio client                                       */
/* ------------------------------------------------------------------ */

class McpStdioClient {
  readonly child: ChildProcess;
  stderr = "";
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (err: Error) => void }
  >();

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [SHIM_PATH], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) {
          entry.reject(
            new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`)
          );
        } else {
          entry.resolve(message.result);
        }
      }
    }
  }

  request(method: string, params?: unknown, timeoutMs = 10000): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise<any>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for ${method} response`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        },
      });
    });
    this.child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize(): Promise<any> {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "arij-shim-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  callTool(name: string, args: unknown): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }

  kill(): void {
    this.child.kill();
  }
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

let client: McpStdioClient;
let initResult: any;

beforeAll(async () => {
  await startStubServer();
  client = new McpStdioClient({
    ...process.env,
    ARIJ_BASE_URL: baseUrl,
    ARIJ_MCP_TOKEN: "test-token",
  });
  initResult = await client.initialize();
}, 20000);

afterAll(async () => {
  client?.kill();
  await new Promise<void>((resolvePromise) =>
    httpServer.close(() => resolvePromise())
  );
});

beforeEach(() => {
  capturedRequests = [];
  nextResponse = { status: 200, body: { data: null } };
});

describe("startup", () => {
  it("exits 1 with a stderr message when env vars are missing", async () => {
    const env = { ...process.env };
    delete env.ARIJ_BASE_URL;
    delete env.ARIJ_MCP_TOKEN;

    const child = spawn(process.execPath, [SHIM_PATH], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = (await once(child, "exit")) as [number | null];

    expect(code).toBe(1);
    expect(stderr).toContain("ARIJ_BASE_URL");
    expect(stderr).toContain("ARIJ_MCP_TOKEN");
  }, 15000);

  it("exits 1 when ARIJ_MCP_TOKEN is an unexpanded ${…} placeholder", async () => {
    // Hosts that interpolate their MCP config leave an UNRESOLVED ${VAR} as a
    // literal string rather than an empty one — measured on omp 18.0.5, whose
    // ~/.omp/agent/mcp.json entry carries "ARIJ_MCP_TOKEN": "${ARIJ_MCP_TOKEN}".
    // A literal placeholder is non-empty, so without this guard the shim starts,
    // the CLI mounts the whole Arij toolset, and every call comes back
    // "UNAUTHORIZED: Invalid or expired MCP token". Treat it as no token at all.
    const env = {
      ...process.env,
      // what omp's `${ARIJ_BASE_URL:-http://localhost:3000}` expands to
      ARIJ_BASE_URL: "http://localhost:3000",
      ARIJ_MCP_TOKEN: "${ARIJ_MCP_TOKEN}",
    };

    const child = spawn(process.execPath, [SHIM_PATH], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = (await once(child, "exit")) as [number | null];

    expect(code).toBe(1);
    expect(stderr).toContain("ARIJ_MCP_TOKEN");
  }, 15000);

  it("identifies itself as the 'arij' server with tools capability", () => {
    expect(initResult.serverInfo.name).toBe("arij");
    expect(initResult.capabilities.tools).toBeDefined();
  });
});

describe("tools/list", () => {
  it("documents the board's real priority scale on set_priority", async () => {
    const result = await client.request("tools/list", {});
    const tool: any = result.tools.find(
      (t: any) => t.name === "set_priority"
    );
    expect(tool).toBeDefined();

    for (const text of [
      tool.description,
      tool.inputSchema.properties.priority.description,
    ]) {
      expect(text.toLowerCase()).toContain(PRIORITY_SCALE_TEXT);
      // The old, wrong scale started at "none" and topped out at "high", so
      // every medium/high judgement landed one notch too high on the board.
      expect(text.toLowerCase()).not.toContain("0 none");
    }
  });

  it("declares exactly the Arij agent tools, in order, with schemas", async () => {
    const result = await client.request("tools/list", {});

    const byName = new Map(result.tools.map((tool: any) => [tool.name, tool]));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      EXPECTED_TOOL_NAMES
    );
    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }

    const updateStatus: any = byName.get("update_ticket_status");
    expect(updateStatus.inputSchema.properties.status.enum).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "review",
    ]); // to_merge comes from the review verdict, done from the merge, and
    // "released" is system-only — none of the three may be offered
    expect(updateStatus.inputSchema.required).toEqual(["status"]);

    const submitFindings: any = byName.get("submit_findings");
    expect(submitFindings.inputSchema.required).toEqual([
      "verdict",
      "summary",
      "findings",
    ]); // prior_findings stays optional — a first review cycle has none
    expect(submitFindings.inputSchema.properties.findings.maxItems).toBe(50);
    expect(
      submitFindings.inputSchema.properties.findings.items.required
    ).toEqual(["file_path", "line", "body", "severity"]);
    expect(
      submitFindings.inputSchema.properties.prior_findings.maxItems
    ).toBe(100);
    expect(
      submitFindings.inputSchema.properties.prior_findings.items.required
    ).toEqual(["id", "status"]);
    expect(
      submitFindings.inputSchema.properties.prior_findings.items.properties
        .status.enum
    ).toEqual(["fixed", "still_open"]);

    const submitGrading: any = byName.get("submit_grading");
    expect(submitGrading.inputSchema.required).toEqual([
      "gradings",
      "summary",
    ]);
    expect(submitGrading.inputSchema.properties.gradings.minItems).toBe(1);
    expect(submitGrading.inputSchema.properties.gradings.maxItems).toBe(100);
    expect(
      submitGrading.inputSchema.properties.gradings.items.required
    ).toEqual(["storyId", "criterion", "status", "evidence"]);
    expect(
      submitGrading.inputSchema.properties.gradings.items.properties.status.enum
    ).toEqual(["met", "partial", "missed"]);

    const reportFriction: any = byName.get("report_friction");
    expect(reportFriction.inputSchema.required).toEqual([
      "category",
      "description",
    ]);
    expect(reportFriction.inputSchema.properties.category.enum).toEqual([
      "broken_tooling",
      "misleading_docs",
      "flaky_test",
      "unclear_convention",
      "other",
    ]);
    expect(reportFriction.inputSchema.properties.filePath.type).toBe("string");

    const attachArtifact: any = byName.get("attach_artifact");
    expect(attachArtifact.inputSchema.required).toEqual(["path", "caption"]);
    expect(attachArtifact.inputSchema.properties.caption.maxLength).toBe(2000);

    const getTicket: any = byName.get("get_ticket");
    expect(getTicket.inputSchema.properties.ticket_id.type).toBe("string");
  });
});

describe("tools/call → HTTP bridge", () => {
  it("POSTs to the kebab-case endpoint with bearer auth and returns data as text", async () => {
    nextResponse = {
      status: 200,
      body: { data: { ticket: { id: "T-1", status: "in_progress" } } },
    };

    const result = await client.callTool("get_ticket", {});

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({
      ticket: { id: "T-1", status: "in_progress" },
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      method: "POST",
      url: "/api/mcp/get-ticket",
      authorization: "Bearer test-token",
      contentType: "application/json",
      body: {},
    });
  });

  it("maps tool-name underscores to endpoint dashes and forwards args verbatim", async () => {
    nextResponse = {
      status: 200,
      body: { data: { ticketId: "T-1", fromStatus: "in_progress", toStatus: "review" } },
    };

    await client.callTool("update_ticket_status", {
      status: "review",
      reason: "Implementation complete",
    });

    expect(capturedRequests[0]).toMatchObject({
      url: "/api/mcp/update-ticket-status",
      body: { status: "review", reason: "Implementation complete" },
    });
  });

  it("bridges submit_grading to the kebab-case endpoint without reshaping the payload", async () => {
    nextResponse = {
      status: 200,
      body: { data: { reportId: "grading-1" } },
    };
    const payload = {
      gradings: [
        {
          storyId: "story-1",
          criterion: "The feature works",
          status: "met",
          evidence: "Covered by feature.test.ts",
        },
      ],
      summary: "All criteria met",
    };

    const result = await client.callTool("submit_grading", payload);

    expect(result.isError).toBeFalsy();
    expect(capturedRequests[0]).toMatchObject({
      url: "/api/mcp/submit-grading",
      authorization: "Bearer test-token",
      body: payload,
    });
  });

  it("bridges report_friction to the kebab-case endpoint without adding scope fields", async () => {
    nextResponse = {
      status: 200,
      body: {
        data: {
          frictionId: "friction-1",
          occurrences: 1,
          deduplicated: false,
        },
      },
    };
    const payload = {
      category: "broken_tooling",
      description: "The local lint wrapper exits without diagnostics.",
      filePath: "scripts/lint.sh",
    };

    const result = await client.callTool("report_friction", payload);

    expect(result.isError).toBeFalsy();
    expect(capturedRequests[0]).toMatchObject({
      url: "/api/mcp/report-friction",
      authorization: "Bearer test-token",
      body: payload,
    });
  });

  it("bridges attach_artifact to the kebab-case endpoint without reshaping the payload", async () => {
    nextResponse = {
      status: 200,
      body: { data: { artifact: { id: "artifact-1", filename: "artifact-1.png" } } },
    };
    const payload = {
      path: "artifacts/settings-page.png",
      caption: "Settings page after saving the new preference",
    };

    const result = await client.callTool("attach_artifact", payload);

    expect(result.isError).toBeFalsy();
    expect(capturedRequests[0]).toMatchObject({
      url: "/api/mcp/attach-artifact",
      authorization: "Bearer test-token",
      body: payload,
    });
  });

  it("maps a non-2xx {error, code} envelope to an isError tool result", async () => {
    nextResponse = {
      status: 409,
      body: {
        error:
          "Cannot move an in-progress ticket while another agent session is queued or running.",
        code: "INVALID_TRANSITION",
      },
    };

    const result = await client.callTool("update_ticket_status", {
      status: "review",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Error (INVALID_TRANSITION): Cannot move an in-progress ticket while another agent session is queued or running."
    );
  });

  it("falls back to the HTTP status when the error body has no code", async () => {
    nextResponse = { status: 500, body: { error: "boom" } };

    const result = await client.callTool("post_comment", { body: "hi" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error (500): boom");
  });

  it("rejects unknown tools without calling the backend", async () => {
    const result = await client.callTool("not_a_tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UNKNOWN_TOOL");
    expect(capturedRequests).toHaveLength(0);
  });

  it("rejects chat-toolset tools without the env var (default = agent toolset)", async () => {
    const result = await client.callTool("list_tickets", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UNKNOWN_TOOL");
    expect(capturedRequests).toHaveLength(0);
  });

  it("turns connection failures into isError results, not protocol crashes", async () => {
    const isolated = new McpStdioClient({
      ...process.env,
      ARIJ_BASE_URL: "http://127.0.0.1:9",
      ARIJ_MCP_TOKEN: "test-token",
    });
    try {
      await isolated.initialize();
      const result = await isolated.callTool("get_ticket", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Error \(NETWORK\): /);

      // The shim survived: it still answers requests afterwards.
      const list = await isolated.request("tools/list", {});
      expect(list.tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
    } finally {
      isolated.kill();
    }
  }, 20000);
});

/* ------------------------------------------------------------------ */
/* Chat toolset (ARIJ_MCP_TOOLSET=chat)                                */
/* ------------------------------------------------------------------ */

describe("chat toolset (ARIJ_MCP_TOOLSET=chat)", () => {
  let chatClient: McpStdioClient;

  beforeAll(async () => {
    chatClient = new McpStdioClient({
      ...process.env,
      ARIJ_BASE_URL: baseUrl,
      ARIJ_MCP_TOKEN: "test-token",
      ARIJ_MCP_TOOLSET: "chat",
    });
    await chatClient.initialize();
  }, 20000);

  afterAll(() => {
    chatClient?.kill();
  });

  it("declares exactly the eight board tools, in order, with schemas", async () => {
    const result = await chatClient.request("tools/list", {});

    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      EXPECTED_CHAT_TOOL_NAMES
    );
    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("requires an explicit ticket_id on every ticket-scoped tool", async () => {
    const result = await chatClient.request("tools/list", {});
    const byName = new Map<string, any>(
      result.tools.map((tool: any) => [tool.name, tool])
    );

    for (const name of [
      "get_ticket",
      "update_ticket",
      "update_ticket_status",
      "post_comment",
      "start_build",
    ]) {
      const tool = byName.get(name);
      expect(tool.inputSchema.required).toContain("ticket_id");
      // no "defaults to the launch ticket" wording — chat has no launch ticket
      expect(tool.inputSchema.properties.ticket_id.description).not.toContain(
        "Defaults"
      );
    }

    const updateStatus = byName.get("update_ticket_status");
    expect(updateStatus.inputSchema.properties.status.enum).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "review",
    ]); // to_merge/done stay verdict- and merge-only in chat too;
    // "released" stays system-only
  });

  it("bridges get_agent_status to POST /api/mcp/get-agent-status", async () => {
    nextResponse = { status: 200, body: { data: { count: 0, activities: [] } } };

    const result = await chatClient.callTool("get_agent_status", {});

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ count: 0, activities: [] });
    expect(capturedRequests[0]).toMatchObject({
      method: "POST",
      url: "/api/mcp/get-agent-status",
      authorization: "Bearer test-token",
      body: {},
    });
  });

  it("forwards start_build args verbatim to /api/mcp/start-build", async () => {
    nextResponse = {
      status: 200,
      body: { data: { started: { ticket: "E-arij-042", session_id: "s1" } } },
    };

    await chatClient.callTool("start_build", {
      ticket_id: "E-arij-042",
      comment: "Focus on the API layer",
    });

    expect(capturedRequests[0]).toMatchObject({
      url: "/api/mcp/start-build",
      body: { ticket_id: "E-arij-042", comment: "Focus on the API layer" },
    });
  });

  it("rejects agent-only tools without calling the backend", async () => {
    for (const name of [
      "create_bug",
      "ask_question",
      "attach_artifact",
      "report_friction",
      "submit_findings",
      "submit_grading",
      // The board-refinement tools are agent-only: a chat turn must not be
      // able to re-rank, re-prioritise or promote board work.
      "set_priority",
      "reorder_tickets",
      "add_dependency",
      "remove_dependency",
      "promote_ticket",
    ]) {
      const result = await chatClient.callTool(name, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("UNKNOWN_TOOL");
    }
    expect(capturedRequests).toHaveLength(0);
  });
});
