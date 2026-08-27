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
 * 4. **Never throw.** This runs inside CRUD request handlers; a missing omp
 *    install or an unwritable home directory must not fail a settings save.
 * 5. **Only ever reconcile from the LIVE application database.** These writes
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
import { execFileSync } from "child_process";
import { eq } from "drizzle-orm";
import { db, type ArijDatabase } from "@/lib/db";
import { mcpServers, settings } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";
import { ARIJ_MCP_SERVER_NAME } from "@/lib/claude/mcp-injection";

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

function readManifest(): UserGlobalManifest {
  try {
    const raw = fs.readFileSync(userGlobalManifestPath(), "utf-8");
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

function writeManifest(manifest: UserGlobalManifest): void {
  try {
    const file = userGlobalManifestPath();
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
interface SyncableServer {
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

function syncOmp(servers: SyncableServer[], previouslyOwned: string[]): string[] {
  const configPath = ompMcpConfigPath();

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

function runAgy(args: string[]): boolean {
  try {
    execFileSync("agy", args, {
      stdio: "ignore",
      timeout: 10_000,
      // Never let a hung CLI hold a request handler open.
      killSignal: "SIGKILL",
    });
    return true;
  } catch {
    return false;
  }
}

function agyAvailable(): boolean {
  try {
    execFileSync("agy", ["mcp", "list"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function syncAgy(servers: SyncableServer[], previouslyOwned: string[]): string[] {
  if (!agyAvailable()) return previouslyOwned;

  const wanted = new Set(servers.map((s) => s.name));
  const owned = new Set<string>();

  for (const name of previouslyOwned) {
    if (name === ARIJ_MCP_SERVER_NAME) continue;
    if (!wanted.has(name)) {
      if (!runAgy(["mcp", "remove", name])) {
        // Could not drop it — keep claiming ownership so the next sync retries
        // instead of orphaning an entry Arij put there.
        owned.add(name);
      }
    }
  }

  for (const server of servers) {
    if (runAgy(agyAddArgs(server))) {
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

/**
 * Reconciles the user-global registries with the current GLOBAL servers.
 *
 * Called from the global-scope CRUD paths in lib/mcp/servers.ts. Best-effort
 * and never throws: a settings save must not fail because omp is not
 * installed or a home directory is read-only.
 */
export function syncUserGlobalMcpServers(database: ArijDatabase = db): void {
  try {
    // Rule 5. An injected handle means the caller is not the live app, and
    // nothing but the live app has any business rewriting a user's CLI config.
    if (database !== db) return;
    // Belt and braces: even if some future caller passes the real `db` from a
    // test, a test run must not reach the developer's own home directory.
    if (process.env.VITEST || process.env.NODE_ENV === "test") return;
    if (!isUserGlobalMcpSyncEnabled(database)) return;
    const servers = syncableGlobalServers(database);
    const manifest = readManifest();
    writeManifest({
      omp: syncOmp(servers, manifest.omp),
      agy: syncAgy(servers, manifest.agy),
    });
  } catch (error) {
    console.warn(
      "[mcp-user-global] reconciliation skipped:",
      error instanceof Error ? error.message : error,
    );
  }
}
