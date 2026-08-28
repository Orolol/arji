/**
 * Reconciling user-declared MCP servers into the registries of providers that
 * have no per-spawn surface (oh-my-pi, agy — `extraMcpScope: "user-global"`).
 *
 * claude-code and codex are handed a complete server set for each spawn, so
 * nothing here concerns them. omp and agy instead read a USER-GLOBAL registry
 * that Arij cannot vary per session:
 *   - omp   → `~/.omp/agent/mcp.json` (the file install.sh writes `arij` into)
 *   - agy   → its own register, owned by `agy mcp add` / `agy mcp remove`.
 *             Measured 2026-08-27: the register really lives in
 *             `~/.gemini/config/mcp_config.json`, NOT the
 *             `~/.gemini/antigravity/mcp_config.json` named in
 *             lib/providers/agy.ts — that path exists but is a 0-byte file on
 *             the current build. Arij goes through the CLI rather than the
 *             file precisely so this drift cannot break it.
 *
 * Reconciling those before every spawn would be racy — two sessions on two
 * projects would rewrite the same file in opposite directions — so the sync
 * runs on CRUD instead, and only GLOBAL servers are honored. That is the whole
 * reason project-scoped servers are dropped for these providers
 * (resolveExtraMcpServers reports them in `excludedProjectScoped`).
 *
 * ## Safety rules
 *
 * 1. **Never clobber what Arij does not own.** A `data/mcp-user-global.json`
 *    manifest records the names Arij last wrote. Removal only ever touches a
 *    name in that manifest, so a server the user added by hand survives.
 * 2. **Never overwrite an unparseable config.** Same rule install.sh applies:
 *    a config we cannot parse is a config we must not rewrite.
 * 3. **Never touch `arij`.** install.sh owns that entry, and its
 *    `${ARIJ_MCP_TOKEN}` indirection is what makes the control channel work.
 * 4. **Never throw, and never block the event loop.** This is requested from
 *    CRUD request handlers, so a missing omp install or an unwritable home
 *    directory must not fail a settings save — and the work must not run
 *    INLINE either. Arij is a single process: a synchronous child-process
 *    spawn stops SSE, session chunk persistence, the watchdog, pipelines and
 *    Full Auto for its whole duration. Every spawn here is therefore awaited
 *    rather than blocking, and the work is scheduled off the call itself.
 * 5. **A global CRUD response must mean the registries already agree with
 *    it.** Scheduling alone is not enough. omp and agy hand a session its
 *    COMPLETE server set when the CLI starts and freeze it for the whole run,
 *    so a session launched between the HTTP response and the end of
 *    reconciliation would silently use the OLD set — a server the user just
 *    deleted still live, a rotated credential still the previous one, a newly
 *    enabled server absent — while the database and the injected prompt both
 *    describe the new one. That is an access-control gap, not a lag.
 *
 *    The fix is a completion barrier rather than a return to inline work: the
 *    route handlers await `whenUserGlobalMcpSyncSettles()` before answering
 *    (lib/mcp/server-routes.ts). Because the spawns are asynchronous, the
 *    event loop stays free for everything else while that one request waits —
 *    rule 4 is intact — and the acknowledgement gains a meaning it did not
 *    have: any session started AFTER a 2xx sees the state that 2xx describes.
 *    A session started DURING the request is unordered with respect to it and
 *    may still see either state, which is what "not yet acknowledged" means.
 * 6. **Only ever reconcile from the LIVE application database.** These writes
 *    leave the repository and the process: they change the user's own CLI
 *    config and shell out to `agy`. Reconciling from anything else — a test's
 *    in-memory database, a migration script, a one-off handle — would push
 *    fixture data onto a real machine. It is not hypothetical: the first run of
 *    this feature's own test suite wrote two fake servers into
 *    ~/.omp/agent/mcp.json and `agy mcp add`ed one of them.
 *
 * ## Accepted secret exposure
 *
 * For these two providers the registry entry has to carry a third-party
 * server's credentials LITERALLY — there is no per-session indirection to hang
 * them on. So an extra's `env`/`headers` values land in
 * `~/.omp/agent/mcp.json` / agy's register, and for agy they additionally pass
 * through `agy mcp add --env K=v` argv, which is readable in
 * `/proc/<pid>/cmdline` for the lifetime of that short-lived process. An agent
 * running under these providers can read either file with its own Bash tool.
 *
 * This is assumed rather than forbidden, and it is surfaced in the UI next to
 * the server's scope warning. The alternative — putting the values in the
 * child's environment — is strictly worse: `/proc/self/environ` is one `cat`
 * away for every tool call the agent makes. Users who will not accept it
 * should keep credential-bearing servers on claude-code/codex, where the
 * config is per-spawn and 0600.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { db, type ArijDatabase } from "@/lib/db";
import { mcpServers, settings } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";
import { ARIJ_MCP_SERVER_NAME } from "@/lib/claude/mcp-injection";

/**
 * Promisified `execFile`, resolved LAZILY.
 *
 * Deliberately not `const execFileAsync = promisify(execFile)` at module
 * scope: that touches `child_process` at import time, and this module is
 * pulled in by lib/mcp/servers.ts, which a good number of suites import while
 * mocking `child_process` with only the members they care about. A partial
 * mock would make `execFile` undefined and `promisify` throw during import,
 * turning an unrelated test's mock into a crash on load. Resolving inside the
 * call keeps importing this module free of side effects — and the guards in
 * `syncUserGlobalMcpServers` mean tests never reach the call at all.
 */
