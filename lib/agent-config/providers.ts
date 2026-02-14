import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProviderDefaults, namedAgents } from "@/lib/db/schema";
import { AGENT_TYPES, type AgentProvider, type AgentType } from "./constants";

export type ProviderSource = "builtin" | "global" | "project";
export type AgentResolveSource = ProviderSource | "override";

export interface NamedAgentLite {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
}

export interface ResolvedAgentProvider {
  agentType: AgentType;
  provider: AgentProvider;
  source: ProviderSource;
  scope: string;
  namedAgentId: string | null;
  namedAgent?: NamedAgentLite | null;
}

export interface ResolvedAgentConfig {
  agentType: AgentType;
  provider: AgentProvider;
  model?: string;
  source: AgentResolveSource;
  scope: string;
  namedAgentId: string | null;
}

const FALLBACK_PROVIDER: AgentProvider = "claude-code";

/** Name of the seeded global default agent (inserted by lib/db/index.ts). */
export const GLOBAL_DEFAULT_AGENT_NAME = "Claude Code";

function normalizeProvider(value: string | null | undefined): AgentProvider {
  if (value === "codex") return "codex";
  if (value === "gemini-cli") return "gemini-cli";
  return "claude-code";
}

interface ProviderDefaultRow {
  agentType: string;
  provider: string;
  scope: string;
  namedAgentId: string | null;
}

function findScopedDefault(
  agentType: AgentType,
  scope: string
): ProviderDefaultRow | null {
  return (
    db
      .select({
        agentType: agentProviderDefaults.agentType,
        provider: agentProviderDefaults.provider,
        scope: agentProviderDefaults.scope,
        namedAgentId: agentProviderDefaults.namedAgentId,
      })
      .from(agentProviderDefaults)
      .where(
        and(
          eq(agentProviderDefaults.agentType, agentType),
          eq(agentProviderDefaults.scope, scope)
        )
      )
      .get() ?? null
  );
}

function resolveDefaultRow(
  agentType: AgentType,
  projectId?: string
): { row: ProviderDefaultRow | null; source: ProviderSource; scope: string } {
  if (projectId) {
    const projectRow = findScopedDefault(agentType, projectId);
    if (projectRow) {
      return { row: projectRow, source: "project", scope: projectId };
    }
  }

  const globalRow = findScopedDefault(agentType, "global");
  if (globalRow) {
    return { row: globalRow, source: "global", scope: "global" };
  }

  return {
    row: null,
    source: "builtin",
    scope: "global",
  };
}

function mapNamedAgentsById(namedAgentIds: Array<string | null | undefined>): Map<string, NamedAgentLite> {
  const uniqueIds = Array.from(
    new Set(
      namedAgentIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const idSet = new Set(uniqueIds);

  const rows = db
    .select({
      id: namedAgents.id,
      name: namedAgents.name,
      provider: namedAgents.provider,
      model: namedAgents.model,
    })
    .from(namedAgents)
    .all()
    .filter((row) => idSet.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      provider: normalizeProvider(row.provider),
      model: row.model,
    }));

  const byId = new Map<string, NamedAgentLite>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return byId;
}

export function resolveAgentProvider(
  agentType: AgentType,
  projectId?: string
): AgentProvider {
  const resolved = resolveAgent(agentType, projectId);
  return resolved.provider;
}

function mapProviderRowsByType(
  rows: ProviderDefaultRow[]
): Map<string, ProviderDefaultRow> {
  const map = new Map<string, ProviderDefaultRow>();
  for (const row of rows) {
    map.set(row.agentType, row);
  }
  return map;
}

export async function listGlobalAgentProviders(): Promise<ResolvedAgentProvider[]> {
  const rows = db
    .select({
      agentType: agentProviderDefaults.agentType,
      provider: agentProviderDefaults.provider,
      scope: agentProviderDefaults.scope,
      namedAgentId: agentProviderDefaults.namedAgentId,
    })
    .from(agentProviderDefaults)
    .where(eq(agentProviderDefaults.scope, "global"))
    .all();

  const providersByType = mapProviderRowsByType(rows);
  const namedAgentMap = mapNamedAgentsById(rows.map((row) => row.namedAgentId));

  return AGENT_TYPES.map((agentType) => {
    const row = providersByType.get(agentType);
    if (row) {
      const namedAgent = row.namedAgentId
        ? namedAgentMap.get(row.namedAgentId) ?? null
        : null;

      return {
        agentType,
        provider: namedAgent?.provider ?? normalizeProvider(row.provider),
        source: "global" as const,
        scope: "global",
        namedAgentId: row.namedAgentId ?? null,
        namedAgent,
      };
    }

    return {
      agentType,
      provider: FALLBACK_PROVIDER,
      source: "builtin" as const,
      scope: "global",
      namedAgentId: null,
      namedAgent: null,
    };
  });
}

