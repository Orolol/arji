/**
 * Third-party MCP servers — user-declared servers (Godot, Confluence,
 * Playwright, …) that ride alongside the Arij tool channel into agent
 * sessions and CLI chat turns.
 *
 * Two scopes: `projectId` NULL = a global server, injected into every
 * project's sessions; a value scopes the server to one project.
 * Resolution order at spawn time (resolveExtraMcpServers): the arij channel
 * first, then globals, then the project's own — a project entry SHADOWS a
 * global of the same name. The name `arij` is reserved so no user entry can
 * ever mask the control channel.
 *
 * Provider scope (story: "Descripteur de capacité par provider"): providers
 * without a per-spawn MCP surface (oh-my-pi, agy — `extraMcpScope`
 * "user-global") honor globals only. Their project-scoped servers are
 * dropped with a trace, and the user-global config (omp's mcp.json / agy's
 * register) is reconciled at CRUD time — see lib/mcp/user-global-sync.ts.
 *
 * Secret posture: `env` and `headers` values are WRITE-ONLY. Every read
 * masks them as "***" (maskMcpServerSecrets), so the API never round-trips
 * a secret; an update that sends "***" or "" for a key keeps the stored
 * value (the password-field contract), and a key absent from the update
 * map is dropped.
 *
 * Size posture: `env` / `args` / `headers` / `toolAllowlist` / `usageHint`
 * are capped (constants below). Over-sized input is REJECTED with an
 * explicit validation error — never truncated — the same error shape an
 * invalid enum value produces.
 */

import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, type ArijDatabase } from "@/lib/db";
import { mcpServers, type McpServer } from "@/lib/db/schema";
import { ARIJ_MCP_SERVER_NAME } from "@/lib/claude/mcp-injection";
import type { McpServerSpec } from "@/lib/providers/types";
import {
  USER_GLOBAL_EXTRA_MCP_PROVIDERS,
  extraMcpScopeForProvider,
} from "@/lib/providers/extra-mcp-scope";
import { createId } from "@/lib/utils/nanoid";
import {
  MCP_SERVER_ARGS_MAX_ITEMS,
  MCP_SERVER_ARGS_MAX_TOTAL_LENGTH,
  MCP_SERVER_ARG_MAX_LENGTH,
  MCP_SERVER_AGENT_TYPES_MAX_ITEMS,
  MCP_SERVER_AGENT_TYPE_MAX_LENGTH,
  MCP_SERVER_COMMAND_MAX_LENGTH,
  MCP_SERVER_ENV_KEY_MAX_LENGTH,
  MCP_SERVER_ENV_MAX_KEYS,
  MCP_SERVER_ENV_VALUE_MAX_LENGTH,
  MCP_SERVER_HEADERS_KEY_MAX_LENGTH,
  MCP_SERVER_HEADERS_MAX_KEYS,
  MCP_SERVER_HEADERS_VALUE_MAX_LENGTH,
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_SECRET_MASK,
  MCP_SERVER_TOOL_ALLOWLIST_MAX_ITEMS,
  MCP_SERVER_TOOL_NAME_MAX_LENGTH,
  MCP_SERVER_URL_MAX_LENGTH,
  MCP_SERVER_USAGE_HINT_MAX_LENGTH,
  type McpServerTransport,
  type McpServerView,
} from "./server-limits";
import { syncUserGlobalMcpServers } from "./user-global-sync";

// ---------------------------------------------------------------------------
// Caps and the read-side view type live in ./server-limits so CLIENT code can
// import them without dragging @/lib/db and child_process into the bundle.
// Re-exported here so server-side callers keep one import site.
// ---------------------------------------------------------------------------

export * from "./server-limits";


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME_RE = /^[a-z0-9_-]+$/;

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const secretMap = (
  keyMax: number,
  valueMax: number
): z.ZodRecord<z.ZodString, z.ZodString> =>
  z.record(
    z.string().min(1, "secret keys must be non-empty").max(keyMax),
    z.string().max(valueMax)
  );

