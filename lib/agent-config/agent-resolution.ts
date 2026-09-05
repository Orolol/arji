import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProviderDefaults, namedAgents } from "@/lib/db/schema";
import {
  AGENT_TYPES,
  FALLBACK_PROVIDER,
  isAgentProvider,
  type AgentProvider,
  type AgentType,
} from "./constants";
import {
  parseStoredProviderOptions,
  type NamedAgentCliOptions,
} from "@/lib/providers/options-registry";

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

/** Name of the seeded global default agent (inserted by lib/db/index.ts). */
export const GLOBAL_DEFAULT_AGENT_NAME = "Claude Code";

/**
 * Historical defaults for lightweight direct tasks. These two call sites
 * predate named-agent assignments and deliberately did not use the seeded
 * (Opus) named agent: title generation pinned Haiku, while repository import
 * let the Claude CLI choose its own default model. Keeping those defaults in
 * the resolver makes the new mapping opt-in instead of silently making
 * unconfigured background work more expensive.
 */
const BUILTIN_TASK_DEFAULTS: Partial<Record<AgentType, ResolvedAgent>> = {
  title_generation: {
    provider: FALLBACK_PROVIDER,
    model: "haiku",
    namedAgentId: null,
  },
  import_analysis: {
    provider: FALLBACK_PROVIDER,
    namedAgentId: null,
  },
};

/** Maps a stored provider column to a known provider, or the fallback. */
function normalizeProvider(value: string | null | undefined): AgentProvider {
  return value && isAgentProvider(value) ? value : FALLBACK_PROVIDER;
}

interface ProviderDefaultRow {
  agentType: string;
  provider: string;
  scope: string;
  namedAgentId: string | null;
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
    const namedAgent = row?.namedAgentId
      ? namedAgentMap.get(row.namedAgentId) ?? null
      : null;
    if (row && namedAgent) {
      return {
        agentType,
        provider: namedAgent.provider,
        source: "global" as const,
        scope: "global",
        namedAgentId: namedAgent.id,
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
    const projectAgent = projectRow?.namedAgentId
      ? namedAgentMap.get(projectRow.namedAgentId) ?? null
      : null;
    if (projectRow && projectAgent) {
      return {
        agentType,
        provider: projectAgent.provider,
        source: "project" as const,
        scope: projectId,
        namedAgentId: projectAgent.id,
        namedAgent: projectAgent,
      };
    }

    const globalRow = globalByType.get(agentType);
    const globalAgent = globalRow?.namedAgentId
      ? namedAgentMap.get(globalRow.namedAgentId) ?? null
      : null;
    if (globalRow && globalAgent) {
      return {
        agentType,
        provider: globalAgent.provider,
        source: "global" as const,
        scope: "global",
        namedAgentId: globalAgent.id,
        namedAgent: globalAgent,
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
  /**
   * Per-CLI options of the resolved named agent (see
   * lib/providers/options-registry.ts). Populated for callers that spawn
   * WITHOUT an agent_sessions row — CLI chat turns — because those bypass
   * processManager.start(), which is where every ticketed session picks its
   * options up from the row instead.
   */
  cliOptions?: NamedAgentCliOptions;
  /**
   * True when review-provider segregation redirected the resolution away
   * from the provider that built the target.
   */
  segregated?: boolean;
  /**
   * Provider of the target's last successful build. Present whenever
   * segregation was evaluated (even when no redirect happened).
   */
  builderProvider?: AgentProvider;
}

/**
 * Dispatch context for {@link resolveAgentForDispatch}. Review and grading
 * dispatches pass this; build routes are unaffected.
 */
export interface AgentResolutionContext {
  purpose: "review" | "grading";
  projectId: string;
  epicId?: string;
  storyId?: string;
}

/**
 * Resolves the named agent for a given task type by looking up saved role
 * assignments (project → global → builtin).
 *
 * When a namedAgentId is set, returns the named agent's provider, model, and name.
 * Legacy rows that only contain a raw provider are deliberately ignored: CLIs
 * own their provider configuration, and there is no longer a provider-default
 * setting in Arij's agent UI.
 */
export function resolveAgent(
  agentType: AgentType,
  projectId?: string,
): ResolvedAgent {
  const assigned = resolveAssignedAgent(agentType, projectId);
  if (assigned) return assigned;

  // Preserve task-specific historical defaults before consulting the seeded
  // catch-all agent. Assignments above still override these at project/global
  // scope, and an explicit dispatch choice is handled by
  // resolveAgentByNamedId before reaching this function.
  const taskDefault = BUILTIN_TASK_DEFAULTS[agentType];
  if (taskDefault) {
    return { ...taskDefault };
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
      cliOptions: parseStoredProviderOptions(
        defaultAgent.provider,
        defaultAgent.options,
      ),
    };
  }

  return { provider: FALLBACK_PROVIDER, namedAgentId: null };
}

/**
 * The user's role ASSIGNMENT for `agentType` — project scope, then global —
 * and nothing below it. `null` means the role was never assigned.
 *
 * `resolveAgent` cannot express that distinction: it folds an unassigned role
 * into the seeded catch-all agent, so its answer is identical whether the user
 * picked that agent deliberately or never picked at all. A caller that applies
 * its own default only in the ABSENCE of a choice has to be able to tell those
 * two apart — `lib/chat/default-chat-mode.ts` is the case that forced this
 * out, since offering a warm CLI must not silently outrank a CHAT & SPEC
 * assignment the user made by hand.
 */
export function resolveAssignedAgent(
  agentType: AgentType,
  projectId?: string,
): ResolvedAgent | null {
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

  return null;
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
        cliOptions: parseStoredProviderOptions(agent.provider, agent.options),
      };
    }
  }

