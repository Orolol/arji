/**
 * Story "Schéma, migration et CRUD des serveurs MCP".
 *
 * Covers migration 0048 and its hand-written journal entry, the cascade that
 * makes project deletion clean up its servers, and the validation contract:
 * the reserved `arij` name, the name grammar, per-scope uniqueness, the
 * transport-dependent shape rules, and — the one that is easy to get wrong —
 * that an over-size value is REJECTED rather than silently truncated, down the
 * same path an invalid enum value takes.
 *
 * Also pins the write-only secret contract: `env`/`headers` values never come
 * back out of the service, including from the CREATE and UPDATE return values,
 * which is where a masked read is easiest to forget.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { mcpServers } from "@/lib/db/schema";
import {
  MCP_SERVER_ENV_VALUE_MAX_LENGTH,
  MCP_SERVER_SECRET_MASK,
  MCP_SERVER_USAGE_HINT_MAX_LENGTH,
  McpServerConflictError,
  McpServerValidationError,
  createMcpServer,
  createMcpServerSchema,
  deleteMcpServer,
  disableGlobalForProject,
  listMcpServers,
  mcpServerSecrets,
  updateMcpServer,
  updateMcpServerSchema,
} from "@/lib/mcp/servers";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "lib", "db", "migrations");
const MIGRATION_TAG = "0048_mcp_servers";
const MIGRATION_WHEN = 1786714500000;
// The scope-uniqueness indexes ship as their own migration: 0048 is already
// applied on any database that ran this branch earlier, so the indexes cannot
// be folded back into it.
const SCOPE_UNIQUE_TAG = "0049_mcp_servers_scope_unique";
const SCOPE_UNIQUE_WHEN = 1786714600000;

const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf-8"),
) as { entries: { idx: number; when: number; tag: string }[] };

let db: ReturnType<typeof createTestDb>["db"];
let sqlite: Database.Database;

beforeEach(() => {
  const created = createTestDb();
  db = created.db;
  sqlite = created.sqlite;
  sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj-1', 'P1')").run();
  sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj-2', 'P2')").run();
});

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: "stdio" as const,
  command: "/usr/bin/godot-mcp",
  ...extra,
});

describe("0048_mcp_servers — migration bookkeeping", () => {
  it.each([
    [MIGRATION_TAG, MIGRATION_WHEN],
    [SCOPE_UNIQUE_TAG, SCOPE_UNIQUE_WHEN],
  ])("%s owns a journal slot with the expected `when`", (tag, when) => {
    const entry = journal.entries.find((e) => e.tag === tag);
    expect(entry).toBeDefined();
    expect(entry?.when).toBe(when);
  });

  it("keeps the journal strictly increasing, with this branch at the tail", () => {
    // Drizzle keeps ONE high-water mark and applies only migrations strictly
    // above it, so equality is a collision rather than valid ordering.
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, i) => i === 0 || w > whens[i - 1])).toBe(true);
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs.every((v, i) => i === 0 || v > idxs[i - 1])).toBe(true);

    // The two migrations are adjacent and last, in order. 0049 creates indexes
    // ON the table 0048 creates, so the relative order is load-bearing, not
    // just tidy.
    expect(journal.entries.slice(-2).map((e) => e.tag)).toEqual([
      MIGRATION_TAG,
      SCOPE_UNIQUE_TAG,
    ]);
  });

  it("is a hand-written CREATE TABLE with no drizzle-kit snapshot", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`),
      "utf-8",
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `mcp_servers`/);
    expect(sql).toMatch(/ON DELETE cascade/i);

    const snapshots = fs
      .readdirSync(path.join(MIGRATIONS_FOLDER, "meta"))
      .filter((n) => n.endsWith("_snapshot.json"))
      .sort();
    expect(snapshots).not.toContain("0048_snapshot.json");
    expect(snapshots[snapshots.length - 1]).toBe("0013_snapshot.json");
  });

  it("creates the table, and lib/db/schema.ts mirrors its columns", () => {
    const applied = (
      sqlite.prepare("SELECT name FROM pragma_table_info('mcp_servers')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(applied.length).toBeGreaterThan(0);

    const declared = Object.values(getTableColumns(mcpServers)).map((c) => c.name);
    expect(declared.slice().sort()).toEqual(applied.slice().sort());
  });
});

describe("scopes and the project cascade", () => {
  it("treats project_id NULL as the global scope", () => {
    createMcpServer(stdio("godot"), db, null);
    createMcpServer(stdio("confluence"), db, "proj-1");

    expect(listMcpServers(db, null).map((s) => s.name)).toEqual(["godot"]);
    expect(listMcpServers(db, "proj-1").map((s) => s.name)).toEqual(["confluence"]);
    // Scopes do not leak into one another.
    expect(listMcpServers(db, "proj-2")).toEqual([]);
  });

  it("drops a project's servers when the project is deleted, and spares the globals", () => {
    createMcpServer(stdio("godot"), db, null);
    createMcpServer(stdio("playwright"), db, "proj-1");

    sqlite.prepare("DELETE FROM projects WHERE id = 'proj-1'").run();

    // The FK cascade is why no perProjectSettingKeys() entry is needed: the
    // table owns its own cleanup, unlike the flat `settings` table.
    expect(listMcpServers(db, "proj-1")).toEqual([]);
    expect(listMcpServers(db, null).map((s) => s.name)).toEqual(["godot"]);
  });

  it("lets the same name exist once per scope but not twice in one", () => {
    createMcpServer(stdio("godot"), db, null);
    expect(() => createMcpServer(stdio("godot"), db, "proj-1")).not.toThrow();

    expect(() => createMcpServer(stdio("godot"), db, null)).toThrow(
      McpServerConflictError,
    );
    expect(() => createMcpServer(stdio("godot"), db, "proj-1")).toThrow(
      McpServerConflictError,
    );
  });

  it("refuses to rename onto a name already taken in the same scope", () => {
    createMcpServer(stdio("godot"), db, null);
    const other = createMcpServer(stdio("confluence"), db, null);

    expect(() => updateMcpServer(other.id, { name: "godot" }, db, null)).toThrow(
      McpServerConflictError,
    );
  });
});

describe("the reserved name", () => {
  it("refuses `arij` at creation with an explicit message", () => {
    expect(() => createMcpServer(stdio("arij"), db, null)).toThrow(
      /reserved for Arij's own tool channel/,
    );
    // Schema-level too, so a route rejects it before touching the service.
    expect(createMcpServerSchema.safeParse(stdio("arij")).success).toBe(false);
  });

  it("refuses renaming an existing server to `arij`", () => {
    const server = createMcpServer(stdio("godot"), db, null);
    expect(() => updateMcpServer(server.id, { name: "arij" }, db, null)).toThrow(
      /reserved/,
    );
  });
});

describe("name grammar and transport shape", () => {
  it.each(["Godot", "go dot", "go/dot", "gödot", ""])(
    "rejects the invalid name %o",
    (name) => {
      expect(createMcpServerSchema.safeParse(stdio(name)).success).toBe(false);
    },
  );

  it("accepts [a-z0-9_-]+", () => {
    for (const name of ["godot", "go-dot", "go_dot", "mcp2"]) {
      expect(createMcpServerSchema.safeParse(stdio(name)).success).toBe(true);
    }
  });

  it("requires `command` for stdio and `url` for http", () => {
    expect(() =>
      createMcpServer({ name: "a", transport: "stdio" }, db, null),
    ).toThrow(/command is required/);
    expect(() =>
      createMcpServer({ name: "b", transport: "http" }, db, null),
    ).toThrow(/url is required/);
  });

  it("refuses incoherent transport combinations", () => {
    expect(() =>
      createMcpServer(
        { name: "a", transport: "stdio", command: "/x", url: "http://x/mcp" },
        db,
        null,
      ),
    ).toThrow(/url is not allowed on a stdio server/);
    expect(() =>
      createMcpServer(
        { name: "b", transport: "http", url: "http://x/mcp", command: "/x" },
        db,
        null,
      ),
    ).toThrow(/command is not allowed on an http server/);
    expect(() =>
      createMcpServer(
        { name: "c", transport: "http", url: "not-a-url" },
        db,
        null,
      ),
    ).toThrow(/absolute http\(s\) URL/);
  });

  it("keeps a partial update from leaving the row transport-inconsistent", () => {
    const server = createMcpServer(stdio("godot"), db, null);
    // The patch alone is legal; the MERGED state is not — an http server with
    // the stdio command still on it.
    expect(() =>
      updateMcpServer(server.id, { transport: "http", url: "http://x/mcp" }, db, null),
    ).toThrow(/command is not allowed on an http server/);
  });

  /**
   * The other direction of that boundary. The test above proves the merge
   * REFUSES a half-switched patch; without these, nothing proves a complete one
   * is accepted — and a rule that rejects both a partial switch and a full one
   * makes transport un-editable, which is what the UI hit.
   */
  it("accepts a transport switch that clears the abandoned side", () => {
    const server = createMcpServer(
      stdio("godot", { args: ["--headless"] }),
      db,
      null,
    );

    const updated = updateMcpServer(
      server.id,
      { transport: "http", url: "http://x/mcp", command: null, args: null },
      db,
      null,
    );

    expect(updated.transport).toBe("http");
    expect(updated.url).toBe("http://x/mcp");
    expect(updated.command).toBeNull();
    expect(updated.args).toEqual([]);
  });

  /**
   * `effectiveState` normalises a missing `args` column to `[]`, and `[]` is
   * TRUTHY. The http branch used to test `if (value.args)`, so the "args are
   * not allowed" rule fired on every http row whether or not it had any — which
   * made http servers uneditable outright, one-click enable/disable included.
   */
  it("lets an http server be edited without inventing an args violation", () => {
    const server = createMcpServer(
      { name: "remote", transport: "http", url: "http://x/mcp" },
      db,
      null,
    );

    expect(() =>
      updateMcpServer(server.id, { usageHint: "a hint" }, db, null),
    ).not.toThrow();
    expect(() =>
      updateMcpServer(server.id, { enabled: false }, db, null),
    ).not.toThrow();
  });

  it("still refuses args that are actually present on an http server", () => {
    // The relaxation above is about EMPTY only; a real args list on an http
    // server is still a shape error.
    expect(() =>
      createMcpServer(
        { name: "remote", transport: "http", url: "http://x/mcp", args: ["--x"] },
        db,
        null,
      ),
    ).toThrow(/args are not allowed on an http server/);

    const stdioServer = createMcpServer(
      stdio("godot", { args: ["--headless"] }),
      db,
      null,
    );
    expect(() =>
      updateMcpServer(
        stdioServer.id,
        { transport: "http", url: "http://x/mcp", command: null },
        db,
        null,
      ),
    ).toThrow(/args are not allowed on an http server/);
  });

  it("accepts the reverse switch too", () => {
    const server = createMcpServer(
      { name: "godot", transport: "http", url: "http://x/mcp" },
      db,
      null,
    );

    const updated = updateMcpServer(
      server.id,
      { transport: "stdio", command: "/usr/bin/godot-mcp", url: null },
      db,
      null,
    );

    expect(updated.transport).toBe("stdio");
    expect(updated.command).toBe("/usr/bin/godot-mcp");
    expect(updated.url).toBeNull();
  });
});

