/**
 * Story "Schéma, migration et CRUD des serveurs MCP" — the HTTP boundary.
 *
 * lib/mcp/servers.ts is covered by mcp-servers-crud.test.ts; this file pins
 * what only the routes decide: the `{ data }` / `{ error }` envelope, the
 * status codes each failure maps to (400 validation, 404 unknown, 409 taken
 * name), and — the criterion that is easiest to satisfy in the service and
 * lose in a handler — that a secret never crosses the wire, on ANY verb.
 *
 * The two scopes share one implementation (lib/mcp/server-routes.ts), so the
 * point of testing both is not the happy path twice: it is that they cannot
 * reach each other. A global must be a 404 through the project routes and a
 * project entry a 404 through the global ones, or "unique per scope" is a
 * label rather than a boundary.
 *
 * Caps are asserted HERE as well as in the service test on purpose: the epic
 * requires an over-size value to arrive as the same error shape an invalid
 * enum value does, and "same shape" is a statement about the response, not
 * about which exception class was thrown internally.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockJsonRequest, mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { mcpServers, projects } = await import("@/lib/db/schema");
const {
  MCP_SERVER_ARGS_MAX_ITEMS,
  MCP_SERVER_ARG_MAX_LENGTH,
  MCP_SERVER_ENV_MAX_KEYS,
  MCP_SERVER_ENV_VALUE_MAX_LENGTH,
  MCP_SERVER_HEADERS_MAX_KEYS,
  MCP_SERVER_SECRET_MASK,
} = await import("@/lib/mcp/server-limits");

const globalRoute = await import("@/app/api/settings/mcp-servers/route");
const globalItemRoute = await import("@/app/api/settings/mcp-servers/[serverId]/route");
const projectRoute = await import("@/app/api/projects/[projectId]/mcp-servers/route");
const projectItemRoute = await import(
  "@/app/api/projects/[projectId]/mcp-servers/[serverId]/route"
);
const shadowRoute = await import("@/app/api/projects/[projectId]/mcp-servers/shadow/route");

const PROJECT_ID = "proj-mcp";
const SECRET = "s3cret-token-value";

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: "stdio",
  command: "/usr/bin/godot-mcp",
  ...extra,
});

beforeEach(() => {
  db.delete(mcpServers).run();
  db.delete(projects).run();
  db.insert(projects)
    .values([
      { id: PROJECT_ID, name: "MCP" },
      { id: "other-proj", name: "Other" },
    ])
    .run();
});

/** POST to the global scope, returning the response and its parsed body. */
async function createGlobal(body: unknown) {
  const response = await globalRoute.POST(mockJsonRequest(body));
  return { response, payload: await response.json() };
}

async function createForProject(body: unknown, projectId = PROJECT_ID) {
  const response = await projectRoute.POST(
    mockJsonRequest(body),
    mockRouteContext({ projectId }),
  );
  return { response, payload: await response.json() };
}

