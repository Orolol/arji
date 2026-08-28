/**
 * lib/mcp/user-global-sync.ts — reconciling GLOBAL MCP servers into the
 * registries of providers that have no per-spawn surface (oh-my-pi, agy).
 *
 * This module is unusual for Arij: its writes leave both the repository and the
 * process. It edits `~/.omp/agent/mcp.json` and shells out to `agy mcp add`.
 * The tests that matter are therefore the ones proving it does NOT write when
 * it should not, and does not clobber what it does not own.
 *
 * The live-database guard is not a hypothetical. The first run of this
 * feature's CRUD suite wrote two fixture servers into the developer's real
 * ~/.omp/agent/mcp.json and `agy mcp add`ed one of them, because every global
 * create/update/delete calls this function.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { createMcpServer, deleteMcpServer } from "@/lib/mcp/servers";
import {
  isUserGlobalMcpSyncEnabled,
  ompMcpConfigPath,
  syncUserGlobalMcpServers,
  syncableGlobalServers,
  whenUserGlobalMcpSyncSettles,
} from "@/lib/mcp/user-global-sync";

let db: ReturnType<typeof createTestDb>["db"];
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let ompHome: string;

beforeEach(() => {
  const created = createTestDb();
  db = created.db;
  sqlite = created.sqlite;
  sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj-1', 'P1')").run();

  // Never point at the real ~/.omp during a test, whatever the guards say.
  ompHome = fs.mkdtempSync(path.join(os.tmpdir(), "arij-omp-home-"));
  vi.stubEnv("OMP_AGENT_DIR", ompHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  sqlite.close();
  fs.rmSync(ompHome, { recursive: true, force: true });
});

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: "stdio" as const,
  command: `/usr/bin/${name}-mcp`,
  ...extra,
});

describe("the live-database guard", () => {
  it("writes nothing when handed an injected database", () => {
    // Every global CRUD call passes its own handle in tests. If this guard
    // goes, a test run edits the developer's machine.
    createMcpServer(stdio("godot"), db, null);

    syncUserGlobalMcpServers(db);

    expect(fs.existsSync(ompMcpConfigPath())).toBe(false);
  });

  it("still writes nothing on delete", () => {
    const created = createMcpServer(stdio("godot"), db, null);
    deleteMcpServer(created.id, db, null);

    expect(fs.existsSync(ompMcpConfigPath())).toBe(false);
  });

  it("resolves the omp path from OMP_AGENT_DIR", () => {
    expect(ompMcpConfigPath()).toBe(path.join(ompHome, "mcp.json"));
  });
});

describe("what would be reconciled", () => {
  it("takes the ENABLED globals and never a project-scoped server", () => {
    createMcpServer(stdio("godot"), db, null);
    createMcpServer(stdio("disabled-one", { enabled: false }), db, null);
    // A project server cannot be expressed in a user-global registry at all —
    // that is exactly what `extraMcpScope: "user-global"` means.
    createMcpServer(stdio("playwright"), db, "proj-1");

    expect(syncableGlobalServers(db).map((s) => s.name)).toEqual(["godot"]);
  });

  it("carries the unmasked secret values, since the registry needs them literally", () => {
    createMcpServer(stdio("godot", { env: { GODOT_TOKEN: "s3cret" } }), db, null);

    // Accepted exposure, documented in the module header and the provider
    // matrix: for these two CLIs there is no per-session indirection to hang a
    // credential on, so it lands in their config file in clear.
    expect(syncableGlobalServers(db)[0].env).toEqual({ GODOT_TOKEN: "s3cret" });
  });

  it("never offers the reserved arij entry — install.sh owns it", () => {
    sqlite
      .prepare(
        "INSERT INTO mcp_servers (id, project_id, name, transport, command) " +
          "VALUES ('x', NULL, 'arij', 'stdio', '/evil')",
      )
      .run();

    expect(syncableGlobalServers(db).map((s) => s.name)).not.toContain("arij");
  });

  it("describes an http server by url and headers", () => {
    createMcpServer(
      {
        name: "confluence",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer abc" },
      },
      db,
      null,
    );

    expect(syncableGlobalServers(db)[0]).toMatchObject({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" },
    });
  });
});

/**
 * Reconciliation spawns child processes, and `syncUserGlobalMcpServers` is
 * called from CRUD request handlers. Arij is deliberately one process: a
 * SYNCHRONOUS spawn there stops SSE, session chunk persistence, the watchdog,
 * pipeline ticks and Full Auto for its whole duration — so the work has to
 * leave the request path, and the module has to stay importable.
 */
describe("the request path is never blocked", () => {
  it("returns without waiting for the reconciliation", () => {
    createMcpServer(stdio("godot"), db, null);
    // Synchronous `void` return: there is no promise for a handler to await,
    // by construction.
    expect(syncUserGlobalMcpServers(db)).toBeUndefined();
  });

  it("settles through an awaitable the callers do not have to use", async () => {
    await expect(whenUserGlobalMcpSyncSettles()).resolves.toBeUndefined();
  });

  it("imports cleanly when child_process is only partially mocked", async () => {
    // The regression this pins: promisifying `execFile` at MODULE SCOPE reads
    // `child_process` at import time. lib/mcp/servers.ts imports this module,
    // and several suites import THAT while mocking `child_process` with only
    // the members they use — so a module-scope `promisify(execFile)` turned an
    // unrelated test's partial mock into "The 'original' argument must be of
    // type function" on load. Resolving it inside the call keeps import pure.
    vi.resetModules();
    vi.doMock("child_process", () => ({
      spawn: vi.fn(),
      execSync: vi.fn(),
      default: { spawn: vi.fn(), execSync: vi.fn() },
    }));

    await expect(import("@/lib/mcp/user-global-sync")).resolves.toBeDefined();
    await expect(import("@/lib/mcp/servers")).resolves.toBeDefined();

    vi.doUnmock("child_process");
    vi.resetModules();
  });
});

describe("the opt-out setting", () => {
  it("defaults to enabled when the row is absent", () => {
    expect(isUserGlobalMcpSyncEnabled(db)).toBe(true);
  });

  it("is off only for an explicitly false value", () => {
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES ('mcp_user_global_sync', ?)")
      .run(JSON.stringify(false));
    expect(isUserGlobalMcpSyncEnabled(db)).toBe(false);
  });

  it("tolerates a legacy bare string", () => {
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES ('mcp_user_global_sync', 'false')")
      .run();
    expect(isUserGlobalMcpSyncEnabled(db)).toBe(false);
  });
});