describe("caps are rejections, never truncation", () => {
  it("rejects an over-long env value instead of storing a shortened one", () => {
    const huge = "x".repeat(MCP_SERVER_ENV_VALUE_MAX_LENGTH + 1);
    const parsed = createMcpServerSchema.safeParse(
      stdio("godot", { env: { TOKEN: huge } }),
    );
    expect(parsed.success).toBe(false);

    // And nothing was written, so the form's value and the row cannot diverge.
    expect(listMcpServers(db, null)).toEqual([]);
  });

  it("rejects an over-long usage_hint", () => {
    const parsed = createMcpServerSchema.safeParse(
      stdio("godot", { usageHint: "y".repeat(MCP_SERVER_USAGE_HINT_MAX_LENGTH + 1) }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects too many env keys", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) env[`K${i}`] = "v";
    expect(() => createMcpServer(stdio("godot", { env }), db, null)).toThrow(
      McpServerValidationError,
    );
  });

  it("reports a cap breach with the same error class as an invalid shape", () => {
    // The epic's requirement: an over-size value and an invalid enum/option
    // value must reach the UI as ONE error shape, not a special case per field.
    const env: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) env[`K${i}`] = "v";

    let capError: unknown;
    let shapeError: unknown;
    try {
      createMcpServer(stdio("a", { env }), db, null);
    } catch (error) {
      capError = error;
    }
    try {
      createMcpServer({ name: "b", transport: "http" }, db, null);
    } catch (error) {
      shapeError = error;
    }
    expect(capError).toBeInstanceOf(McpServerValidationError);
    expect(shapeError).toBeInstanceOf(McpServerValidationError);
    expect(capError!.constructor).toBe(shapeError!.constructor);
  });
});

describe("env and headers are write-only", () => {
  it("masks values on read, keeping the keys", () => {
    createMcpServer(
      stdio("godot", { env: { GODOT_TOKEN: "s3cret", PORT: "6007" } }),
      db,
      null,
    );

    const [listed] = listMcpServers(db, null);
    expect(Object.keys(listed.env).sort()).toEqual(["GODOT_TOKEN", "PORT"]);
    expect(listed.env.GODOT_TOKEN).toBe(MCP_SERVER_SECRET_MASK);
    expect(listed.env.PORT).toBe(MCP_SERVER_SECRET_MASK);
    expect(JSON.stringify(listed)).not.toContain("s3cret");
  });

  it("masks the CREATE and UPDATE return values too", () => {
    const created = createMcpServer(
      stdio("godot", { env: { GODOT_TOKEN: "s3cret" } }),
      db,
      null,
    );
    expect(created.env.GODOT_TOKEN).toBe(MCP_SERVER_SECRET_MASK);
    expect(JSON.stringify(created)).not.toContain("s3cret");

    const updated = updateMcpServer(created.id, { usageHint: "scenes" }, db, null);
    expect(updated.env.GODOT_TOKEN).toBe(MCP_SERVER_SECRET_MASK);
    expect(JSON.stringify(updated)).not.toContain("s3cret");
  });

  it("masks http headers the same way", () => {
    const created = createMcpServer(
      {
        name: "confluence",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer abc123" },
      },
      db,
      null,
    );
    expect(created.headers.Authorization).toBe(MCP_SERVER_SECRET_MASK);
    expect(JSON.stringify(created)).not.toContain("abc123");
  });

  it("keeps the stored secret when the patch sends the mask or a blank", () => {
    const created = createMcpServer(
      stdio("godot", { env: { GODOT_TOKEN: "s3cret", OTHER: "keep" } }),
      db,
      null,
    );

    // This is what the UI posts back after showing a blank password field.
    updateMcpServer(
      created.id,
      { env: { GODOT_TOKEN: MCP_SERVER_SECRET_MASK, OTHER: "" } },
      db,
      null,
    );

    expect(mcpServerSecrets(created.id, db, null)).toEqual({
      env: { GODOT_TOKEN: "s3cret", OTHER: "keep" },
      headers: {},
    });
  });

  it("replaces a secret when the patch sends a real value, and drops omitted keys", () => {
    const created = createMcpServer(
      stdio("godot", { env: { GODOT_TOKEN: "old", GONE: "x" } }),
      db,
      null,
    );

    updateMcpServer(created.id, { env: { GODOT_TOKEN: "new" } }, db, null);

    expect(mcpServerSecrets(created.id, db, null)?.env).toEqual({
      GODOT_TOKEN: "new",
    });
  });
});

describe("disabling an inherited global for one project", () => {
  it("creates a disabled project entry of the same name", () => {
    const global = createMcpServer(stdio("godot"), db, null);

    const shadow = disableGlobalForProject("proj-1", global.id, db);

    expect(shadow.projectId).toBe("proj-1");
    expect(shadow.name).toBe("godot");
    expect(shadow.enabled).toBe(false);
  });

  it("refuses when the project already has an entry of that name", () => {
    const global = createMcpServer(stdio("godot"), db, null);
    createMcpServer(stdio("godot"), db, "proj-1");

    expect(() => disableGlobalForProject("proj-1", global.id, db)).toThrow(
      McpServerConflictError,
    );
  });

  it("copies the global's shape so a re-enable has something to run", () => {
    const global = createMcpServer(
      stdio("godot", {
        args: ["--headless"],
        agentTypes: ["ticket_build"],
        toolAllowlist: ["list_nodes"],
        usageHint: "scenes and nodes",
      }),
      db,
      null,
    );

    const shadow = disableGlobalForProject("proj-1", global.id, db);

    expect(shadow.transport).toBe("stdio");
    expect(shadow.command).toBe("/usr/bin/godot-mcp");
    expect(shadow.args).toEqual(["--headless"]);
    expect(shadow.agentTypes).toEqual(["ticket_build"]);
    expect(shadow.toolAllowlist).toEqual(["list_nodes"]);
    expect(shadow.usageHint).toBe("scenes and nodes");
  });

  it("does NOT copy the global's secrets", () => {
    const global = createMcpServer(
      stdio("godot", { env: { GODOT_TOKEN: "s3cret" } }),
      db,
      null,
    );

    const shadow = disableGlobalForProject("proj-1", global.id, db);

    // Read through the secret accessor, not the masked view: the point is that
    // the VALUE was never copied, which a "***" mask would hide either way.
    // Looked up IN ITS SCOPE — the shadow is a project row, and the accessor
    // refuses to reach across scopes.
    expect(mcpServerSecrets(shadow.id, db, "proj-1")?.env).toEqual({});
    // The global keeps its own, untouched.
    expect(mcpServerSecrets(global.id, db)?.env).toEqual({ GODOT_TOKEN: "s3cret" });
  });
});

/**
 * The invariant the whole shadowing model rests on: ONE row per name per scope.
 * `resolveExtraMcpServers` drops a global when a project row shares its name,
 * so a duplicate pair would make resolution order silently non-deterministic.
 *
 * The service checks it first (that is what produces the friendly 409), but
 * these tests deliberately go around the service and write raw SQL — the point
 * is that the DATABASE refuses too, so a writer that bypasses the service
 * cannot break the invariant.
 */
describe("per-scope uniqueness is enforced by the database, not only the service", () => {
  const insert = (id: string, projectId: string | null, name: string) =>
    sqlite
      .prepare(
        "INSERT INTO mcp_servers (id, project_id, name, transport, command) " +
          "VALUES (?, ?, ?, 'stdio', '/usr/bin/x')",
      )
      .run(id, projectId, name);

  it("refuses a second global of the same name", () => {
    insert("a", null, "godot");
    // A plain UNIQUE(project_id, name) would NOT catch this: both rows have a
    // NULL project_id and SQLite treats NULLs as distinct. The partial index
    // keyed on `project_id IS NULL` is what makes it a constraint violation.
    expect(() => insert("b", null, "godot")).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a second entry of the same name in one project", () => {
    insert("a", "proj-1", "godot");
    expect(() => insert("b", "proj-1", "godot")).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("still allows the same name once per scope — that is the shadowing case", () => {
    insert("a", null, "godot");
    insert("b", "proj-1", "godot");
    insert("c", "proj-2", "godot");

    const rows = sqlite
      .prepare("SELECT id FROM mcp_servers WHERE name = 'godot' ORDER BY id")
      .all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("update and delete are scoped", () => {
  it("cannot reach a global from the project scope, or the reverse", () => {
    const global = createMcpServer(stdio("godot"), db, null);
    const local = createMcpServer(stdio("playwright"), db, "proj-1");

    expect(() => updateMcpServer(global.id, { enabled: false }, db, "proj-1")).toThrow(
      /not found in this scope/,
    );
    expect(() => deleteMcpServer(local.id, db, null)).toThrow(/not found in this scope/);
  });

  it("rejects an empty patch", () => {
    expect(updateMcpServerSchema.safeParse({}).success).toBe(false);
  });
});