const mcpServerFields = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(MCP_SERVER_NAME_MAX_LENGTH)
    .regex(
      MCP_SERVER_NAME_RE,
      `name must match [a-z0-9_-]+ (lowercase, no spaces)`
    ),
  enabled: z.boolean().optional(),
  transport: z.enum(["stdio", "http"]).optional(),
  command: z
    .string()
    .min(1, "command must be non-empty")
    .max(MCP_SERVER_COMMAND_MAX_LENGTH)
    .optional()
    .nullable(),
  args: z
    .array(z.string().min(1, "args must be non-empty").max(MCP_SERVER_ARG_MAX_LENGTH))
    .max(MCP_SERVER_ARGS_MAX_ITEMS)
    .optional()
    .nullable(),
  env: secretMap(
    MCP_SERVER_ENV_KEY_MAX_LENGTH,
    MCP_SERVER_ENV_VALUE_MAX_LENGTH
  ).optional()
    .nullable(),
  url: z
    .string()
    .min(1, "url must be non-empty")
    .max(MCP_SERVER_URL_MAX_LENGTH)
    .optional()
    .nullable(),
  headers: secretMap(
    MCP_SERVER_HEADERS_KEY_MAX_LENGTH,
    MCP_SERVER_HEADERS_VALUE_MAX_LENGTH
  ).optional()
    .nullable(),
  agentTypes: z
    .array(
      z
        .string()
        .min(1, "agent types must be non-empty")
        .max(MCP_SERVER_AGENT_TYPE_MAX_LENGTH)
    )
    .max(MCP_SERVER_AGENT_TYPES_MAX_ITEMS)
    .optional()
    .nullable(),
  toolAllowlist: z
    .array(
      z
        .string()
        .min(1, "tool names must be non-empty")
        .max(MCP_SERVER_TOOL_NAME_MAX_LENGTH)
    )
    .max(MCP_SERVER_TOOL_ALLOWLIST_MAX_ITEMS)
    .optional()
    .nullable(),
  usageHint: z
    .string()
    .max(MCP_SERVER_USAGE_HINT_MAX_LENGTH)
    .optional()
    .nullable(),
});

/**
 * Shape rules that hold on the EFFECTIVE (merged) state of a server.
 * Exported so the update path can re-validate after merging the patch over
 * the stored row — the patch alone may legally be transport-incomplete.
 */
export interface McpServerShape {
  name?: string;
  transport?: McpServerTransport;
  command?: string | null;
  url?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  usageHint?: string | null;
}

export function validateMcpServerShape(
  value: McpServerShape,
  issue: (message: string, path?: PropertyKey) => void
): void {
  if (value.name === ARIJ_MCP_SERVER_NAME) {
    issue(
      `the name "${ARIJ_MCP_SERVER_NAME}" is reserved for Arij's own tool channel`,
      "name"
    );
    return;
  }

  const transport = value.transport ?? "stdio";
  if (transport === "stdio") {
    if (!value.command) {
      issue("command is required for a stdio server", "command");
    }
    if (value.url) {
      issue("url is not allowed on a stdio server", "url");
    }
    if (value.args && JSON.stringify(value.args).length > MCP_SERVER_ARGS_MAX_TOTAL_LENGTH) {
      issue(
        `args exceed the ${MCP_SERVER_ARGS_MAX_TOTAL_LENGTH}-character limit`,
        "args"
      );
    }
  } else {
    if (!value.url) {
      issue("url is required for an http server", "url");
    } else if (!isAbsoluteHttpUrl(value.url)) {
      issue("url must be an absolute http(s) URL", "url");
    }
    if (value.command) {
      issue("command is not allowed on an http server", "command");
    }
    // LENGTH, not truthiness: `effectiveState` normalises a missing `args`
    // column to `[]`, and an empty array is truthy. A bare `if (value.args)`
    // therefore fired on EVERY update of an http server — including the
    // one-click enable/disable toggle, and including a transport switch that
    // correctly sent `args: null` — making http servers uneditable outright.
    if (value.args && value.args.length > 0) {
      issue("args are not allowed on an http server", "args");
    }
  }

  if (value.env) {
    if (Object.keys(value.env).length > MCP_SERVER_ENV_MAX_KEYS) {
      issue(`env has at most ${MCP_SERVER_ENV_MAX_KEYS} entries`, "env");
    }
  }
  if (value.headers) {
    if (Object.keys(value.headers).length > MCP_SERVER_HEADERS_MAX_KEYS) {
      issue(
        `headers have at most ${MCP_SERVER_HEADERS_MAX_KEYS} entries`,
        "headers"
      );
    }
  }
}