describe("global MCP server routes", () => {
  it("creates, lists, updates and deletes down the { data } envelope", async () => {
    const created = await createGlobal(stdio("godot", { usageHint: "Godot scene tools" }));
    expect(created.response.status).toBe(201);
    expect(created.payload.data.id).toEqual(expect.any(String));
    expect(created.payload.data.projectId).toBeNull();
    expect(created.payload.error).toBeUndefined();

    const listed = await (await globalRoute.GET()).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].name).toBe("godot");
    expect(listed.data[0].usageHint).toBe("Godot scene tools");

    const patched = await globalItemRoute.PATCH(
      mockJsonRequest({ enabled: false, usageHint: "off for now" }),
      mockRouteContext({ serverId: created.payload.data.id }),
    );
    const patchedPayload = await patched.json();
    expect(patched.status).toBe(200);
    expect(patchedPayload.data.enabled).toBe(false);
    expect(patchedPayload.data.usageHint).toBe("off for now");

    const deleted = await globalItemRoute.DELETE(
      mockNextRequest(),
      mockRouteContext({ serverId: created.payload.data.id }),
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data).toEqual({
      id: created.payload.data.id,
      deleted: true,
    });
    expect((await (await globalRoute.GET()).json()).data).toEqual([]);
  });

  it("refuses the reserved `arij` name with an explicit 400", async () => {
    const { response, payload } = await createGlobal(stdio("arij"));
    expect(response.status).toBe(400);
    expect(payload.data).toBeUndefined();
    expect(payload.error).toContain("arij");
    expect(payload.error).toContain("reserved");
  });

  it("refuses renaming an existing server onto `arij`", async () => {
    const created = await createGlobal(stdio("godot"));
    const response = await globalItemRoute.PATCH(
      mockJsonRequest({ name: "arij" }),
      mockRouteContext({ serverId: created.payload.data.id }),
    );
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error).toContain("reserved");

    // And the stored name is untouched — a refused rename is not a partial one.
    const listed = await (await globalRoute.GET()).json();
    expect(listed.data[0].name).toBe("godot");
  });

  it("maps a name already taken in the scope to 409", async () => {
    await createGlobal(stdio("godot"));
    const { response, payload } = await createGlobal(stdio("godot"));
    expect(response.status).toBe(409);
    expect(payload.error).toContain("already exists");
    expect((await (await globalRoute.GET()).json()).data).toHaveLength(1);
  });

  it("maps an unknown id to 404 on both PATCH and DELETE", async () => {
    const patched = await globalItemRoute.PATCH(
      mockJsonRequest({ enabled: false }),
      mockRouteContext({ serverId: "nope" }),
    );
    expect(patched.status).toBe(404);
    expect((await patched.json()).error).toContain("not found");

    const deleted = await globalItemRoute.DELETE(
      mockNextRequest(),
      mockRouteContext({ serverId: "nope" }),
    );
    expect(deleted.status).toBe(404);
  });

  it("rejects a malformed JSON body rather than treating it as empty", async () => {
    const response = await globalRoute.POST(
      mockNextRequest({ method: "POST", body: "{not json", headers: { "content-type": "application/json" } }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
  });
});