function execFileAsync(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<unknown> {
  return promisify(execFile)(file, args, options ?? {});
}

/**
 * Settings key for the reconciliation toggle. Absent row = ENABLED, matching
 * `mcp_tools_enabled`: a global server the user declared is expected to reach
 * omp and agy, and the epic's provider table lists "global only" as SUPPORTED
 * for them rather than absent. Set it to false to keep Arij out of those
 * files entirely.
 */
export const MCP_USER_GLOBAL_SYNC_SETTING_KEY = "mcp_user_global_sync";

export function isUserGlobalMcpSyncEnabled(database: ArijDatabase = db): boolean {
  const row = database
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, MCP_USER_GLOBAL_SYNC_SETTING_KEY))
    .get();
  if (!row) return true;
  let parsed: unknown = row.value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) legacy string — compare below
    }
  }
  if (parsed === false) return false;
  if (typeof parsed === "string") return parsed.trim().toLowerCase() !== "false";
  return true;
}

/** Where Arij records the names it last wrote into each user-global registry. */
export function userGlobalManifestPath(): string {
  return path.join(process.cwd(), "data", "mcp-user-global.json");
}

/** omp's agent directory. `OMP_AGENT_DIR` mirrors what `omp config path` prints. */
export function ompMcpConfigPath(): string {
  const agentDir =
    process.env.OMP_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
  return path.join(agentDir, "mcp.json");
}

interface UserGlobalManifest {
  /** Server names Arij last wrote, per target registry. */
  omp: string[];
  agy: string[];
}

const EMPTY_MANIFEST: UserGlobalManifest = { omp: [], agy: [] };

function readManifest(file: string): UserGlobalManifest {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_MANIFEST };
    const record = parsed as Record<string, unknown>;
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    return { omp: list(record.omp), agy: list(record.agy) };
  } catch {
    // Absent or unreadable: Arij has written nothing it can prove it owns, so
    // it removes nothing. Foreign entries are safe by construction.
    return { ...EMPTY_MANIFEST };
  }
}

function writeManifest(file: string, manifest: UserGlobalManifest): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (error) {
    console.warn(
      "[mcp-user-global] could not record the ownership manifest:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** A global server as this module needs it — unmasked, straight from the row. */
export interface SyncableServer {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
}

function parseJsonObject(blob: string | null): Record<string, string> {
  if (!blob) return {};
  try {
    const parsed: unknown = JSON.parse(blob);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : String(v ?? ""),
      ]),
    );
  } catch {
    return {};
  }
}