/** `POST`/create — every field optional except name; shape validated. */
export const createMcpServerSchema = mcpServerFields.superRefine(
  (value, ctx) => {
    const issue = (message: string, path?: PropertyKey) =>
      ctx.addIssue({
        code: "custom",
        message,
        path: path === undefined ? [] : [path],
      });
    validateMcpServerShape(value, issue);
  }
);

/** `PATCH` — partial; explicit null clears a field. Shape validated post-merge. */
export const updateMcpServerSchema = mcpServerFields
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Invalid user input (400) — validation errors share this shape. */
export class McpServerValidationError extends Error {}
/** Server id unknown in this scope (404). */
export class McpServerNotFoundError extends Error {}
/** Name already taken in this scope (409). */
export class McpServerConflictError extends Error {}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

function parseSecretMap(blob: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(blob);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === "string" ? v : String(v ?? ""),
        ])
      );
    }
    return {};
  } catch {
    // Only the service writes these blobs; an unparseable blob is a bug.
    console.warn(
      "[mcp-servers] unparseable secret blob, masking as empty:",
      blob.slice(0, 80)
    );
    return {};
  }
}


function parseJsonArray(blob: string | null): string[] | null {
  if (blob === null) return null;
  try {
    const parsed: unknown = JSON.parse(blob);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A read-side projection of a row: env/headers values replaced by the mask
 * (keys kept, so the UI can render the password fields it must leave blank
 * to preserve), every JSON blob parsed.
 */
export function maskMcpServerSecrets(row: McpServer): McpServerView {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    transport: row.transport,
    command: row.command,
    args: parseJsonArray(row.args) ?? [],
    env: Object.fromEntries(
      Object.keys(parseSecretMap(row.env)).map((key) => [
        key,
        MCP_SERVER_SECRET_MASK,
      ])
    ),
    url: row.url,
    headers: Object.fromEntries(
      Object.keys(parseSecretMap(row.headers)).map((key) => [
        key,
        MCP_SERVER_SECRET_MASK,
      ])
    ),
    agentTypes: parseJsonArray(row.agentTypes),
    toolAllowlist: parseJsonArray(row.toolAllowlist),
    usageHint: row.usageHint,
    lastCheckedAt: row.lastCheckedAt,
    lastCheckOk: row.lastCheckOk,
    lastCheckError: row.lastCheckError,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function rowsForScope(database: ArijDatabase, projectId: string | null) {
  return projectId === null
    ? database
        .select()
        .from(mcpServers)
        .where(isNull(mcpServers.projectId))
        .all()
    : database
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.projectId, projectId))
        .all();
}

function rowForId(
  database: ArijDatabase,
  projectId: string | null,
  serverId: string
): McpServer | undefined {
  return projectId === null
    ? database
        .select()
        .from(mcpServers)
        .where(and(eq(mcpServers.id, serverId), isNull(mcpServers.projectId)))
        .get()
    : database
        .select()
        .from(mcpServers)
        .where(and(eq(mcpServers.id, serverId), eq(mcpServers.projectId, projectId)))
        .get();
}

function existingName(
  database: ArijDatabase,
  projectId: string | null,
  name: string,
  excludeId?: string
): McpServer | undefined {
  const scope = projectId === null ? isNull(mcpServers.projectId) : eq(mcpServers.projectId, projectId);
  const rows = database
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.name, name), scope))
    .all();
  return rows.find((row) => row.id !== excludeId);
}