describe("caps and shape errors share one response shape", () => {
  // The epic's requirement, stated at the boundary the UI actually sees: an
  // over-size env/args/headers value must not arrive as a special case, and
  // must never be accepted-then-truncated.
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["an invalid transport enum", { name: "godot", transport: "carrier-pigeon" }],
    ["a name outside [a-z0-9_-]+", stdio("Godot Server")],
    ["a stdio server with no command", { name: "godot", transport: "stdio" }],
    ["an http server with no url", { name: "godot", transport: "http" }],
    ["an http server carrying a command", { name: "godot", transport: "http", url: "https://x.test", command: "/bin/x" }],
    [
      "an over-long env value",
      stdio("godot", { env: { TOKEN: "x".repeat(MCP_SERVER_ENV_VALUE_MAX_LENGTH + 1) } }),
    ],
    [
      "too many env keys",
      stdio("godot", {
        env: Object.fromEntries(
          Array.from({ length: MCP_SERVER_ENV_MAX_KEYS + 1 }, (_, i) => [`K${i}`, "v"]),
        ),
      }),
    ],
    [
      "too many args",
      stdio("godot", { args: Array.from({ length: MCP_SERVER_ARGS_MAX_ITEMS + 1 }, () => "--flag") }),
    ],
    ["an over-long arg", stdio("godot", { args: ["x".repeat(MCP_SERVER_ARG_MAX_LENGTH + 1)] })],
    [
      "args over the total-length budget",
      stdio("godot", {
        args: Array.from({ length: MCP_SERVER_ARGS_MAX_ITEMS }, () =>
          "x".repeat(MCP_SERVER_ARG_MAX_LENGTH),
        ),
      }),
    ],
    [
      "too many headers",
      {
        name: "confluence",
        transport: "http",
        url: "https://confluence.test/mcp",
        headers: Object.fromEntries(
          Array.from({ length: MCP_SERVER_HEADERS_MAX_KEYS + 1 }, (_, i) => [`H${i}`, "v"]),
        ),
      },
    ],
  ];

  it("applies the same caps to an update, leaving the stored row intact", async () => {
    // The create path validates the request; the update path validates the
    // MERGED state, which is a different call site and can drift from it. The
    // env key count in particular is not a Zod rule — it only exists in the
    // shape check — so a patch is where it would go missing.
    const server = (await createGlobal(stdio("godot", { env: { TOKEN: SECRET } }))).payload.data;

    const response = await globalItemRoute.PATCH(
      mockJsonRequest({
        env: Object.fromEntries(
          Array.from({ length: MCP_SERVER_ENV_MAX_KEYS + 1 }, (_, i) => [`K${i}`, "v"]),
        ),
      }),
      mockRouteContext({ serverId: server.id }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(typeof payload.error).toBe("string");
    expect(payload.data).toBeUndefined();
    // Refused whole: the original secret is still the stored one.
    expect(db.select().from(mcpServers).all()[0].env).toContain(SECRET);
  });

  it.each(rejected)("rejects %s as a 400 { error }, storing nothing", async (_label, body) => {
    const { response, payload } = await createGlobal(body);

    expect(response.status).toBe(400);
    expect(typeof payload.error).toBe("string");
    expect(payload.error.length).toBeGreaterThan(0);
    expect(payload.data).toBeUndefined();
    // Rejected, never truncated: no row exists to hold a shortened value.
    expect(db.select().from(mcpServers).all()).toEqual([]);
  });
});

describe("env and headers never come back out", () => {
  it("masks secrets on create, read and update", async () => {
    const created = await createGlobal(stdio("godot", { env: { GODOT_TOKEN: SECRET } }));
    expect(JSON.stringify(created.payload)).not.toContain(SECRET);
    expect(created.payload.data.env).toEqual({ GODOT_TOKEN: MCP_SERVER_SECRET_MASK });

    const listed = await (await globalRoute.GET()).json();
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    // A PATCH that echoes the mask back (a blank password field) keeps the
    // stored value, and still does not return it.
    const patched = await globalItemRoute.PATCH(
      mockJsonRequest({ env: { GODOT_TOKEN: MCP_SERVER_SECRET_MASK } }),
      mockRouteContext({ serverId: created.payload.data.id }),
    );
    expect(JSON.stringify(await patched.json())).not.toContain(SECRET);
    expect(db.select().from(mcpServers).all()[0].env).toContain(SECRET);
  });

  it("masks http headers the same way", async () => {
    const { payload } = await createGlobal({
      name: "confluence",
      transport: "http",
      url: "https://confluence.test/mcp",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(payload.data.headers).toEqual({ Authorization: MCP_SERVER_SECRET_MASK });

    const listed = await (await globalRoute.GET()).json();
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });
});

describe("project MCP server routes", () => {
  it("returns the project's own servers, the inherited globals, and the providers that ignore this scope", async () => {
    await createGlobal(stdio("godot"));
    await createForProject(stdio("playwright"));

    const response = await projectRoute.GET(
      mockNextRequest(),
      mockRouteContext({ projectId: PROJECT_ID }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.servers.map((s: { name: string }) => s.name)).toEqual(["playwright"]);
    expect(payload.data.inherited.map((s: { name: string }) => s.name)).toEqual(["godot"]);
    expect(payload.data.inherited[0].shadowed).toBe(false);
    expect(payload.data.unsupportedProviders.length).toBeGreaterThan(0);
  });

  it("404s on an unknown project instead of falling back to the global scope", async () => {
    await createGlobal(stdio("godot"));

    const listed = await projectRoute.GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "ghost" }),
    );
    expect(listed.status).toBe(404);

    const created = await createForProject(stdio("playwright"), "ghost");
    expect(created.response.status).toBe(404);
    expect(db.select().from(mcpServers).all()).toHaveLength(1);
  });

  it("lets one name exist once per scope, and reports the second one in the same scope as 409", async () => {
    expect((await createGlobal(stdio("godot"))).response.status).toBe(201);
    expect((await createForProject(stdio("godot"))).response.status).toBe(201);
    expect((await createForProject(stdio("godot"))).response.status).toBe(409);

    // The project entry shadows the global it shares a name with — the GET
    // says so rather than showing both as live.
    const payload = await (
      await projectRoute.GET(mockNextRequest(), mockRouteContext({ projectId: PROJECT_ID }))
    ).json();
    expect(payload.data.inherited[0].shadowed).toBe(true);
  });

  it("keeps the two scopes out of each other's reach", async () => {
    const globalServer = (await createGlobal(stdio("godot"))).payload.data;
    const projectServer = (await createForProject(stdio("playwright"))).payload.data;

    // A global is invisible to the project routes...
    const patchedGlobal = await projectItemRoute.PATCH(
      mockJsonRequest({ enabled: false }),
      mockRouteContext({ projectId: PROJECT_ID, serverId: globalServer.id }),
    );
    expect(patchedGlobal.status).toBe(404);
    const deletedGlobal = await projectItemRoute.DELETE(
      mockNextRequest(),
      mockRouteContext({ projectId: PROJECT_ID, serverId: globalServer.id }),
    );
    expect(deletedGlobal.status).toBe(404);

    // ...and a project entry is invisible to the global ones.
    const patchedProject = await globalItemRoute.PATCH(
      mockJsonRequest({ enabled: false }),
      mockRouteContext({ serverId: projectServer.id }),
    );
    expect(patchedProject.status).toBe(404);

    // Nor can one project reach another's.
    const crossProject = await projectItemRoute.DELETE(
      mockNextRequest(),
      mockRouteContext({ projectId: "other-proj", serverId: projectServer.id }),
    );
    expect(crossProject.status).toBe(404);

    expect(db.select().from(mcpServers).all()).toHaveLength(2);
  });

  it("edits and deletes a project server through its own routes", async () => {
    const server = (await createForProject(stdio("playwright"))).payload.data;

    const patched = await projectItemRoute.PATCH(
      mockJsonRequest({ command: "/usr/bin/playwright-mcp" }),
      mockRouteContext({ projectId: PROJECT_ID, serverId: server.id }),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.command).toBe("/usr/bin/playwright-mcp");

    const deleted = await projectItemRoute.DELETE(
      mockNextRequest(),
      mockRouteContext({ projectId: PROJECT_ID, serverId: server.id }),
    );
    expect(deleted.status).toBe(200);
    expect(db.select().from(mcpServers).all()).toEqual([]);
  });

  it("shadows an inherited global once, then reports the second attempt as 409", async () => {
    const globalServer = (await createGlobal(stdio("godot", { env: { GODOT_TOKEN: SECRET } })))
      .payload.data;

    const response = await shadowRoute.POST(
      mockJsonRequest({ globalServerId: globalServer.id }),
      mockRouteContext({ projectId: PROJECT_ID }),
    );
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(payload.data.projectId).toBe(PROJECT_ID);
    expect(payload.data.enabled).toBe(false);
    // The copy carries the global's secret server-side, but the API still
    // refuses to hand it back.
    expect(JSON.stringify(payload)).not.toContain(SECRET);

    const again = await shadowRoute.POST(
      mockJsonRequest({ globalServerId: globalServer.id }),
      mockRouteContext({ projectId: PROJECT_ID }),
    );
    expect(again.status).toBe(409);

    const missing = await shadowRoute.POST(
      mockJsonRequest({ globalServerId: "ghost" }),
      mockRouteContext({ projectId: PROJECT_ID }),
    );
    expect(missing.status).toBe(404);

    const malformed = await shadowRoute.POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId: PROJECT_ID }),
    );
    expect(malformed.status).toBe(400);
  });
});