function parseJsonStringArray(blob: string | null): string[] {
  if (!blob) return [];
  try {
    const parsed: unknown = JSON.parse(blob);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * The ENABLED global servers, unmasked. Project-scoped rows are deliberately
 * absent: they are what `user-global` scope cannot express.
 */
export function syncableGlobalServers(database: ArijDatabase = db): SyncableServer[] {
  return database
    .select()
    .from(mcpServers)
    .where(isNull(mcpServers.projectId))
    .all()
    .filter((row) => row.enabled && row.name !== ARIJ_MCP_SERVER_NAME)
    .map((row) => ({
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: parseJsonStringArray(row.args),
      env: parseJsonObject(row.env),
      url: row.url,
      headers: parseJsonObject(row.headers),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* oh-my-pi — a JSON file we merge into                                */
/* ------------------------------------------------------------------ */

function syncOmp(
  configPath: string,
  servers: SyncableServer[],
  previouslyOwned: string[],
): string[] {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf-8");
    } catch (error) {
      console.warn(
        `[mcp-user-global] omp: cannot read ${configPath}, leaving it untouched:`,
        error instanceof Error ? error.message : error,
      );
      return previouslyOwned;
    }
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        } else {
          throw new Error("not a JSON object");
        }
      } catch {
        // Rule 2: a config we cannot parse is a config we must not rewrite.
        console.warn(
          `[mcp-user-global] omp: ${configPath} is not valid JSON — left untouched`,
        );
        return previouslyOwned;
      }
    }
  }

  const existing =
    config.mcpServers && typeof config.mcpServers === "object"
      ? ({ ...(config.mcpServers as Record<string, unknown>) })
      : {};

  // Rule 1 + 3: drop only names Arij wrote last time and no longer owns, and
  // never the control channel.
  const wanted = new Set(servers.map((s) => s.name));
  for (const name of previouslyOwned) {
    if (name === ARIJ_MCP_SERVER_NAME) continue;
    if (!wanted.has(name)) delete existing[name];
  }

  for (const server of servers) {
    existing[server.name] =
      server.transport === "stdio"
        ? {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env,
          }
        : { type: "http", url: server.url, headers: server.headers };
  }

  config.mcpServers = existing;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf-8",
      // The file now holds third-party credentials literally (see the header).
      mode: 0o600,
    });
  } catch (error) {
    console.warn(
      `[mcp-user-global] omp: could not write ${configPath}:`,
      error instanceof Error ? error.message : error,
    );
    return previouslyOwned;
  }
  return [...wanted];
}

/* ------------------------------------------------------------------ */
/* agy — a register behind a CLI                                       */
/* ------------------------------------------------------------------ */

/**
 * Measured on the installed build: `agy mcp add [flags] <name> <commandOrUrl>
 * [args...]`, with `--env KEY=value` and `--header 'Key: Value'` repeatable,
 * `--type stdio|http`, and FLAGS BEFORE `<name>` (a flag after it is
 * rejected). `--` separates a command or arg that starts with `-`.
 * `agy mcp remove <name>` drops one.
 *
 * `agy mcp add` is an upsert ("Add or update"), so re-running it is how a
 * changed server is applied; there is no separate update verb.
 *
 * Verified against the installed CLI: a stdio add persists `command`/`args`/
 * `env`, an http add persists `serverUrl`/`headers`, and `--` is accepted
 * before either kind of target.
 */
function agyAddArgs(server: SyncableServer): string[] {
  const flags: string[] = [];
  if (server.transport === "http") {
    flags.push("--type", "http");
    for (const [key, value] of Object.entries(server.headers)) {
      flags.push("--header", `${key}: ${value}`);
    }
  } else {
    for (const [key, value] of Object.entries(server.env)) {
      flags.push("--env", `${key}=${value}`);
    }
  }
  const target = server.transport === "http" ? server.url ?? "" : server.command ?? "";
  const trailing = server.transport === "http" ? [] : server.args;
  // `--` guards a command or argument that begins with "-", which agy would
  // otherwise parse as one of its own flags.
  return [
    "mcp",
    "add",
    ...flags,
    server.name,
    "--",
    target,
    ...trailing,
  ];
}

