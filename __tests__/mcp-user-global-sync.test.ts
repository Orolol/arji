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
  createUserGlobalSyncScheduler,
  isUserGlobalMcpSyncEnabled,
  ompMcpConfigPath,
  reconcileUserGlobalMcpServers,
  syncUserGlobalMcpServers,
  syncableGlobalServers,
  whenUserGlobalMcpSyncSettles,
} from "@/lib/mcp/user-global-sync";
import type {
  AgyRunner,
  SyncableServer,
  UserGlobalSyncTargets,
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
 * pipeline ticks and Full Auto for its whole duration — so the spawns have to
 * be awaited rather than blocking, and the module has to stay importable.
 *
 * "Not blocking" is not the same as "not observable": the request path is kept
 * off the event loop, and a caller that needs the result waits for it through
 * the barrier above. The two contracts are independent, which is why they are
 * tested apart.
 */
describe("the request path is never blocked", () => {
  it("schedules rather than performing the work", () => {
    createMcpServer(stdio("godot"), db, null);
    // Synchronous `void` return: the reconciliation cannot have happened
    // inside this call, whatever it goes on to do.
    expect(syncUserGlobalMcpServers(db)).toBeUndefined();
  });

  it("exposes the barrier the route handlers await", async () => {
    // Resolved here because the guards above skip scheduling entirely under
    // VITEST; what the barrier is worth when a pass IS in flight is the
    // "completion barrier" suite's job.
    await expect(whenUserGlobalMcpSyncSettles()).resolves.toBeUndefined();
  });

  it("shells out through no SYNCHRONOUS child_process API", () => {
    // The two tests above document the non-blocking contract but cannot pin it:
    // `syncUserGlobalMcpServers` returns `void` whether the work behind it
    // blocks or not, and the VITEST guard makes it return before spawning
    // anything, so no behavioural assertion can reach the spawn. Reverting
    // `execFileAsync` to `execFileSync` keeps this whole suite green.
    //
    // Hence a source-level check. The finding this pins is a MAJOR one: an
    // inline `execFileSync` on the CRUD request path froze the single-process
    // app — SSE, chunk persistence, the watchdog, pipelines and Full Auto —
    // for ~0.5s per global server, up to (1 + N) x 10s against the timeout
    // ceiling, on every settings save including the Enable/Disable button.
    //
    // The list is Node's COMPLETE set of synchronous child_process entry
    // points, so a regression through any of them fails here rather than
    // slipping past a spot-check of the one that caused the original bug.
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib", "mcp", "user-global-sync.ts"),
      "utf-8",
    );
    // Comments are stripped first: the prose above the implementation names
    // `execFileSync` to explain what it must not do, and that must stay legal.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    for (const sync of ["execSync", "execFileSync", "spawnSync"]) {
      expect(code).not.toMatch(new RegExp(`\\b${sync}\\b`));
    }
    // ...and the async one it does use is still there, so the assertion above
    // cannot pass merely because the spawning code was deleted or renamed.
    expect(code).toMatch(/\bexecFile\b/);
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

/**
 * The completion barrier.
 *
 * Moving reconciliation off the request path fixed a real freeze — a
 * synchronous spawn stopped the whole single-process app — but "scheduled" is
 * not a state a CRUD response can honestly acknowledge. omp and agy hand a
 * session its complete server set when the CLI starts and hold it for the
 * entire run, so a session launched between the HTTP response and the end of
 * reconciliation runs the OLD set: a server the user just deleted still live,
 * a newly enabled one absent, a rotated credential still the previous value —
 * while the database and the injected prompt describe the new set.
 *
 * These tests drive the real reconciliation through a DELIBERATELY SLOW fake
 * `agy`, because the property only exists in the window a fast one closes by
 * accident. "What a session would see" is modelled as the register itself:
 * that is literally where an agy session reads its servers from.
 */
describe("the completion barrier", () => {
  /** An `agy` register a test can inspect, behind a runner it can slow down. */
  function fakeAgy(options: { delayMs?: number } = {}) {
    const register = new Map<string, string[]>();
    const calls: string[][] = [];
    let firstCall: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      firstCall = resolve;
    });

    const runner: AgyRunner = async (args) => {
      calls.push(args);
      firstCall();
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      const verb = args[1];
      if (verb === "list") return true;
      if (verb === "remove") {
        register.delete(args[2]);
        return true;
      }
      if (verb === "add") {
        // `agy mcp add [flags] <name> -- <target> [args...]`, so the name is
        // the token immediately before the separator.
        const separator = args.indexOf("--");
        register.set(args[separator - 1], args.slice(separator + 1));
        return true;
      }
      return false;
    };

    return { register, calls, runner, started };
  }

  const server = (name: string): SyncableServer => ({
    name,
    transport: "stdio",
    command: `/usr/bin/${name}-mcp`,
    args: [],
    env: {},
    url: null,
    headers: {},
  });

  let targets: UserGlobalSyncTargets;
  let agy: ReturnType<typeof fakeAgy>;
  /** The current global set, as the live scheduler reads it from the database. */
  let desired: SyncableServer[];

  const readOmp = (): Record<string, unknown> => {
    if (!fs.existsSync(targets.ompConfigPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(targets.ompConfigPath, "utf-8"));
    return (parsed.mcpServers ?? {}) as Record<string, unknown>;
  };

  const scheduler = () =>
    createUserGlobalSyncScheduler(() =>
      reconcileUserGlobalMcpServers(desired, targets),
    );

  beforeEach(() => {
    agy = fakeAgy({ delayMs: 20 });
    desired = [];
    targets = {
      ompConfigPath: path.join(ompHome, "mcp.json"),
      manifestPath: path.join(ompHome, "manifest.json"),
      runAgy: agy.runner,
    };
  });

  it("has not applied the new set when the request would have answered", async () => {
    desired = [server("godot")];
    const sync = scheduler();

    sync.request();

    // The window the finding is about: a session spawning here freezes a
    // register that does not yet contain the server the user just declared.
    expect(agy.register.has("godot")).toBe(false);
    expect(readOmp().godot).toBeUndefined();

    await sync.settled();

    expect(agy.register.has("godot")).toBe(true);
    expect(readOmp().godot).toMatchObject({ command: "/usr/bin/godot-mcp" });
  });

  it("holds the answer until a DELETED server is really gone from the register", async () => {
    // The access-control half: until agy is told, a deleted server is still
    // mounted in every session that starts, with whatever credentials it had.
    desired = [server("godot")];
    const sync = scheduler();
    sync.request();
    await sync.settled();
    expect(agy.register.has("godot")).toBe(true);

    desired = [];
    sync.request();
    expect(agy.register.has("godot")).toBe(true); // still stale...

    await sync.settled();

    expect(agy.register.has("godot")).toBe(false); // ...and provably not, after
    expect(readOmp().godot).toBeUndefined();
  });

  it("covers a write that lands after the running pass already read its state", async () => {
    // Coalescing must not swallow a write the pending run cannot see. Waiting
    // on the runner's first call is what makes this deterministic: the pass has
    // taken its snapshot by then, so folding into it would lose "playwright".
    desired = [server("godot")];
    const sync = scheduler();
    sync.request();
    await agy.started;

    desired = [server("godot"), server("playwright")];
    sync.request();
    await sync.settled();

    expect([...agy.register.keys()].sort()).toEqual(["godot", "playwright"]);
  });

  it("folds requests that arrive before the pass starts into one pass", async () => {
    desired = [server("godot")];
    const sync = scheduler();

    sync.request();
    sync.request();
    sync.request();
    await sync.settled();

    // A full rebuild, not a delta: three identical passes would be three
    // rounds of child processes for the same result.
    expect(agy.calls.filter((call) => call[1] === "list")).toHaveLength(1);
  });

  it("never lets two passes interleave", async () => {
    // Both passes read the same manifest and drive the same register, so an
    // overlap would leave the loser's idea of "what Arij owns" stale.
    let inFlight = 0;
    let maxInFlight = 0;
    const sync = createUserGlobalSyncScheduler(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await reconcileUserGlobalMcpServers(desired, targets);
      inFlight -= 1;
    });

    desired = [server("godot")];
    sync.request();
    await agy.started;
    desired = [server("playwright")];
    sync.request();
    await sync.settled();

    expect(maxInFlight).toBe(1);
  });

  it("settles rather than rejecting when a pass throws", async () => {
    // The barrier is awaited by request handlers: a settings save must not
    // fail — or hang — because omp is missing or a home directory is read-only.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createUserGlobalSyncScheduler(async () => {
      throw new Error("agy exploded");
    });

    sync.request();
    await expect(sync.settled()).resolves.toBeUndefined();

    // ...and the chain survives it, so the next write is still reconciled.
    const recovering = createUserGlobalSyncScheduler(() =>
      reconcileUserGlobalMcpServers(desired, targets),
    );
    desired = [server("godot")];
    recovering.request();
    await recovering.settled();
    expect(agy.register.has("godot")).toBe(true);

    warn.mockRestore();
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
