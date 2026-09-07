import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProviderDefaults, namedAgents } from "@/lib/db/schema";
import {
  AGENT_TYPES,
  COMPOSITE_AGENT_KIND,
  FALLBACK_PROVIDER,
  isAgentProvider,
  type AgentProvider,
  type AgentType,
} from "./constants";
import {
  listCompositeMembers,
  readDefaultCompositeAgentId,
} from "./composite-agents";
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
  /**
   * The COMPOSITE this resolution unfolded, when the id it was given named
   * one. `namedAgentId` above is then the MEMBER that will actually run —
   * the split that keeps reliability statistics measured per real agent
   * (`agent_sessions.composite_agent_id` persists this).
   */
  compositeAgentId?: string | null;
  /** Rank of the unfolded member within its composite; 0-based. */
  compositeRank?: number;
  /** Human name of the unfolded member's composite, for activity traces. */
  compositeName?: string;
}

/**
 * Raised when an id names a composite with no usable member left.
 *
 * A composite is emptied by DELETING its last member — the membership rows
 * cascade — so this is reachable state, not a corrupt database.
 *
 * WHO CATCHES IT decides the behaviour, and the split is deliberate:
 *
 *  - A caller that NAMED this composite for a dispatch (an explicit choice,
 *    a conversation) gets the throw. Falling back to whatever the builtin
 *    chain happens to hold would run the work on an agent the user did not
 *    ask for, which is the "resolve to an arbitrary default" outcome the
 *    story explicitly refuses.
 *  - The BACKGROUND CHAIN — a role assignment, the designated default —
 *    catches it in `resolveNamedAgentIdInChain` and continues to the next
 *    link, exactly as it already does for a deleted agent. Those links end in
 *    a builtin fallback by design, and throwing there would take down every
 *    unassigned resolution in the app.
 */
export class CompositeAgentUnusableError extends Error {
  readonly compositeAgentId: string;
  /** Kept for the chain's fall-through log, which names what it skipped. */
  readonly compositeName: string;

  constructor(compositeAgentId: string, compositeName: string) {
    super(
      `Composite agent "${compositeName}" has no members left; it cannot dispatch anything. Add a member, or pick another agent.`,
    );
    this.name = "CompositeAgentUnusableError";
    this.compositeAgentId = compositeAgentId;
    this.compositeName = compositeName;
  }
}

/** Outcome of unfolding a composite at one rank of the retry ladder. */
export interface CompositeRankResolution {
  /** The member to run, or null when the rank is past the last member. */
  resolved: ResolvedAgent | null;
  /** How many members the composite has; the stage's attempt budget. */
  memberCount: number;
  /** True when `rank` is past the end — the list is spent, not broken. */
  exhausted: boolean;
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

/* ------------------------------------------------------------------ */
/* Composite unfolding                                                 */
/* ------------------------------------------------------------------ */

interface NamedAgentRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  options: string;
  kind: string;
}

function readNamedAgentRow(agentId: string): NamedAgentRow | null {
  return (
    db
      .select({
        id: namedAgents.id,
        name: namedAgents.name,
        provider: namedAgents.provider,
        model: namedAgents.model,
        options: namedAgents.options,
        kind: namedAgents.kind,
      })
      .from(namedAgents)
      .where(eq(namedAgents.id, agentId))
      .get() ?? null
  );
}

/** A simple agent row as the dispatch layer wants it. */
function toResolvedAgent(row: NamedAgentRow): ResolvedAgent {
  return {
    provider: normalizeProvider(row.provider),
    model: row.model,
    name: row.name,
    namedAgentId: row.id,
    cliOptions: parseStoredProviderOptions(row.provider, row.options),
  };
}

/**
 * Unfolds a composite to the member at `rank`, or reports the list spent.
 *
 * This is the whole of the fallback mechanism: rank 0 is the first member,
 * and each failed attempt asks for the next rank. The member count IS the
 * attempt budget, which is why `memberCount` travels with every answer —
 * `pipeline_max_attempts` no longer governs an agent switch.
 *
 * An EMPTY composite throws rather than returning `exhausted`. The two states
 * are different questions: "the ladder is spent" is a normal end to a run,
 * while "this agent can never run anything" is a misconfiguration that must
 * not be mistaken for one.
 */
export function resolveCompositeMemberAtRank(
  compositeId: string,
  rank: number,
): CompositeRankResolution {
  const row = readNamedAgentRow(compositeId);
  if (!row || row.kind !== COMPOSITE_AGENT_KIND) {
    throw new Error(`Not a composite agent: ${compositeId}`);
  }

  const members = listCompositeMembers(compositeId);
  if (members.length === 0) {
    throw new CompositeAgentUnusableError(compositeId, row.name);
  }

  if (rank < 0 || rank >= members.length) {
    return { resolved: null, memberCount: members.length, exhausted: true };
  }

  const member = members[rank];
  const memberRow = readNamedAgentRow(member.id);
  // The membership row cascades with its agent, so a missing row here means a
  // database edited outside Arij; degrade to the joined columns rather than
  // pretending the rank does not exist.
  const resolved: ResolvedAgent = memberRow
    ? toResolvedAgent(memberRow)
    : {
        provider: member.provider,
        model: member.model,
        name: member.name,
        namedAgentId: member.id,
      };

  return {
    resolved: {
      ...resolved,
      compositeAgentId: compositeId,
      compositeRank: rank,
      compositeName: row.name,
    },
    memberCount: members.length,
    exhausted: false,
  };
}

