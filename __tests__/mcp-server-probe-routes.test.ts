/**
 * Story "Test de connexion et remontée de l'état de santé" — the HTTP boundary.
 *
 * The probe itself is covered by mcp-server-probe.test.ts (real handshake,
 * timeout, orphan reaping, scrubbing). This file pins what only
 * lib/mcp/probe-route.ts decides, and every one of those decisions is a place
 * the feature can be satisfied in the probe and lost in the handler:
 *
 *  - **A failed test is DATA, not an API error.** An unreachable server comes
 *    back 200 with `{ data: { ok: false } }`. Mapping it to a 5xx would be the
 *    same mistake in the UI layer that the epic forbids in the spawn layer: a
 *    third party's downtime must cost that server, never the operation.
 *  - **The outcome is persisted before it is returned.** A health badge that
 *    only exists in a response vanishes on remount; the criterion is that the
 *    result and its date survive a reload.
 *  - **The scopes cannot reach each other.** A global must 404 through the
 *    project route and a project entry through the global one — otherwise the
 *    test button is a cross-project read of another scope's configuration.
 *  - **The scrub survives persistence.** `last_check_error` is the DURABLE
 *    copy of the message and the one the UI renders, so a secret kept out of
 *    the returned string but written to the row would still leak.
 *
 * The malformed-row case (a stdio row with no command) is here rather than in
 * the probe test because it never reaches the probe: the handler owns it, and
 * it is the one failure that is a configuration mistake rather than a
 * transport one.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { mcpServers, projects } = await import("@/lib/db/schema");

const globalTestRoute = await import(
  "@/app/api/settings/mcp-servers/[serverId]/test/route"
);
const projectTestRoute = await import(
  "@/app/api/projects/[projectId]/mcp-servers/[serverId]/test/route"
);

const PROJECT_ID = "proj-mcp";
const SECRET = "s3cret-godot-value";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-probe-route-"));
  db.delete(mcpServers).run();
  db.delete(projects).run();
  db.insert(projects)
    .values([
      { id: PROJECT_ID, name: "MCP" },
      { id: "other-proj", name: "Other" },
    ])
    .run();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A minimal stdio MCP server answering `initialize` and `tools/list`, plus a
 * `crash` mode that echoes its own environment on the way out — which is what
 * a genuinely broken server does, and the reason the scrub exists.
 */