export async function listMergedProjectAgentProviders(
  projectId: string
): Promise<ResolvedAgentProvider[]> {
  const globalRows = db
    .select({
      agentType: agentProviderDefaults.agentType,
      provider: agentProviderDefaults.provider,
      scope: agentProviderDefaults.scope,
      namedAgentId: agentProviderDefaults.namedAgentId,
    })
    .from(agentProviderDefaults)
    .where(eq(agentProviderDefaults.scope, "global"))
    .all();

  const projectRows = db
    .select({
      agentType: agentProviderDefaults.agentType,
      provider: agentProviderDefaults.provider,
      scope: agentProviderDefaults.scope,
      namedAgentId: agentProviderDefaults.namedAgentId,
    })
    .from(agentProviderDefaults)
    .where(eq(agentProviderDefaults.scope, projectId))
    .all();

  const globalByType = mapProviderRowsByType(globalRows);
  const projectByType = mapProviderRowsByType(projectRows);
  const namedAgentMap = mapNamedAgentsById([
    ...globalRows.map((row) => row.namedAgentId),
    ...projectRows.map((row) => row.namedAgentId),
  ]);

  return AGENT_TYPES.map((agentType) => {
    const projectRow = projectByType.get(agentType);
    if (projectRow) {
      const namedAgent = projectRow.namedAgentId
        ? namedAgentMap.get(projectRow.namedAgentId) ?? null
        : null;

      return {
        agentType,
        provider: namedAgent?.provider ?? normalizeProvider(projectRow.provider),
        source: "project" as const,
        scope: projectId,
        namedAgentId: projectRow.namedAgentId ?? null,
        namedAgent,
      };
    }

    const globalRow = globalByType.get(agentType);
    if (globalRow) {
      const namedAgent = globalRow.namedAgentId
        ? namedAgentMap.get(globalRow.namedAgentId) ?? null
        : null;

      return {
        agentType,
        provider: namedAgent?.provider ?? normalizeProvider(globalRow.provider),
        source: "global" as const,
        scope: "global",
        namedAgentId: globalRow.namedAgentId ?? null,
        namedAgent,
      };
    }

    return {
      agentType,
      provider: FALLBACK_PROVIDER,
      source: "builtin" as const,
      scope: "global",
      namedAgentId: null,
      namedAgent: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Named Agent Resolution
// ---------------------------------------------------------------------------

export interface ResolvedAgent {
  provider: AgentProvider;
  model?: string;
  name?: string;
  namedAgentId?: string | null;
}

/**
 * Resolves the named agent for a given task type by looking up the
 * agentProviderDefaults chain (project → global → builtin).
 *
 * When a namedAgentId is set, returns the named agent's provider, model, and name.
 * When namedAgentId is null, falls back to the raw provider column (no model override).
 */
export function resolveAgent(
  agentType: AgentType,
  projectId?: string,
): ResolvedAgent {
  // Try project-scoped default first
  if (projectId) {
    const row = db
      .select({
        provider: agentProviderDefaults.provider,
        namedAgentId: agentProviderDefaults.namedAgentId,
      })
      .from(agentProviderDefaults)
      .where(
        and(
          eq(agentProviderDefaults.agentType, agentType),
          eq(agentProviderDefaults.scope, projectId)
        )
      )
      .get();

    if (row) {
      const resolved = resolveFromRow(row);
      if (resolved) return resolved;
    }
  }

  // Try global default
  const globalRow = db
    .select({
      provider: agentProviderDefaults.provider,
      namedAgentId: agentProviderDefaults.namedAgentId,
    })
    .from(agentProviderDefaults)
    .where(
      and(
        eq(agentProviderDefaults.agentType, agentType),
        eq(agentProviderDefaults.scope, "global")
      )
    )
    .get();

  if (globalRow) {
    const resolved = resolveFromRow(globalRow);
    if (resolved) return resolved;
  }

  // Builtin fallback — resolve via global default named agent
  const defaultAgent = db
    .select()
    .from(namedAgents)
    .where(eq(namedAgents.name, GLOBAL_DEFAULT_AGENT_NAME))
    .get();

  if (defaultAgent) {
    return {
      provider: normalizeProvider(defaultAgent.provider),
      model: defaultAgent.model,
      name: defaultAgent.name,
      namedAgentId: defaultAgent.id,
    };
  }

  return { provider: FALLBACK_PROVIDER, namedAgentId: null };
}

/**
 * Resolves agent config from a named agent ID.
 * If namedAgentId is provided and valid, returns its provider/model.
 * Otherwise falls through to the standard resolveAgent chain.
 */
export function resolveAgentByNamedId(
  agentType: AgentType,
  projectId?: string,
  namedAgentId?: string | null,
): ResolvedAgent {
  if (namedAgentId) {
    const agent = db
      .select()
      .from(namedAgents)
      .where(eq(namedAgents.id, namedAgentId))
      .get();

    if (agent) {
      return {
        provider: normalizeProvider(agent.provider),
        model: agent.model,
        name: agent.name,
        namedAgentId: agent.id,
      };
    }
  }

  // Fall through to standard resolution (no provider override)
  return resolveAgent(agentType, projectId);
}

function resolveFromRow(row: {
  provider: string;
  namedAgentId: string | null;
}): ResolvedAgent | null {
  if (row.namedAgentId) {
    const agent = db
      .select()
      .from(namedAgents)
      .where(eq(namedAgents.id, row.namedAgentId))
      .get();

    if (agent) {
      return {
        provider: normalizeProvider(agent.provider),
        model: agent.model,
        name: agent.name,
        namedAgentId: agent.id,
      };
    }
  }

  // namedAgentId is null or agent was deleted — use raw provider
  return {
    provider: normalizeProvider(row.provider),
    namedAgentId: null,
  };
}