/**
 * Lists the servers of a scope, masked. `projectId` null = the global
 * scope.
 */
export function listMcpServers(
  database: ArijDatabase = db,
  projectId: string | null = null
): McpServerView[] {
  return rowsForScope(database, projectId).map(maskMcpServerSecrets);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function serializeBlob(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/**
 * PATCH secret-map merge: "***" or "" for a key keeps the stored value
 * (password field left blank); a real value replaces it; a key absent from
 * the patch map is dropped.
 */
function mergeSecretMap(
  storedBlob: string,
  patch: Record<string, string> | null | undefined
): Record<string, string> {
  if (patch === null || patch === undefined) return parseSecretMap(storedBlob);
  const stored = parseSecretMap(storedBlob);
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === MCP_SERVER_SECRET_MASK || value === "") {
      if (key in stored) merged[key] = stored[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function effectiveState(row: McpServer, patch: UpdateMcpServerInput) {
  const transport =
    patch.transport !== undefined
      ? patch.transport
      : row.transport;
  const command =
    patch.command !== undefined ? (patch.command ?? null) : row.command;
  const url = patch.url !== undefined ? (patch.url ?? null) : row.url;
  const args = patch.args !== undefined ? (patch.args ?? []) : parseJsonArray(row.args) ?? [];
  const env = patch.env !== undefined ? mergeSecretMap(row.env, patch.env) : parseSecretMap(row.env);
  const headers =
    patch.headers !== undefined
      ? mergeSecretMap(row.headers, patch.headers)
      : parseSecretMap(row.headers);
  const usageHint =
    patch.usageHint !== undefined ? (patch.usageHint ?? null) : row.usageHint;
  const name = patch.name !== undefined ? patch.name : row.name;
  return { name, transport, command, url, args, env, headers, usageHint };
}

/**
 * Throws the FIRST shape problem as a validation error (400). Same error
 * class an invalid enum value produces, so an over-long `env` value and an
 * unknown transport reach the UI down one path — see the named-agent persona
 * rule this mirrors (lib/agent-config/named-agents.ts).
 */
function assertShape(state: McpServerShape): void {
  const problems: string[] = [];
  validateMcpServerShape(state, (message) => {
    problems.push(message);
  });
  if (problems.length > 0) throw new McpServerValidationError(problems[0]);
}

/**
 * Creates a server in a scope. Throws McpServerValidationError (400) on
 * invalid input and McpServerConflictError (409) on a taken name.
 */
export function createMcpServer(
  input: CreateMcpServerInput,
  database: ArijDatabase = db,
  projectId: string | null = null
): McpServerView {
  assertShape(input);
  const taken = existingName(database, projectId, input.name);
  if (taken) {
    throw new McpServerConflictError(
      `a ${projectId === null ? "global" : "project"} MCP server named "${input.name}" already exists`
    );
  }

  const id = createId();
  database.insert(mcpServers)
    .values({
      id,
      projectId,
      name: input.name,
      enabled: input.enabled ?? true,
      transport: input.transport ?? "stdio",
      command: input.command ?? null,
      args: serializeBlob(input.args ?? []),
      env: serializeBlob(input.env ?? {}),
      url: input.url ?? null,
      headers: serializeBlob(input.headers ?? {}),
      agentTypes:
        input.agentTypes === null || input.agentTypes === undefined
          ? null
          : serializeBlob(input.agentTypes),
      toolAllowlist:
        input.toolAllowlist === null || input.toolAllowlist === undefined
          ? null
          : serializeBlob(input.toolAllowlist),
      usageHint: input.usageHint ?? null,
    })
    .run();

  if (projectId === null) syncUserGlobalMcpServers(database);
  return maskMcpServerSecrets(rowForId(database, projectId, id)!);
}

/**
 * Partially updates a server. Shape validation runs on the MERGED state so
 * a patch cannot leave the row transport-inconsistent. Name changes are
 * subject to the same per-scope uniqueness (409).
 */
export function updateMcpServer(
  serverId: string,
  patch: UpdateMcpServerInput,
  database: ArijDatabase = db,
  projectId: string | null = null
): McpServerView {
  const row = rowForId(database, projectId, serverId);
  if (!row) {
    throw new McpServerNotFoundError(
      `MCP server "${serverId}" not found in this scope`
    );
  }

  const state = effectiveState(row, patch);
  assertShape(state);
  if (patch.name !== undefined && patch.name !== row.name) {
    const taken = existingName(database, projectId, patch.name, serverId);
    if (taken) {
      throw new McpServerConflictError(
        `a ${projectId === null ? "global" : "project"} MCP server named "${patch.name}" already exists`
      );
    }
  }

  database.update(mcpServers)
    .set({
      name: state.name,
      enabled: patch.enabled !== undefined ? patch.enabled : row.enabled,
      transport: state.transport,
      command: state.command,
      args: serializeBlob(state.args),
      env: serializeBlob(state.env),
      url: state.url,
      headers: serializeBlob(state.headers),
      agentTypes:
        patch.agentTypes !== undefined
          ? patch.agentTypes === null
            ? null
            : serializeBlob(patch.agentTypes)
          : row.agentTypes,
      toolAllowlist:
        patch.toolAllowlist !== undefined
          ? patch.toolAllowlist === null
            ? null
            : serializeBlob(patch.toolAllowlist)
          : row.toolAllowlist,
      usageHint: state.usageHint,
    })
    .where(eq(mcpServers.id, serverId))
    .run();

  if (projectId === null) syncUserGlobalMcpServers(database);
  return maskMcpServerSecrets(rowForId(database, projectId, serverId)!);
}

/** Deletes a server in a scope. 404 when absent. */
export function deleteMcpServer(
  serverId: string,
  database: ArijDatabase = db,
  projectId: string | null = null
): void {
  const row = rowForId(database, projectId, serverId);
  if (!row) {
    throw new McpServerNotFoundError(
      `MCP server "${serverId}" not found in this scope`
    );
  }
  database.delete(mcpServers).where(eq(mcpServers.id, serverId)).run();
  if (projectId === null) syncUserGlobalMcpServers(database);
}

/**
 * Locally disables an inherited GLOBAL server for one project by shadowing
 * it with a project row of the same name (`enabled: false`). 409 when a
 * shadow already exists: edit it instead.
 *
 * The copy carries the global's shape (transport, command, args, url,
 * agent types, tool allowlist, hint) but NOT its secrets. A disabled row is
 * never spawned, so it needs none — and copying them would be actively
 * harmful in the case the docstring and the UI both invite next: re-enabling
 * the shadow as a real override. That override would then run on a snapshot
 * of the credentials taken at disable time, and rotating the global's token
 * would leave it silently presenting the old one, with nothing on screen
 * showing the two rows had ever diverged. It would also put a second copy of
 * a live credential in the database for a row whose whole purpose is NOT to
 * run the server.
 *
 * Re-enabling therefore requires entering the credentials explicitly, through
 * the normal edit flow.
 */
export function disableGlobalForProject(
  projectId: string,
  globalServerId: string,
  database: ArijDatabase = db
): McpServerView {
  const globalRow = rowForId(database, null, globalServerId);
  if (!globalRow) {
    throw new McpServerNotFoundError(
      `global MCP server "${globalServerId}" not found`
    );
  }
  const shadow = existingName(database, projectId, globalRow.name);
  if (shadow) {
    throw new McpServerConflictError(
      `this project already has a server named "${globalRow.name}" — edit it instead`
    );
  }

  const id = createId();
  database.insert(mcpServers)
    .values({
      id,
      projectId,
      name: globalRow.name,
      enabled: false,
      transport: globalRow.transport,
      command: globalRow.command,
      args: globalRow.args,
      // Shape yes, secrets no — see the docstring.
      env: "{}",
      url: globalRow.url,
      headers: "{}",
      agentTypes: globalRow.agentTypes,
      toolAllowlist: globalRow.toolAllowlist,
      usageHint: globalRow.usageHint,
    })
    .run();
  return maskMcpServerSecrets(rowForId(database, projectId, id)!);
}

/**
 * Records a connection-test outcome (story: test de connexion). `ok` null
 * clears a previous result (not expected from the API, but legal).
 */
export function persistMcpServerCheck(
  serverId: string,
  ok: boolean | null,
  error: string | null,
  database: ArijDatabase = db,
  projectId: string | null = null
): void {
  const row = rowForId(database, projectId, serverId);
  if (!row) {
    throw new McpServerNotFoundError(
      `MCP server "${serverId}" not found in this scope`
    );
  }
  database.update(mcpServers)
    .set({
      lastCheckedAt: new Date().toISOString(),
      lastCheckOk: ok,
      lastCheckError: ok ? null : error,
    })
    .where(eq(mcpServers.id, serverId))
    .run();
}

/** The UNMASKED fields of a server — for the spawn path and the test probe. */
export interface McpServerSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export function mcpServerSecrets(
  serverId: string,
  database: ArijDatabase = db,
  projectId: string | null = null
): McpServerSecrets | undefined {
  const row = rowForId(database, projectId, serverId);
  if (!row) return undefined;
  return { env: parseSecretMap(row.env), headers: parseSecretMap(row.headers) };
}

// ---------------------------------------------------------------------------
// Resolution — what a session actually gets
// ---------------------------------------------------------------------------

function agentTypesInclude(blob: string | null, agentType: string | null): boolean {
  const list = parseJsonArray(blob);
  if (list === null) return true; // NULL = every type (and chat)
  if (!agentType) return false;
  return list.includes(agentType);
}

function rowToSpec(
  row: McpServer,
  context: string
): McpServerSpec & { usageHint: string | null } | null {
  const transport = row.transport;
  if (transport === "stdio") {
    if (!row.command) {
      console.warn(
        `[mcp-servers] skipping ${context} "${row.name}": stdio server without a command`
      );
      return null;
    }
    return {
      name: row.name,
      command: row.command,
      args: parseJsonArray(row.args) ?? [],
      env: parseSecretMap(row.env),
      toolAllowlist: parseJsonArray(row.toolAllowlist),
      usageHint: row.usageHint,
    };
  }
  if (!row.url || !isAbsoluteHttpUrl(row.url)) {
    console.warn(
      `[mcp-servers] skipping ${context} "${row.name}": http server without a valid url`
    );
    return null;
  }
  return {
    name: row.name,
    url: row.url,
    headers: parseSecretMap(row.headers),
    toolAllowlist: parseJsonArray(row.toolAllowlist),
    usageHint: row.usageHint,
  };
}

export interface ResolvedExtraMcpServers {
  /** Extra servers to inject, in order: globals then project (shadowed globals dropped). */
  servers: Array<McpServerSpec & { usageHint: string | null }>;
  /**
   * Names of eligible PROJECT-scoped servers the provider could not honor
   * (user-global scope). Traced, never silent — the UI shows the same fact.
   */
  excludedProjectScoped: string[];
}

/**
 * Resolves the extra (non-arij) MCP servers for one session.
 *
 * Order: globals (name-ascending) then the project's own (name-ascending);
 * a project entry shadows a global of the same name. Filters: `enabled`,
 * `agent_types` (NULL = all), and the provider's extra-MCP scope —
 * `per-spawn` providers (claude-code, codex) get global + project, while
 * `user-global` providers (oh-my-pi, agy) get globals only, with the
 * dropped project names reported in `excludedProjectScoped`.
 *
 * Defensive by construction: a corrupt row is skipped with a warning,
 * never thrown — a session must never lose the arij channel (or fail to
 * spawn) because of a malformed extra server.
 */
export function resolveExtraMcpServers(opts: {
  projectId: string;
  provider: string;
  /** The session's agent type; "chat" for CLI chat turns. */
  agentType: string | null;
  database?: ArijDatabase;
}): ResolvedExtraMcpServers {
  const database = opts.database ?? db;
  const globals = rowsForScope(database, null)
    .filter(
      (row) =>
        row.enabled && agentTypesInclude(row.agentTypes, opts.agentType)
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  // Agent-type eligibility, but NOT `enabled`: a DISABLED project row is how
  // "turn this inherited global off for this project" is expressed
  // (disableGlobalForProject), so it has to survive long enough to shadow the
  // global. Filtering it here would make that feature a no-op.
  const projectApplicable = rowsForScope(database, opts.projectId)
    .filter((row) => agentTypesInclude(row.agentTypes, opts.agentType))
    .sort((a, b) => a.name.localeCompare(b.name));
  const project = projectApplicable.filter((row) => row.enabled);

  // A "user-global" provider (omp, agy) has no per-spawn surface to vary, so
  // only the globals reach it; the project's own are reported as excluded so
  // the limitation is traced rather than inferred.
  const scope = extraMcpScopeForProvider(opts.provider);
  const perSpawn = scope === "per-spawn";
  const eligibleProject = perSpawn ? project : [];
  const excludedProjectScoped = perSpawn ? [] : project.map((row) => row.name);

  // A project entry SHADOWS a global of the same name — drop the global, keep
  // the project row (or nothing at all, when the project row is disabled).
  // `shadowed` is empty on a user-global provider, where a project row cannot
  // reach the CLI at all and so must not suppress a global that can.
  const shadowed = new Set(
    perSpawn ? projectApplicable.map((row) => row.name) : []
  );
  const servers: ResolvedExtraMcpServers["servers"] = [];
  for (const row of globals) {
    if (shadowed.has(row.name)) continue;
    const spec = rowToSpec(row, "global server");
    if (spec) servers.push(spec);
  }
  for (const row of eligibleProject) {
    const spec = rowToSpec(row, "project server");
    if (spec) servers.push(spec);
  }

  return { servers, excludedProjectScoped };
}

/**
 * What the project settings screen needs in one read: the project's OWN
 * servers, plus the global servers it inherits, plus the providers that will
 * ignore a project-scoped entry.
 *
 * A global whose name is also taken by a project row is marked `shadowed` —
 * the project entry wins at resolution time, so showing the global as active
 * would be a lie. Disabling a global for one project is exactly that: a
 * project row of the same name with `enabled: false`
 * (disableGlobalForProject).
 */
export interface ProjectMcpServersView {
  /** The project's own entries (editable here). */
  servers: McpServerView[];
  /** Global entries, read-only in this scope. */
  inherited: Array<McpServerView & { shadowed: boolean }>;
  /** Providers whose CLI cannot honor a project-scoped server at all. */
  unsupportedProviders: string[];
}

export function describeProjectMcpServers(
  projectId: string,
  database: ArijDatabase = db
): ProjectMcpServersView {
  const servers = listMcpServers(database, projectId);
  const localNames = new Set(servers.map((server) => server.name));
  const inherited = listMcpServers(database, null).map((server) => ({
    ...server,
    shadowed: localNames.has(server.name),
  }));
  return {
    servers,
    inherited,
    unsupportedProviders: [...USER_GLOBAL_EXTRA_MCP_PROVIDERS],
  };
}

/**
 * The UNMASKED spec for one server, for the connection probe.
 *
 * Deliberately separate from the read path: everything the API returns goes
 * through maskMcpServerSecrets, and this is the one server-side caller that
 * needs the real values. Returns undefined when the id is not in the scope,
 * and null when the row is too malformed to launch (which the probe reports
 * as a failed check rather than crashing).
 */
export function mcpServerSpecById(
  serverId: string,
  database: ArijDatabase = db,
  projectId: string | null = null
): (McpServerSpec & { usageHint: string | null }) | null | undefined {
  const row = rowForId(database, projectId, serverId);
  if (!row) return undefined;
  return rowToSpec(row, "probed server");
}