/**
 * Runs one `agy` subcommand.
 *
 * ASYNC on purpose. The synchronous form blocks the Node event loop, and Arij
 * is deliberately a single process: SSE subscriptions, session chunk
 * persistence, the stalled-session watchdog, pipeline ticks and Full Auto all
 * stop while a spawn is in flight. With one `mcp list` probe plus one call per
 * global server, and a 10s timeout ceiling each, a hung CLI could freeze the
 * orchestrator for (1 + N) × 10s. Awaiting `execFile` keeps the loop free while
 * the child runs.
 */
async function runAgy(args: string[]): Promise<boolean> {
  try {
    await execFileAsync("agy", args, {
      timeout: 10_000,
      killSignal: "SIGKILL",
      // `execFile` BUFFERS output that the old synchronous call discarded with
      // `stdio: "ignore"`. Past the ceiling Node kills the child and rejects,
      // which here reads as "agy is unavailable" and skips the whole sync — so
      // the ceiling is set well above any plausible `mcp list` rather than left
      // at the 1 MiB default.
      maxBuffer: 16 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one `agy` subcommand and reports whether it succeeded.
 *
 * Injected rather than imported so the reconciliation can be exercised
 * end-to-end without an `agy` on the machine — and, more to the point, with a
 * SLOW one: the completion barrier below is only worth anything if a test can
 * hold reconciliation open and observe what a session would see meanwhile.
 */
export type AgyRunner = (args: string[]) => Promise<boolean>;

async function syncAgy(
  runner: AgyRunner,
  servers: SyncableServer[],
  previouslyOwned: string[],
): Promise<string[]> {
  if (!(await runner(["mcp", "list"]))) return previouslyOwned;

  const wanted = new Set(servers.map((s) => s.name));
  const owned = new Set<string>();

  for (const name of previouslyOwned) {
    if (name === ARIJ_MCP_SERVER_NAME) continue;
    if (!wanted.has(name)) {
      if (!(await runner(["mcp", "remove", name]))) {
        // Could not drop it — keep claiming ownership so the next sync retries
        // instead of orphaning an entry Arij put there.
        owned.add(name);
      }
    }
  }

  for (const server of servers) {
    if (await runner(agyAddArgs(server))) {
      owned.add(server.name);
    } else {
      console.warn(
        `[mcp-user-global] agy: \`agy mcp add ${server.name}\` failed — the server will not be available to agy sessions`,
      );
    }
  }

  return [...owned];
}

/* ------------------------------------------------------------------ */

/** Everything one reconciliation writes to, so a test can point it elsewhere. */
export interface UserGlobalSyncTargets {
  /** omp's `mcp.json`. */
  ompConfigPath: string;
  /** Arij's ownership manifest (rule 1). */
  manifestPath: string;
  runAgy: AgyRunner;
}

/**
 * One reconciliation pass: bring both registries in line with `servers`.
 *
 * A full rebuild from the given list rather than a delta — that is what lets
 * the scheduler below coalesce requests, and what makes a missed run
 * self-healing rather than permanently divergent.
 */
export async function reconcileUserGlobalMcpServers(
  servers: SyncableServer[],
  targets: UserGlobalSyncTargets,
): Promise<void> {
  const manifest = readManifest(targets.manifestPath);
  // omp first (pure file I/O), then agy (child processes) — order is not
  // load-bearing, but keeping the cheap one first means a hanging agy cannot
  // delay the file that most setups actually use.
  const omp = syncOmp(targets.ompConfigPath, servers, manifest.omp);
  const agy = await syncAgy(targets.runAgy, servers, manifest.agy);
  writeManifest(targets.manifestPath, { omp, agy });
}

/**
 * Serialization, coalescing, and the completion barrier for the background
 * reconciliation.
 *
 * **Serialization.** Two writes landing together must not interleave: both
 * would read the same manifest, rewrite the same mcp.json, and drive
 * `agy mcp add/remove` against the same register, so the loser's view of "what
 * Arij owns" would be stale. Runs are therefore chained.
 *
 * **Coalescing.** Every create/update/delete asks for a sync, and
 * reconciliation is a full rebuild from current database state rather than a
 * delta — so N queued runs would do identical work N times. At most ONE run is
 * ever pending behind the active one; further requests fold into it.
 *
 * That fold is only sound because of a pairing this function and `run` have to
 * honour together: `queued` is cleared immediately BEFORE `run()` is invoked,
 * and `run()` reads the database synchronously before its first `await`. So
 * while `queued` is true the pending run has provably not looked at the
 * database yet and will see the write that folded into it; once it has looked,
 * `queued` is false and the next write schedules a fresh run of its own.
 *
 * **The barrier.** `settled()` resolves when every run requested so far has
 * finished. It is what makes a global CRUD response mean something (rule 5):
 * omp and agy freeze a session's server set at spawn, so "scheduled" is not a
 * state a caller can safely acknowledge. Exposed as a factory rather than
 * hard-wired so it can be driven by a test with a deliberately slow runner —
 * a barrier nothing can hold open is a barrier nothing can verify.
 */
export function createUserGlobalSyncScheduler(run: () => Promise<void>): {
  request: () => void;
  settled: () => Promise<void>;
} {
  let active: Promise<void> = Promise.resolve();
  let queued = false;

  return {
    request() {
      if (queued) return; // an already-pending run will see this write too
      queued = true;
      active = active
        .then(() => {
          queued = false;
          return run();
        })
        .catch((error) => {
          // Never an unhandled rejection: `active` is handed to request
          // handlers, and a settings save must not fail because omp is not
          // installed or a home directory is read-only.
          console.warn(
            "[mcp-user-global] reconciliation skipped:",
            error instanceof Error ? error.message : error,
          );
        });
    },
    settled() {
      return active;
    },
  };
}

/** The live targets: the user's real files and the real `agy` on PATH. */
function liveTargets(): UserGlobalSyncTargets {
  return {
    ompConfigPath: ompMcpConfigPath(),
    manifestPath: userGlobalManifestPath(),
    runAgy,
  };
}

/**
 * Reconciles from the live database. Synchronous up to its first `await`,
 * which is the invariant `createUserGlobalSyncScheduler` folds requests on —
 * do not introduce an `await` before `syncableGlobalServers` reads.
 */
async function reconcileLive(): Promise<void> {
  if (!isUserGlobalMcpSyncEnabled(db)) return;
  await reconcileUserGlobalMcpServers(syncableGlobalServers(db), liveTargets());
}

const scheduler = createUserGlobalSyncScheduler(reconcileLive);

/**
 * Requests reconciliation of the user-global registries with the current
 * GLOBAL servers.
 *
 * Returns IMMEDIATELY and does the work in the background: the CRUD paths in
 * lib/mcp/servers.ts are request handlers, and an inline synchronous version
 * froze the whole single-process app for the duration of every settings save,
 * including the one-click Enable/Disable button.
 *
 * "In the background" is not the same as "unobserved", though — see rule 5.
 * Callers that are about to ACKNOWLEDGE the write, or to spawn a session that
 * would freeze the registry's contents for its whole run, must await
 * `whenUserGlobalMcpSyncSettles()` first. The route handlers do
 * (lib/mcp/server-routes.ts).
 *
 * Best-effort and never throws — into the caller OR as an unhandled rejection.
 */
export function syncUserGlobalMcpServers(database: ArijDatabase = db): void {
  // These guards run SYNCHRONOUSLY, before anything is scheduled, so a test or
  // a non-live caller never even queues work.
  //
  // Rule 6. An injected handle means the caller is not the live app, and
  // nothing but the live app has any business rewriting a user's CLI config.
  if (database !== db) return;
  // Belt and braces: even if some future caller passes the real `db` from a
  // test, a test run must not reach the developer's own home directory.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;

  scheduler.request();
}

/**
 * Resolves once every reconciliation requested so far has finished.
 *
 * The completion barrier of rule 5, and the reason it is safe for a route to
 * answer at all: awaiting this before responding is what makes "200 OK" mean
 * "omp's mcp.json and agy's register already say this", rather than "a process
 * that will eventually say this has been started". Never rejects.
 */
export function whenUserGlobalMcpSyncSettles(): Promise<void> {
  return scheduler.settled();
}