  // Fall through to standard resolution (no provider override)
  return resolveAgent(agentType, projectId);
}

/**
 * Dispatch-time agent resolution with optional purpose context.
 *
 * Precedence (in order):
 *   1. An explicitly picked named agent ALWAYS wins — review-provider
 *      segregation never overrides the user's explicit choice.
 *   2. Standard default resolution (project → global → builtin chain).
 *   3. For review/grading contexts, when the global
 *      `review_provider_segregation` setting is enabled and the default
 *      resolution lands on the same provider that produced the target's
 *      last successful build (agentType build/ticket_build), the provider
 *      is redirected to the first available alternative in stable
 *      PROVIDER_OPTIONS order. When no alternative CLI is installed, the
 *      default resolution is returned unchanged.
 *
 * The result carries `segregated: true` plus `builderProvider` when a
 * redirect happened so routes/UI can surface the choice.
 */
export async function resolveAgentForDispatch(
  agentType: AgentType,
  projectId?: string,
  namedAgentId?: string | null,
  context?: AgentResolutionContext
): Promise<ResolvedAgent> {
  // 1. Explicit named-agent override — never segregated.
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
        cliOptions: parseStoredProviderOptions(agent.provider, agent.options),
      };
    }
  }

  // 2. Default resolution chain.
  const base = resolveAgent(agentType, projectId);

  if (
    !context ||
    (context.purpose !== "review" && context.purpose !== "grading")
  ) {
    return base;
  }

  // 3. Review-provider segregation.
  const {
    isReviewProviderSegregationEnabled,
    findLastSuccessfulBuildProvider,
    pickAlternativeReviewProvider,
  } = await import("./review-segregation");

  if (!isReviewProviderSegregationEnabled()) {
    return base;
  }

  const builderProvider = findLastSuccessfulBuildProvider({
    projectId: context.projectId,
    epicId: context.epicId,
    storyId: context.storyId,
  });

  if (!builderProvider) {
    return base;
  }

  if (base.provider !== builderProvider) {
    // Default resolution already differs from the builder — no redirect.
    return { ...base, builderProvider };
  }

  const alternative = await pickAlternativeReviewProvider(builderProvider);
  if (!alternative) {
    // No alternative CLI installed — fall back to the default resolution.
    return { ...base, builderProvider };
  }

  return {
    provider: alternative,
    namedAgentId: null,
    segregated: true,
    builderProvider,
  };
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
        cliOptions: parseStoredProviderOptions(agent.provider, agent.options),
      };
    }
  }

  // A legacy CLI-only default (or a deleted agent) is not an assignment.
  // Continue through the global/builtin chain instead of invisibly pinning a
  // role to configuration the user can no longer see or edit.
  return null;
}