function writeFixtureServer(mode: "ok" | "crash" | "crash-short"): string {
  const file = path.join(tempDir, `server-${mode}.mjs`);
  fs.writeFileSync(
    file,
    `
const MODE = ${JSON.stringify(mode)};
if (MODE === "crash") {
  process.stderr.write("failed to start with " + JSON.stringify(process.env.GODOT_TOKEN ?? "") + "\\n");
  process.exit(3);
}
if (MODE === "crash-short") {
  process.stderr.write("failed to start with PIN=" + (process.env.PIN ?? "") + "\\n");
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
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: ["list_nodes", "run_scene"].map((name) => ({
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

/**
 * Rows are inserted directly rather than through `createMcpServer`, because
 * one of the cases under test — a stdio row with no command — is exactly what
 * the service refuses to create. The handler still has to answer for a row
 * that got there another way (an older migration, a hand-edited database).
 */
function insertServer(values: Record<string, unknown>): string {
  const id = `srv-${Math.random().toString(36).slice(2, 10)}`;
  db.insert(mcpServers)
    .values({ id, name: "godot", transport: "stdio", ...values })
    .run();
  return id;
}

function stdioFixture(
  mode: "ok" | "crash" | "crash-short",
  values: Record<string, unknown> = {},
) {
  return insertServer({
    command: process.execPath,
    args: JSON.stringify([writeFixtureServer(mode)]),
    ...values,
  });
}

const rowOf = (id: string) =>
  db.select().from(mcpServers).all().find((row) => row.id === id)!;

const probeGlobal = (serverId: string) =>
  globalTestRoute.POST(mockNextRequest({ method: "POST" }), mockRouteContext({ serverId }));

const probeProject = (serverId: string, projectId = PROJECT_ID) =>
  projectTestRoute.POST(
    mockNextRequest({ method: "POST" }),
    mockRouteContext({ projectId, serverId }),
  );

describe("a reachable server", () => {
  it("returns the tool count and names down the { data } envelope", async () => {
    const id = stdioFixture("ok");

    const response = await probeGlobal(id);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.error).toBeUndefined();
    expect(payload.data.ok).toBe(true);
    expect(payload.data.toolCount).toBe(2);
    expect(payload.data.toolNames).toEqual(["list_nodes", "run_scene"]);
  });

  it("persists the outcome and its date, so the badge survives a reload", async () => {
    const id = stdioFixture("ok");
    expect(rowOf(id).lastCheckedAt).toBeNull();

    await probeGlobal(id);

    const row = rowOf(id);
    expect(row.lastCheckOk).toBe(true);
    expect(row.lastCheckError).toBeNull();
    expect(Date.parse(row.lastCheckedAt!)).not.toBeNaN();
  });

  it("clears a previous failure rather than leaving a stale error on the row", async () => {
    // The row carries the wreckage of an earlier red test; a green one has to
    // retire it, or the UI shows a healthy server with a failure message.
    const id = stdioFixture("ok", {
      lastCheckedAt: "2020-01-01T00:00:00.000Z",
      lastCheckOk: false,
      lastCheckError: "connection refused",
    });

    await probeGlobal(id);

    const row = rowOf(id);
    expect(row.lastCheckOk).toBe(true);
    expect(row.lastCheckError).toBeNull();
    expect(row.lastCheckedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("tests a project-scoped server through the project route", async () => {
    const id = stdioFixture("ok", { projectId: PROJECT_ID });

    const payload = await (await probeProject(id)).json();

    expect(payload.data.ok).toBe(true);
    expect(payload.data.toolNames).toEqual(["list_nodes", "run_scene"]);
    expect(rowOf(id).lastCheckOk).toBe(true);
  });
});

describe("a broken server", () => {
  it("is a 200 carrying ok:false — a failed test is health, not an API error", async () => {
    const id = insertServer({ command: "/nonexistent/definitely-not-a-server" });

    const response = await probeGlobal(id);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.ok).toBe(false);
    expect(payload.data.toolCount).toBe(0);
    expect(payload.data.toolNames).toEqual([]);
    expect(typeof payload.data.error).toBe("string");
    expect(payload.data.error.length).toBeGreaterThan(0);
  });

  it("persists the failure with its readable reason", async () => {
    const id = insertServer({ command: "/nonexistent/definitely-not-a-server" });

    await probeGlobal(id);

    const row = rowOf(id);
    expect(row.lastCheckOk).toBe(false);
    expect(row.lastCheckError).toBeTruthy();
    expect(Date.parse(row.lastCheckedAt!)).not.toBeNaN();
  });

  it("keeps a configured secret out of BOTH the response and the stored error", async () => {
    // `last_check_error` is the durable copy and the one the UI renders, so
    // scrubbing only the returned string would still leak the credential —
    // into the database, and into anything that later logs the row.
    const id = stdioFixture("crash", {
      env: JSON.stringify({ GODOT_TOKEN: SECRET }),
    });

    const payload = await (await probeGlobal(id)).json();

    expect(payload.data.ok).toBe(false);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(rowOf(id).lastCheckError ?? "").not.toContain(SECRET);
  });

  it("keeps a SHORT configured secret out of the stored error as well", async () => {
    // The same durability argument as above, for the case the scrub used to
    // wave through: a value under four characters was returned verbatim and
    // written to `last_check_error`, where the settings screen renders it on
    // every reload. The write-only contract does not have a length threshold.
    const id = stdioFixture("crash-short", { env: JSON.stringify({ PIN: "123" }) });

    const payload = await (await probeGlobal(id)).json();

    expect(payload.data.ok).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("PIN=123");
    expect(rowOf(id).lastCheckError ?? "").not.toContain("PIN=123");
    expect(rowOf(id).lastCheckError ?? "").toContain("<redacted>");
  });

  it("reports a row whose transport fields are incomplete instead of probing it", async () => {
    // A stdio server with no command cannot be spawned at all. The handler
    // answers for it, and records it as a failed check like any other, so the
    // misconfiguration is visible on the row rather than only in a toast.
    const id = insertServer({ command: null });

    const response = await probeGlobal(id);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.ok).toBe(false);
    expect(payload.data.error).toContain("command");
    expect(rowOf(id).lastCheckOk).toBe(false);
    expect(rowOf(id).lastCheckError).toContain("command");
  });
});

describe("the two scopes cannot reach each other", () => {
  it("404s a global through the project route, and writes no health", async () => {
    const id = stdioFixture("ok");

    const response = await probeProject(id);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("not found");
    // A refused lookup must not touch the row it refused to read.
    expect(rowOf(id).lastCheckedAt).toBeNull();
  });

  it("404s a project server through the global route, and writes no health", async () => {
    const id = stdioFixture("ok", { projectId: PROJECT_ID });

    const response = await probeGlobal(id);

    expect(response.status).toBe(404);
    expect(rowOf(id).lastCheckedAt).toBeNull();
  });

  it("404s another project's server", async () => {
    const id = stdioFixture("ok", { projectId: PROJECT_ID });

    const response = await probeProject(id, "other-proj");

    expect(response.status).toBe(404);
    expect(rowOf(id).lastCheckedAt).toBeNull();
  });

  it("404s an unknown server id", async () => {
    const response = await probeGlobal("nope");

    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("not found");
  });

  it("404s an unknown project before it looks at the server at all", async () => {
    const id = stdioFixture("ok", { projectId: PROJECT_ID });

    const response = await probeProject(id, "no-such-project");

    expect(response.status).toBe(404);
    expect(rowOf(id).lastCheckedAt).toBeNull();
  });
});