/** Member count of a composite, or null when `agentId` is not one. */
export function readCompositeMemberCount(
  agentId: string | null | undefined,
): number | null {
  if (!agentId) return null;
  const row = readNamedAgentRow(agentId);
  if (!row || row.kind !== COMPOSITE_AGENT_KIND) return null;
  return listCompositeMembers(agentId).length;
}

/**
 * Resolves one named-agent id, unfolding a composite to its first member.
 *
 * Every caller that holds an id — an explicit dispatch choice, a role
 * assignment, a conversation, the builtin fallback — goes through here, which
 * is what makes a composite assignable everywhere without a single call site
 * learning that composites exist.
 */
function resolveNamedAgentId(agentId: string): ResolvedAgent | null {
  const row = readNamedAgentRow(agentId);
  if (!row) return null;
  if (row.kind === COMPOSITE_AGENT_KIND) {
    // rank 0 — the first member of the list. Throws when the composite was
    // emptied by member deletion (see CompositeAgentUnusableError).
    return resolveCompositeMemberAtRank(agentId, 0).resolved;
  }
  return toResolvedAgent(row);
}

/**
 * `resolveNamedAgentId` for the RESOLUTION CHAIN, where an unusable composite
 * must not be fatal.
 *
 * The difference is who chose the agent. When a caller NAMES a composite for
 * a dispatch, an emptied one is a refusal it has to hear — resolving to some
 * arbitrary other agent would run the work on something the user did not ask
 * for. But a role assignment and the designated default are *background*
 * links in a chain that already ends in a built-in fallback: the user set
 * them once and then deleted a simple agent from the roster, which cascades
 * `composite_agent_members` and can empty the list with no warning anywhere.
 * Throwing there takes down every unassigned resolution in the app — build
 * routes (a 500, not a typed 4xx), the chat stream, night runs, Full Auto and
 * the scheduled routines, none of which catch it.
 *
 * So the chain treats an emptied composite exactly as it already treats a
 * deleted agent: not an assignment, continue to the next link. The trace goes
 * to the server log, because a silent skip here would be the "resolved
 * configuration is invisible" trap.
 */
function resolveNamedAgentIdInChain(
  agentId: string,
  where: string
): ResolvedAgent | null {
  try {
    return resolveNamedAgentId(agentId);
  } catch (error) {
    if (error instanceof CompositeAgentUnusableError) {
      console.warn(
        `[agent-config] ${where} points at composite "${error.compositeName}" ` +
          `(${error.compositeAgentId}), which has no members left; falling through ` +
          `to the next link of the resolution chain.`
      );
      return null;
    }
    throw error;
  }
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

  // Builtin fallback. A DESIGNATED DEFAULT COMPOSITE outranks the seeded
  // catch-all agent: "Default agent" in the picker has always meant "the
  // server decides", and this is the user telling the server what to decide.
  // It sits BELOW the historical task defaults above on purpose — routing
  // title generation through a build ladder would make unconfigured
  // background work more expensive, which is exactly what those defaults
  // exist to prevent.
  const defaultCompositeId = readDefaultCompositeAgentId();
  if (defaultCompositeId) {
    const resolved = resolveNamedAgentIdInChain(
      defaultCompositeId,
      "the designated default agent"
    );
    if (resolved) return resolved;
  }

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
    // A composite unfolds to its first member here — the caller neither knows
    // nor needs to know that the id it holds names a list.
    const resolved = resolveNamedAgentId(namedAgentId);
    if (resolved) return resolved;
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
  // 1. Explicit named-agent override — never segregated. A composite unfolds
  //    to its first member, so an explicit composite choice still wins over
  //    reviewer segregation exactly as an explicit simple choice does.
  if (namedAgentId) {
    const resolved = resolveNamedAgentId(namedAgentId);
    if (resolved) return resolved;
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
    // A composite assigned to a role — at global or project scope — unfolds
    // here to its first member, so `agent_provider_defaults` needed no
    // schema change at all to accept one. An EMPTIED one falls through to the
    // next link rather than throwing: same reasoning as the designated
    // default, and the same cascade empties it.
    const resolved = resolveNamedAgentIdInChain(
      row.namedAgentId,
      "a role assignment"
    );
    if (resolved) return resolved;
  }

  // A legacy CLI-only default (or a deleted agent) is not an assignment.
  // Continue through the global/builtin chain instead of invisibly pinning a
  // role to configuration the user can no longer see or edit.
  return null;
}
