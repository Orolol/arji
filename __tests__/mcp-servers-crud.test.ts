/**
 * Story "Schéma, migration et CRUD des serveurs MCP".
 *
 * Covers migration 0045 and its hand-written journal entry, the cascade that
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
const MIGRATION_TAG = "0045_mcp_servers";
const MIGRATION_WHEN = 1786714200000;

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

describe("0045_mcp_servers — migration bookkeeping", () => {
  it("owns a new journal slot with a strictly increasing `when`", () => {
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry?.when).toBe(MIGRATION_WHEN);

    // Drizzle keeps ONE high-water mark and applies only migrations strictly
    // above it, so equality is a collision rather than valid ordering.
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, i) => i === 0 || w > whens[i - 1])).toBe(true);
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs.every((v, i) => i === 0 || v > idxs[i - 1])).toBe(true);
    expect(journal.entries[journal.entries.length - 1]?.tag).toBe(MIGRATION_TAG);
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
    expect(snapshots).not.toContain("0045_snapshot.json");
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
